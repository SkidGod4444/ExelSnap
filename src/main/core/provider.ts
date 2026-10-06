import { appendFileSync } from 'node:fs'
import type { LlmMessage } from '@shared/types'

/** EXELSNAP_DEBUG_LOG=/path/file.jsonl records every request/response exchanged with the model server. */
function debugLog(entry: unknown) {
  const path = process.env.EXELSNAP_DEBUG_LOG
  if (path) appendFileSync(path, JSON.stringify({ at: new Date().toISOString(), ...(entry as object) }) + '\n')
}

export interface ToolDef {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

export interface ToolCall {
  id: string
  name: string
  arguments: string
}

export interface CompletionResult {
  content: string
  toolCalls: ToolCall[]
  finishReason: string | null
}

export interface ChatRequest {
  model: string
  messages: LlmMessage[]
  tools?: ToolDef[]
  temperature?: number
  maxTokens?: number
}

/**
 * Anything that speaks the OpenAI chat-completions API. SAPIENT today; a bundled sidecar,
 * Ollama, llama.cpp or a cloud model later — the agent only depends on this interface.
 */
export interface ModelProvider {
  readonly baseUrl: string
  listModels(signal?: AbortSignal): Promise<string[]>
  complete(req: ChatRequest, opts: { signal?: AbortSignal; onText?: (delta: string) => void }): Promise<CompletionResult>
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

export class OpenAICompatibleProvider implements ModelProvider {
  constructor(readonly baseUrl: string, private apiKey = 'sapient') {}

  private url(path: string) {
    return this.baseUrl.replace(/\/+$/, '') + path
  }

  private async post(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    let res: Response
    try {
      res = await fetch(this.url(path), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify(body),
        signal
      })
    } catch (err) {
      if (signal?.aborted) throw new ProviderError('Stopped', 'aborted')
      throw new ProviderError(`Can't reach SAPIENT at ${this.baseUrl}. Is \`sapient serve\` running?`, 'offline')
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      let detail = text
      try {
        const j = JSON.parse(text)
        detail = j.error?.message ?? j.message ?? text
      } catch {
        /* plain text */
      }
      throw new ProviderError(`SAPIENT returned ${res.status}: ${detail || res.statusText}`.slice(0, 500), 'http')
    }
    return res
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    let res: Response
    try {
      res = await fetch(this.url('/models'), { signal })
    } catch {
      throw new ProviderError(`Can't reach SAPIENT at ${this.baseUrl}`, 'offline')
    }
    if (!res.ok) throw new ProviderError(`SAPIENT returned ${res.status}`, 'http')
    const j = (await res.json()) as { data?: { id: string }[]; resident_models?: string[] }
    return [...new Set([...(j.data ?? []).map((m) => m.id), ...(j.resident_models ?? [])])]
  }

  complete(req: ChatRequest, opts: { signal?: AbortSignal; onText?: (delta: string) => void }): Promise<CompletionResult> {
    return serialized(this.baseUrl, () => {
      if (opts.signal?.aborted) throw new ProviderError('Stopped', 'aborted')
      return this.completeNow(req, opts)
    })
  }

  private async completeNow(req: ChatRequest, opts: { signal?: AbortSignal; onText?: (delta: string) => void }): Promise<CompletionResult> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
      stream: true,
      temperature: req.temperature ?? 0.2
    }
    if (req.maxTokens) body.max_tokens = req.maxTokens
    if (req.tools?.length) {
      body.tools = req.tools
      body.tool_choice = 'auto'
    }
    debugLog({ request: body })
    const t0 = Date.now()
    const res = await this.post('/chat/completions', body, opts.signal)
    const type = res.headers.get('content-type') ?? ''

    // Non-streaming fallback (some servers ignore stream=true).
    if (!type.includes('text/event-stream')) {
      const j = (await res.json()) as any
      const msg = j.choices?.[0]?.message ?? {}
      const content: string = msg.content ?? ''
      if (content) opts.onText?.(content)
      return {
        content,
        toolCalls: (msg.tool_calls ?? []).map((t: any, i: number) => ({
          id: t.id ?? `call_${i}`,
          name: t.function?.name ?? '',
          arguments: normalizeArgs(t.function?.arguments)
        })),
        finishReason: j.choices?.[0]?.finish_reason ?? null
      }
    }

    // SSE. Note: SAPIENT buffers the whole reply when `tools` are present (it parses tool calls
    // after generation), so expect one big content delta in that case.
    const calls = new Map<number, ToolCall>()
    let content = ''
    let finishReason: string | null = null
    const decoder = new TextDecoder()
    let buffer = ''
    const reader = res.body!.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let nl: number
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim()
          buffer = buffer.slice(nl + 1)
          if (!line.startsWith('data:')) continue
          const data = line.slice(5).trim()
          if (data === '[DONE]') continue
          let chunk: any
          try {
            chunk = JSON.parse(data)
          } catch {
            continue
          }
          if (chunk.error) throw new ProviderError(String(chunk.error.message ?? chunk.error), 'protocol')
          const choice = chunk.choices?.[0]
          if (!choice) continue
          const delta = choice.delta ?? {}
          if (typeof delta.content === 'string' && delta.content) {
            content += delta.content
            opts.onText?.(delta.content)
          }
          for (const [pos, tc] of ((delta.tool_calls ?? []) as any[]).entries()) {
            const index = typeof tc.index === 'number' ? tc.index : pos
            const prev = calls.get(index) ?? { id: '', name: '', arguments: '' }
            if (tc.id) prev.id = tc.id
            if (tc.function?.name) prev.name += tc.function.name
            if (tc.function?.arguments != null) prev.arguments += normalizeArgs(tc.function.arguments)
            calls.set(index, prev)
          }
          if (choice.finish_reason) finishReason = choice.finish_reason
        }
      }
    } catch (err) {
      if (opts.signal?.aborted) throw new ProviderError('Stopped', 'aborted')
      throw err
    }

    const toolCalls = [...calls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([i, c]) => ({ ...c, id: c.id || `call_${Date.now()}_${i}` }))
      .filter((c) => c.name)
    debugLog({ response: { content, toolCalls, finishReason, ms: Date.now() - t0 } })
    return { content, toolCalls, finishReason }
  }
}

function normalizeArgs(a: unknown): string {
  if (a == null) return ''
  return typeof a === 'string' ? a : JSON.stringify(a)
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
        calls.push({ id: `call_txt_${Date.now()}_${calls.length}`, name, arguments: typeof args === 'string' ? args : JSON.stringify(args) })
        return true
      }
    } catch {
      /* not JSON */
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
