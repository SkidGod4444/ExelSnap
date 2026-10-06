import type { LlmMessage } from '@shared/types'
import { extractTextToolCalls, type ModelProvider, type ToolCall } from './provider'
import { TOOL_DEFS, TOOL_NAMES, parseArgs, runTool, systemPrompt, type ToolOutcome } from './tools'
import type { WorkbookSession } from './workbook'

export type AgentEvent =
  | { type: 'step-start' }
  | { type: 'text'; delta: string }
  /** Final text of the current step (tool-call markup removed). Replaces what was streamed. */
  | { type: 'step-text'; text: string }
  | { type: 'tool-start'; id: string; name: string; args: Record<string, unknown> }
  | { type: 'tool-end'; id: string; outcome: ToolOutcome; durationMs: number }

export interface AgentRun {
  provider: ModelProvider
  model: string
  session: WorkbookSession
  history: LlmMessage[]
  userText: string
  temperature?: number
  signal?: AbortSignal
  maxSteps?: number
  /** Receives the messages to append to history as they happen (kept even if the run fails midway). */
  out: LlmMessage[]
  onEvent: (e: AgentEvent) => void
}

const KEEP_FULL = 12 // most recent history messages kept verbatim; older tool output is shortened

function compactHistory(history: LlmMessage[]): LlmMessage[] {
  const cut = history.length - KEEP_FULL
  return history.map((m, i) =>
    i < cut && m.role === 'tool' && (m.content?.length ?? 0) > 600 ? { ...m, content: m.content!.slice(0, 600) + '\n…(truncated)' } : m
  )
}

/** A lone ```sql block in a reply without tool calls: small models often "show" the query instead of calling the tool. */
function sqlBlockCall(content: string): { call: ToolCall; text: string } | null {
  const blocks = [...content.matchAll(/```(?:sql|duckdb)\s*([\s\S]*?)```/gi)]
  if (blocks.length !== 1) return null
  const sql = blocks[0][1].trim()
  if (!/^(select|with|from)\b/i.test(sql)) return null
  return {
    call: { id: `call_sql_${Date.now()}`, name: 'run_sql', arguments: JSON.stringify({ sql }) },
    text: content.replace(blocks[0][0], '').trim()
  }
}

/**
 * Tool loop: model → tool calls → local execution → results back to the model, until it answers
 * in plain text. New history messages are pushed into `run.out`.
 */
export async function runAgent(run: AgentRun): Promise<void> {
  const { provider, model, session, onEvent, signal } = run
  const maxSteps = run.maxSteps ?? 6
  const added = run.out
  added.push({ role: 'user', content: run.userText })
  let toolsUsed = 0
  let consecutiveErrors = 0
  let emptyRetries = 0
  let repeats = 0
  const seen = new Set<string>()
  let nudge = false

  for (let step = 0; step <= maxSteps; step++) {
    if (signal?.aborted) break
    const lastStep = step === maxSteps || consecutiveErrors >= 3 || repeats >= 2
    const messages: LlmMessage[] = [
      { role: 'system', content: systemPrompt(session.tables) },
      ...compactHistory(run.history),
      ...added
    ]
    if (nudge) {
      nudge = false
      messages.push({ role: 'user', content: 'Please answer my question. Call run_sql to get the numbers you need.' })
    }
    if (lastStep) {
      messages.push({ role: 'user', content: 'Stop calling tools now. Answer with what you have found so far, and say what you could not determine.' })
    }

    onEvent({ type: 'step-start' })
    const res = await provider.complete(
      { model, messages, tools: lastStep ? undefined : TOOL_DEFS, temperature: run.temperature },
      { signal, onText: (delta) => onEvent({ type: 'text', delta }) }
    )

    let calls = res.toolCalls
    let text = res.content
    if (lastStep) {
      // No tools on the final step: never show half-formed tool-call JSON as the answer.
      const stripped = extractTextToolCalls(text, TOOL_NAMES)
      if (stripped.calls.length) text = stripped.text
      if (!text.trim()) {
        text = toolsUsed
          ? `I ran ${toolsUsed} quer${toolsUsed === 1 ? 'y' : 'ies'} (results above) but couldn't put together a final answer. Try rephrasing the question, or switch to a larger model.`
          : "I couldn't work out how to answer that. Try rephrasing the question, or switch to a larger model."
      }
    } else if (calls.length === 0) {
      const recovered = extractTextToolCalls(text, TOOL_NAMES)
      if (recovered.calls.length) {
        calls = recovered.calls
        text = recovered.text
      } else if (toolsUsed === 0 && session.tables.length > 0) {
        const sql = sqlBlockCall(text)
        if (sql) {
          calls = [sql.call]
          text = sql.text
        }
      }
    }
    text = text.trim()
    onEvent({ type: 'step-text', text })

    if (calls.length === 0) {
      if (!text) {
        // Small models occasionally emit EOS straight away. Nudge once, then give up loudly.
        if (emptyRetries++ < 1 && !lastStep) {
          nudge = true
          continue
        }
        throw new Error('The model returned an empty reply. Try again, or switch to a larger model (7B) in the model menu.')
      }
      added.push({ role: 'assistant', content: text })
      return
    }

    added.push({
      role: 'assistant',
      content: text || null,
      tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } }))
    })

    for (const call of calls) {
      if (signal?.aborted) {
        // Every tool call needs a result message, or the next request is malformed.
        added.push({ role: 'tool', tool_call_id: call.id, content: '(Skipped: stopped by the user.)' })
        continue
      }
      const args = parseArgs(call.name, call.arguments)
      const key = `${call.name}:${String(args.sql ?? '').replace(/\s+/g, ' ').trim().toLowerCase()}`
      if (seen.has(key)) {
        // Small models loop on the same query; tell them to move on instead of re-running it.
        added.push({ role: 'tool', tool_call_id: call.id, content: 'You already ran exactly this query and have its result above. Do not repeat it — answer the user now.' })
        repeats++
        continue
      }
      seen.add(key)
      onEvent({ type: 'tool-start', id: call.id, name: call.name, args })
      const t0 = Date.now()
      const outcome = await runTool(session, call.name, args)
      onEvent({ type: 'tool-end', id: call.id, outcome, durationMs: Date.now() - t0 })
      added.push({ role: 'tool', tool_call_id: call.id, content: outcome.forModel })
      toolsUsed++
      consecutiveErrors = outcome.error ? consecutiveErrors + 1 : 0
    }
  }
}
