import { appendFileSync } from 'node:fs'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { APICallError, streamText, type ModelMessage, type ToolSet } from 'ai'

/** EXELSNAP_DEBUG_LOG=/path/file.jsonl records every request/response exchanged with the model server. */
function debugLog(entry: object) {
  const path = process.env.EXELSNAP_DEBUG_LOG
  if (path) appendFileSync(path, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n')
}

export interface ToolCall {
  id: string
  name: string
  /** Parsed arguments, or the raw string when the model did not send valid JSON. */
  input: unknown
}

export interface StepResult {
  content: string
  toolCalls: ToolCall[]
  finishReason: string | null
}

export interface StepRequest {
  model: string
  instructions: string
  messages: ModelMessage[]
  tools?: ToolSet
  /** 'required' makes the model call a tool instead of answering straight away. */
  toolChoice?: 'auto' | 'required'
  temperature?: number
}

export class ProviderError extends Error {
  constructor(message: string, readonly kind: 'offline' | 'http' | 'aborted' | 'protocol') {
    super(message)
  }
}

/**
 * SAPIENT 0.6.5 corrupts its model state when two generations overlap (replies turn into fragments
 * like "cludes the header row." until the server restarts), so generations are strictly serialized.
 */
const queues = new Map<string, Promise<unknown>>()
function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve()
  const next = prev.catch(() => {}).then(fn)
  queues.set(key, next)
  return next
}

/**
 * The model server, reached through the Vercel AI SDK's OpenAI-compatible provider. SAPIENT today;
 * a bundled sidecar, Ollama, llama.cpp or a cloud model later — the agent only depends on this class.
 */
export class ModelClient {
  private provider

  constructor(readonly baseUrl: string, apiKey = 'sapient') {
    this.provider = createOpenAICompatible({
      name: 'sapient',
      baseURL: baseUrl.replace(/\/+$/, ''),
      apiKey,
      fetch: async (input, init) => {
        if (typeof init?.body === 'string') debugLog({ request: JSON.parse(init.body) })
        return fetch(input, init)
      }
    })
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    let res: Response
    try {
      res = await fetch(this.baseUrl.replace(/\/+$/, '') + '/models', { signal })
    } catch {
      throw new ProviderError(`Can't reach SAPIENT at ${this.baseUrl}`, 'offline')
    }
    if (!res.ok) throw new ProviderError(`SAPIENT returned ${res.status}`, 'http')
    const j = (await res.json()) as { data?: { id: string }[]; resident_models?: string[] }
    return [...new Set([...(j.data ?? []).map((m) => m.id), ...(j.resident_models ?? [])])]
  }

  /** One model turn: text and/or tool calls. Tools are not executed here — the agent loop does that. */
  step(req: StepRequest, opts: { signal?: AbortSignal; onText?: (delta: string) => void }): Promise<StepResult> {
    return serialized(this.baseUrl, () => {
      if (opts.signal?.aborted) throw new ProviderError('Stopped', 'aborted')
      return this.stepNow(req, opts)
    })
  }

  private async stepNow(req: StepRequest, opts: { signal?: AbortSignal; onText?: (delta: string) => void }): Promise<StepResult> {
    const t0 = Date.now()
    let content = ''
    let finishReason: string | null = null
    const toolCalls: ToolCall[] = []
    try {
      const result = streamText({
        model: this.provider(req.model),
        instructions: req.instructions,
        messages: req.messages,
        tools: req.tools,
        toolChoice: req.tools ? req.toolChoice : undefined,
        temperature: req.temperature ?? 0.2,
        abortSignal: opts.signal,
        // A local server either answers or is down; retrying only delays the error.
        maxRetries: 0,
        // Reported through the stream's `error` part below.
        onError: () => {}
      })
      // Note: SAPIENT buffers the whole reply when `tools` are present (it parses tool calls
      // after generation), so expect one big text delta in that case.
      for await (const part of result.stream) {
        if (part.type === 'text-delta') {
          content += part.text
          opts.onText?.(part.text)
        } else if (part.type === 'tool-call') {
          // Arguments that fail the tool's schema still arrive here (flagged invalid); the agent parses them leniently.
          toolCalls.push({ id: part.toolCallId, name: part.toolName, input: part.input })
        } else if (part.type === 'finish-step') {
          finishReason = part.finishReason
        } else if (part.type === 'error') {
          throw part.error
        }
      }
    } catch (err) {
      throw this.wrap(err, opts.signal)
    }
    if (opts.signal?.aborted) throw new ProviderError('Stopped', 'aborted')
    debugLog({ response: { content, toolCalls, finishReason, ms: Date.now() - t0 } })
    return { content, toolCalls, finishReason }
  }

  private wrap(err: unknown, signal?: AbortSignal): ProviderError {
    if (err instanceof ProviderError) return err
    if (signal?.aborted || (err instanceof Error && err.name === 'AbortError')) return new ProviderError('Stopped', 'aborted')
    if (APICallError.isInstance(err)) {
      if (err.statusCode === undefined) return new ProviderError(`Can't reach SAPIENT at ${this.baseUrl}. Is \`sapient serve\` running?`, 'offline')
      let detail = err.responseBody ?? err.message
      try {
        const j = JSON.parse(err.responseBody ?? '')
        detail = j.error?.message ?? j.message ?? detail
      } catch {
        /* plain text */
      }
      return new ProviderError(`SAPIENT returned ${err.statusCode}: ${detail}`.slice(0, 500), 'http')
    }
    return new ProviderError(err instanceof Error ? err.message : String(err), 'protocol')
  }
}

/**
 * Small local models sometimes write the tool call as text instead of using the tool_calls field
 * (Qwen's `<tool_call>{...}</tool_call>`, or a bare JSON object). Recover those.
 */
export function extractTextToolCalls(content: string, toolNames: string[]): { calls: ToolCall[]; text: string } {
  const calls: ToolCall[] = []
  let text = content
  const tryAdd = (raw: string): boolean => {
    try {
      const obj = JSON.parse(raw)
      const name = obj.name ?? obj.function?.name
      const args = obj.arguments ?? obj.parameters ?? obj.function?.arguments ?? {}
      if (typeof name === 'string' && toolNames.includes(name)) {
        calls.push({ id: `call_txt_${Date.now()}_${calls.length}`, name, input: args })
        return true
      }
    } catch {
      // Most often SQL with unescaped double quotes inside the JSON string: {"sql": "SELECT "region" …"}
      const call = lenientToolCall(raw, toolNames)
      if (call) {
        calls.push({ id: `call_txt_${Date.now()}_${calls.length}`, ...call })
        return true
      }
    }
    return false
  }
  text = text.replace(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g, (m, inner) => (tryAdd(inner) ? '' : m))
  text = text.replace(/<\/?tool_call>/g, '') // orphan tags from a half-formed call
  text = text.replace(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/g, (m, inner) => (tryAdd(inner) ? '' : m))
  const bare = text.trim()
  if (calls.length === 0 && bare.startsWith('{') && bare.endsWith('}') && tryAdd(bare)) text = ''
  else if (calls.length === 0) {
    // A JSON tool call on its own line inside prose.
    text = text.replace(/^\s*(\{"name"[\s\S]*?\})\s*$/gm, (m, inner) => (tryAdd(inner) ? '' : m))
  }
  return { calls, text: text.trim() }
}

/** Pull the tool name and arguments out of a tool call whose JSON does not parse. */
function lenientToolCall(raw: string, toolNames: string[]): { name: string; input: Record<string, unknown> } | null {
  const name = /"name"\s*:\s*"([\w-]+)"/.exec(raw)?.[1]
  const start = /"sql"\s*:\s*"/.exec(raw)
  if (!name || !toolNames.includes(name) || !start) return null
  const body = raw.slice(start.index + start[0].length)
  // The SQL ends at the quote before the next known argument, or before the closing braces.
  const end = /"\s*,\s*"(?:type|x|y|title)"\s*:/.exec(body) ?? /"\s*\}[\s}]*$/.exec(body)
  if (!end) return null
  const rest = raw.slice(0, start.index) + body.slice(end.index)
  const str = (key: string) => new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`).exec(rest)?.[1]
  const y = /"y"\s*:\s*\[([^\]]*)\]/.exec(rest)?.[1]
  const input: Record<string, unknown> = { sql: body.slice(0, end.index).replace(/\\n/g, '\n').replace(/\\"/g, '"') }
  for (const key of ['type', 'x', 'title']) if (str(key)) input[key] = str(key)
  if (y) input.y = [...y.matchAll(/"([^"]*)"/g)].map((m) => m[1])
  else if (str('y')) input.y = [str('y')]
  return { name, input }
}
