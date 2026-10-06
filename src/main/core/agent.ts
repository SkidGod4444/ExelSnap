import type { ModelMessage, ToolModelMessage } from 'ai'
import { log } from './log'
import { extractTextToolCalls, type ModelClient, type ToolCall } from './model'
import { TOOLS, TOOL_NAMES, parseArgs, runTool, systemPrompt, type ToolOutcome } from './tools'
import type { WorkbookSession } from './workbook'

export type AgentEvent =
  | { type: 'step-start' }
  | { type: 'text'; delta: string }
  /** Final text of the current step (tool-call markup removed). Replaces what was streamed. */
  | { type: 'step-text'; text: string }
  | { type: 'tool-start'; id: string; name: string; args: Record<string, unknown> }
  | { type: 'tool-end'; id: string; outcome: ToolOutcome; durationMs: number }

export interface AgentRun {
  provider: ModelClient
  model: string
  session: WorkbookSession
  history: ModelMessage[]
  userText: string
  /** The user's own words, without the note about attached files (used to recognise small talk). */
  question?: string
  temperature?: number
  signal?: AbortSignal
  maxSteps?: number
  /** Receives the messages to append to history as they happen (kept even if the run fails midway). */
  out: ModelMessage[]
  onEvent: (e: AgentEvent) => void
}

/** Messages that need no data: forcing a query for "thanks" would only produce a pointless one. */
const SMALL_TALK = /^\s*(hi+|hey+|hello+|yo|thanks?( you)?|thank you|ok(ay)?|cool|great|nice|bye|good (morning|afternoon|evening|night))\b[\s!.?]*$/i

const KEEP_FULL = 12 // most recent history messages kept verbatim; older tool output is shortened

function compactHistory(history: ModelMessage[]): ModelMessage[] {
  const cut = history.length - KEEP_FULL
  return history.map((m, i) => {
    if (i >= cut || m.role !== 'tool') return m
    return {
      ...m,
      content: m.content.map((p) =>
        p.type === 'tool-result' && p.output.type === 'text' && p.output.value.length > 600
          ? { ...p, output: { type: 'text' as const, value: p.output.value.slice(0, 600) + '\n…(truncated)' } }
          : p
      )
    }
  })
}

/** A lone ```sql block in a reply without tool calls: small models often "show" the query instead of calling the tool. */
function sqlBlockCall(content: string): { call: ToolCall; text: string } | null {
  const blocks = [...content.matchAll(/```(?:sql|duckdb)\s*([\s\S]*?)```/gi)]
  if (blocks.length !== 1) return null
  const sql = blocks[0][1].trim()
  if (!/^(select|with|from)\b/i.test(sql)) return null
  return {
    call: { id: `call_sql_${Date.now()}`, name: 'run_sql', input: { sql } },
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
  let groundingRetries = 0
  // With data attached, the first move must be a query: small models otherwise answer from the few
  // example values in the schema ("38 students: " followed by the 5 samples) and never look at the file.
  const mustQuery = session.tables.length > 0 && !SMALL_TALK.test(run.question ?? run.userText)
  let repeats = 0
  const seen = new Set<string>()
  let nudge = false

  for (let step = 0; step <= maxSteps; step++) {
    if (signal?.aborted) break
    const lastStep = step === maxSteps || consecutiveErrors >= 3 || repeats >= 2
    const messages: ModelMessage[] = [...compactHistory(run.history), ...added]
    if (nudge) {
      nudge = false
      messages.push({ role: 'user', content: 'Please answer my question. Call run_sql to get the data you need — do not answer from the example values in the table description.' })
    }
    if (lastStep) {
      messages.push({ role: 'user', content: 'Stop calling tools now. Answer with what you have found so far, and say what you could not determine.' })
    }

    onEvent({ type: 'step-start' })
    const res = await provider.step(
      {
        model,
        instructions: systemPrompt(session.tables),
        messages,
        tools: lastStep ? undefined : TOOLS,
        toolChoice: mustQuery && toolsUsed === 0 ? 'required' : 'auto',
        temperature: run.temperature
      },
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
        log.warn('agent', 'tool call was written as text; recovered', { step, tools: recovered.calls.map((c) => c.name) })
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
    // Anything said alongside the first tool call was written before any result came back, so it
    // cannot be grounded in the data (small models happily announce an answer, then go and look).
    if (calls.length > 0 && toolsUsed === 0) text = ''
    text = text.trim()
    // Servers that ignore tool_choice get one more chance to look at the data before their answer is accepted.
    if (calls.length === 0 && text && mustQuery && toolsUsed === 0 && !lastStep && groundingRetries < 1) {
      groundingRetries++
      log.warn('agent', 'answered without querying the data; asking again', { step, answerLength: text.length })
      onEvent({ type: 'step-text', text: '' })
      nudge = true
      continue
    }
    onEvent({ type: 'step-text', text })

    if (calls.length === 0) {
      if (!text) {
        // Small models occasionally emit EOS straight away. Nudge once, then give up loudly.
        if (emptyRetries++ < 1 && !lastStep) {
          log.warn('agent', 'empty reply; asking again', { step })
          nudge = true
          continue
        }
        throw new Error('The model returned an empty reply. Try again, or switch to a larger model (7B) in the model menu.')
      }
      added.push({ role: 'assistant', content: text })
      return
    }

    const parsed = calls.map((c) => ({ ...c, args: parseArgs(c.name, c.input) }))
    added.push({
      role: 'assistant',
      content: [
        ...(text ? [{ type: 'text' as const, text }] : []),
        ...parsed.map((c) => ({ type: 'tool-call' as const, toolCallId: c.id, toolName: c.name, input: c.args }))
      ]
    })

    // Every tool call needs a result, or the next request is malformed.
    const results: ToolModelMessage = { role: 'tool', content: [] }
    added.push(results)
    const reply = (call: ToolCall, value: string) =>
      results.content.push({ type: 'tool-result', toolCallId: call.id, toolName: call.name, output: { type: 'text', value } })

    for (const call of parsed) {
      if (signal?.aborted) {
        reply(call, '(Skipped: stopped by the user.)')
        continue
      }
      const { args } = call
      const key = `${call.name}:${String(args.sql ?? '').replace(/\s+/g, ' ').trim().toLowerCase()}`
      if (seen.has(key)) {
        // Small models loop on the same query; tell them to move on instead of re-running it.
        reply(call, 'You already ran exactly this query and have its result above. Do not repeat it — answer the user now.')
        repeats++
        log.warn('agent', 'model repeated a query', { step, tool: call.name })
        continue
      }
      seen.add(key)
      onEvent({ type: 'tool-start', id: call.id, name: call.name, args })
      const t0 = Date.now()
      const outcome = await runTool(session, call.name, args)
      // The query text and the shape of the result — never the rows themselves.
      log[outcome.error ? 'warn' : 'info']('agent', `tool ${call.name}`, {
        step,
        args,
        ms: Date.now() - t0,
        error: outcome.error,
        rows: outcome.result?.rowCount,
        truncated: outcome.result?.truncated,
        columns: outcome.result?.columns.length,
        chart: outcome.chart?.type
      })
      onEvent({ type: 'tool-end', id: call.id, outcome, durationMs: Date.now() - t0 })
      reply(call, outcome.forModel)
      toolsUsed++
      consecutiveErrors = outcome.error ? consecutiveErrors + 1 : 0
    }
  }
}
