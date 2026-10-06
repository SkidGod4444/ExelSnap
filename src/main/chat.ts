import { randomUUID } from 'node:crypto'
import type { ModelMessage } from 'ai'
import type { AppEvent, Attachment, ChatMessage, Conversation, PreviewResult, ToolPart } from '@shared/types'
import { runAgent, type AgentEvent } from './core/agent'
import { ModelClient, ProviderError } from './core/model'
import type { SapientManager } from './core/sapient'
import { WorkbookSession } from './core/workbook'
import type { Store } from './store'

const now = () => Date.now()

function titleFrom(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > 48 ? t.slice(0, 46).trimEnd() + '…' : t || 'New chat'
}

/** Owns conversations' DuckDB sessions and agent runs; pushes UI updates through `emit`. */
export class ChatService {
  private sessions = new Map<string, Promise<WorkbookSession>>()
  private runs = new Map<string, AbortController>()
  private pending = new Map<string, NodeJS.Timeout>()

  constructor(private store: Store, private sapient: SapientManager, private emit: (e: AppEvent) => void) {}

  private conv(id: string): Conversation {
    const c = this.store.get(id)
    if (!c) throw new Error('Conversation not found')
    return c
  }

  private emitList() {
    this.emit({ type: 'conversations', conversations: this.store.list() })
  }

  /** Throttled per-message snapshot to the renderer. */
  private pushMessage(convId: string, msg: ChatMessage, immediate = false) {
    const key = msg.id
    const send = () => {
      this.pending.delete(key)
      this.emit({ type: 'message', conversationId: convId, message: structuredClone(msg) })
    }
    if (immediate) {
      clearTimeout(this.pending.get(key))
      return send()
    }
    if (!this.pending.has(key)) this.pending.set(key, setTimeout(send, 40))
  }

  create(): Conversation {
    const c: Conversation = { id: randomUUID(), title: 'New chat', createdAt: now(), updatedAt: now(), attachments: [], messages: [], history: [] }
    this.store.put(c)
    return c
  }

  /** Lazily (re)build the DuckDB session, reloading attachments from disk for older chats. */
  session(convId: string): Promise<WorkbookSession> {
    let s = this.sessions.get(convId)
    if (!s) {
      s = (async () => {
        const session = await WorkbookSession.create()
        const c = this.store.get(convId)
        if (c) {
          for (const a of c.attachments) {
            const loaded = await session.addFile(a.path, a.id)
            Object.assign(a, { tables: loaded.tables, status: loaded.status, error: loaded.error, size: loaded.size || a.size })
          }
          if (c.attachments.length) {
            this.store.put(c)
            this.emit({ type: 'conversation', conversation: c })
          }
        }
        return session
      })()
      this.sessions.set(convId, s)
    }
    return s
  }

  async attach(convId: string | null, paths: string[]): Promise<{ conversation: Conversation; added: Attachment[] }> {
    const c = convId ? this.conv(convId) : this.create()
    const session = await this.session(c.id)
    const added: Attachment[] = []
    for (const p of paths) {
      const existing = c.attachments.find((a) => a.path === p && a.status === 'ready')
      if (existing) {
        added.push(existing)
        continue
      }
      const att = await session.addFile(p)
      if (att.status === 'ready') c.attachments.push(att)
      added.push(att)
    }
    c.updatedAt = now()
    this.store.put(c)
    return { conversation: c, added }
  }

  async removeAttachment(convId: string, attId: string): Promise<Conversation> {
    const c = this.conv(convId)
    // Files already referenced by a sent message stay loaded — the history depends on them.
    const used = c.messages.some((m) => m.attachments?.some((a) => a.id === attId))
    if (!used) {
      await (await this.session(convId)).removeAttachment(attId)
      c.attachments = c.attachments.filter((a) => a.id !== attId)
      this.store.put(c)
    }
    return c
  }

  async preview(convId: string, table: string): Promise<PreviewResult> {
    const session = await this.session(convId)
    return { table, result: await session.preview(table, 200) }
  }

  async exportQuery(convId: string, sql: string) {
    return (await this.session(convId)).queryAll(sql)
  }

  rename(convId: string, title: string) {
    const c = this.conv(convId)
    c.title = title.trim() || c.title
    this.store.put(c)
    this.emitList()
  }

  delete(convId: string) {
    this.stop(convId)
    this.sessions.get(convId)?.then((s) => s.close())
    this.sessions.delete(convId)
    this.store.delete(convId)
    this.emitList()
  }

  stop(convId: string) {
    this.runs.get(convId)?.abort()
  }

  isRunning(convId: string) {
    return this.runs.has(convId)
  }

  async send(convId: string | null, text: string, attachmentIds: string[]): Promise<Conversation> {
    const c = convId ? this.conv(convId) : this.create()
    if (this.runs.has(c.id)) throw new Error('Already answering in this chat')
    const user: ChatMessage = {
      id: randomUUID(),
      role: 'user',
      createdAt: now(),
      parts: [{ kind: 'text', text }],
      attachments: c.attachments.filter((a) => attachmentIds.includes(a.id)).map((a) => structuredClone(a))
    }
    const assistant: ChatMessage = { id: randomUUID(), role: 'assistant', createdAt: now(), parts: [], status: 'thinking' }
    if (c.messages.length === 0) c.title = titleFrom(text || user.attachments?.[0]?.name || 'New chat')
    c.messages.push(user, assistant)
    c.updatedAt = now()
    this.store.put(c)
    this.emitList()
    void this.run(c, assistant, text, user.attachments ?? [])
    return c
  }

  private async run(c: Conversation, msg: ChatMessage, text: string, files: Attachment[]) {
    const ctrl = new AbortController()
    this.runs.set(c.id, ctrl)
    const t0 = now()
    const out: ModelMessage[] = []
    const update = (immediate = false) => {
      this.store.saveMessage(c.id, msg)
      this.pushMessage(c.id, msg, immediate)
    }
    let textIdx: number | null = null

    const onEvent = (e: AgentEvent) => {
      switch (e.type) {
        case 'step-start':
          textIdx = null
          msg.status = 'thinking'
          break
        case 'text':
          if (textIdx === null) {
            msg.parts.push({ kind: 'text', text: '' })
            textIdx = msg.parts.length - 1
          }
          ;(msg.parts[textIdx] as { text: string }).text += e.delta
          msg.status = 'streaming'
          break
        case 'step-text':
          if (textIdx !== null) {
            if (e.text) (msg.parts[textIdx] as { text: string }).text = e.text
            else msg.parts.splice(textIdx, 1)
          } else if (e.text) msg.parts.push({ kind: 'text', text: e.text })
          textIdx = null
          break
        case 'tool-start':
          msg.parts.push({ kind: 'tool', id: e.id, name: e.name, args: e.args, status: 'running' })
          msg.status = 'thinking'
          break
        case 'tool-end': {
          const part = msg.parts.find((p): p is ToolPart => p.kind === 'tool' && p.id === e.id)
          if (part) {
            part.status = e.outcome.error ? 'error' : 'done'
            part.result = e.outcome.result
            part.chart = e.outcome.chart
            part.error = e.outcome.error
            part.durationMs = e.durationMs
          }
          break
        }
      }
      update(e.type === 'tool-start' || e.type === 'tool-end')
    }

    try {
      let status = await this.sapient.status()
      if (status.state !== 'online' && this.store.settings.autoStartSapient && status.binary) {
        this.emit({ type: 'sapient', status: { ...status, state: 'starting' } })
        await this.sapient.start()
        status = await this.sapient.status()
        this.emit({ type: 'sapient', status })
      }
      msg.model = status.activeModel
      const session = await this.session(c.id)
      const fileNote = files.length ? `\n\n(I attached ${files.map((f) => `${f.name}, loaded as table ${f.tables.map((t) => t.table).join(', ')}`).join('; ')}.)` : ''
      await runAgent({
        provider: new ModelClient(this.store.settings.baseUrl),
        model: status.activeModel,
        session,
        history: c.history,
        userText: (text || 'Give me a quick overview of this data.') + fileNote,
        temperature: this.store.settings.temperature,
        signal: ctrl.signal,
        out,
        onEvent
      })
      msg.status = ctrl.signal.aborted ? 'stopped' : 'done'
    } catch (err) {
      if (ctrl.signal.aborted || (err instanceof ProviderError && err.kind === 'aborted')) {
        msg.status = 'stopped'
      } else {
        msg.status = 'error'
        msg.error = err instanceof Error ? err.message : String(err)
      }
    } finally {
      // Keep the model-facing transcript well-formed even after a stop/error.
      const last = out[out.length - 1]
      if (last?.role === 'assistant' && typeof last.content !== 'string' && last.content.some((p) => p.type === 'tool-call')) {
        // Tool calls that never got results would make the next request invalid.
        const said = last.content.map((p) => (p.type === 'text' ? p.text : '')).join('')
        out[out.length - 1] = { role: 'assistant', content: said || '(Stopped.)' }
      } else if (last && last.role !== 'assistant') {
        out.push({ role: 'assistant', content: msg.status === 'stopped' ? '(Stopped by the user.)' : `(Failed: ${msg.error ?? 'unknown error'})` })
      }
      c.history.push(...out)
      for (const p of msg.parts) if (p.kind === 'tool' && p.status === 'running') p.status = 'error'
      msg.durationMs = now() - t0
      c.updatedAt = now()
      this.runs.delete(c.id)
      // Unless the chat was deleted while the model was still answering.
      if (this.store.get(c.id) === c) {
        this.store.put(c)
        update(true)
      }
      this.emitList()
    }
  }

  async shutdown() {
    for (const ctrl of this.runs.values()) ctrl.abort()
    for (const s of this.sessions.values()) (await s.catch(() => null))?.close()
  }
}
