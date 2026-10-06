import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import type { ModelMessage } from 'ai'
import type { ChatMessage, Conversation, ConversationSummary, Settings } from '@shared/types'
import { DEFAULT_BASE_URL } from './core/sapient'

export const DEFAULT_SETTINGS: Settings = {
  baseUrl: DEFAULT_BASE_URL,
  model: '',
  temperature: 0.2,
  autoStartSapient: true,
  sapientPath: '',
  theme: 'system'
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  attachments TEXT NOT NULL,
  history TEXT NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  data TEXT NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS messages_by_conversation ON messages (conversation_id, seq);
CREATE INDEX IF NOT EXISTS conversations_by_updated ON conversations (updated_at DESC);
`

interface ConversationRow {
  id: string
  title: string
  created_at: number
  updated_at: number
  attachments: string
  history: string
}

/**
 * Chats and settings in one SQLite file (<userData>/exelsnap.db, Node's built-in `node:sqlite`).
 * The sidebar list is an indexed query, a chat is loaded when it is opened, and a streaming reply
 * rewrites one message row instead of the whole chat.
 */
export class Store {
  private db: DatabaseSync
  private loaded = new Map<string, Conversation>()
  private persisted = new Map<string, Set<string>>() // message ids already in the database, per loaded chat
  private timers = new Map<string, { timer: NodeJS.Timeout; write: () => void }>()
  private q: Record<'conv' | 'messages' | 'list' | 'putConv' | 'putMessage' | 'touch' | 'delConv' | 'putSetting', StatementSync>
  settings: Settings

  constructor(root: string) {
    mkdirSync(root, { recursive: true })
    this.db = new DatabaseSync(join(root, 'exelsnap.db'))
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;')
    this.db.exec(SCHEMA)
    this.q = {
      conv: this.db.prepare('SELECT * FROM conversations WHERE id = ?'),
      messages: this.db.prepare('SELECT data FROM messages WHERE conversation_id = ? ORDER BY seq'),
      list: this.db.prepare(
        `SELECT id, title, updated_at AS updatedAt FROM conversations c
         WHERE EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id) ORDER BY updated_at DESC`
      ),
      putConv: this.db.prepare(
        `INSERT INTO conversations (id, title, created_at, updated_at, attachments, history) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at,
           attachments = excluded.attachments, history = excluded.history`
      ),
      putMessage: this.db.prepare(
        `INSERT INTO messages (id, conversation_id, seq, data) VALUES (?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET seq = excluded.seq, data = excluded.data`
      ),
      touch: this.db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?'),
      delConv: this.db.prepare('DELETE FROM conversations WHERE id = ?'),
      putSetting: this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
    }
    this.importLegacyFiles(root)
    // Chats that got a file attached but never a message are invisible in the sidebar; don't keep them.
    this.db.exec('DELETE FROM conversations WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = conversations.id)')

    const saved: Record<string, unknown> = {}
    for (const r of this.db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]) {
      try {
        saved[r.key] = JSON.parse(r.value)
      } catch {
        /* skip a corrupt value */
      }
    }
    this.settings = { ...DEFAULT_SETTINGS, ...saved }
  }

  private transaction(fn: () => void) {
    this.db.exec('BEGIN')
    try {
      fn()
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  saveSettings(patch: Partial<Settings>): Settings {
    this.settings = { ...this.settings, ...patch }
    this.transaction(() => {
      for (const [key, value] of Object.entries(patch)) this.q.putSetting.run(key, JSON.stringify(value))
    })
    return this.settings
  }

  get(id: string): Conversation | undefined {
    const cached = this.loaded.get(id)
    if (cached) return cached
    const row = this.q.conv.get(id) as ConversationRow | undefined
    if (!row) return undefined
    const messages = (this.q.messages.all(id) as { data: string }[]).map((r) => JSON.parse(r.data) as ChatMessage)
    // A run interrupted by quitting the app can't resume.
    for (const m of messages) {
      if (m.status === 'thinking' || m.status === 'streaming') m.status = 'stopped'
      for (const p of m.parts) if (p.kind === 'tool' && p.status === 'running') p.status = 'error'
    }
    const c: Conversation = {
      id: row.id,
      title: row.title,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      attachments: JSON.parse(row.attachments),
      messages,
      history: JSON.parse(row.history)
    }
    this.loaded.set(id, c)
    this.persisted.set(id, new Set(messages.map((m) => m.id)))
    return c
  }

  list(): ConversationSummary[] {
    return this.q.list.all() as unknown as ConversationSummary[]
  }

  private writeMessage(c: Conversation, m: ChatMessage) {
    this.q.putMessage.run(m.id, c.id, c.messages.indexOf(m), JSON.stringify(m))
  }

  /** Save the chat itself (title, attachments, model transcript) and any messages not stored yet. */
  put(c: Conversation) {
    this.loaded.set(c.id, c)
    let known = this.persisted.get(c.id)
    if (!known) this.persisted.set(c.id, (known = new Set()))
    this.transaction(() => {
      this.q.putConv.run(c.id, c.title, c.createdAt, c.updatedAt, JSON.stringify(c.attachments), JSON.stringify(c.history))
      for (const m of c.messages) {
        if (known.has(m.id)) continue
        this.writeMessage(c, m)
        known.add(m.id)
      }
    })
  }

  /** Debounced rewrite of one message — called on every streamed token. */
  saveMessage(convId: string, m: ChatMessage, delay = 400) {
    const pending = this.timers.get(m.id)
    if (pending) clearTimeout(pending.timer)
    const write = () => {
      this.timers.delete(m.id)
      const c = this.loaded.get(convId)
      if (!c || !c.messages.includes(m)) return
      this.writeMessage(c, m)
      this.persisted.get(convId)?.add(m.id)
      this.q.touch.run(c.updatedAt, convId)
    }
    this.timers.set(m.id, { timer: setTimeout(write, delay), write })
  }

  delete(id: string) {
    const c = this.loaded.get(id)
    for (const m of c?.messages ?? []) {
      const pending = this.timers.get(m.id)
      if (pending) clearTimeout(pending.timer)
      this.timers.delete(m.id)
    }
    this.loaded.delete(id)
    this.persisted.delete(id)
    this.q.delConv.run(id) // messages go with it (ON DELETE CASCADE)
  }

  flush() {
    for (const { timer, write } of [...this.timers.values()]) {
      clearTimeout(timer)
      write()
    }
  }

  close() {
    this.flush()
    try {
      this.db.close()
    } catch {
      /* already closed */
    }
  }

  /** One-time import of the JSON files older versions kept (<userData>/conversations/*.json, settings.json). */
  private importLegacyFiles(root: string) {
    const dir = join(root, 'conversations')
    const settingsPath = join(root, 'settings.json')
    if (existsSync(settingsPath)) {
      try {
        const old = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>
        this.transaction(() => {
          for (const [key, value] of Object.entries(old)) this.q.putSetting.run(key, JSON.stringify(value))
        })
      } catch {
        /* unreadable settings: fall back to defaults */
      }
      renameSync(settingsPath, `${settingsPath}.imported`)
    }
    if (!existsSync(dir)) return
    this.transaction(() => {
      for (const f of readdirSync(dir)) {
        if (!f.endsWith('.json')) continue
        try {
          const c = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Conversation
          this.q.putConv.run(c.id, c.title, c.createdAt, c.updatedAt, JSON.stringify(c.attachments ?? []), JSON.stringify(upgradeHistory(c.history ?? [])))
          c.messages.forEach((m, i) => this.q.putMessage.run(m.id, c.id, i, JSON.stringify(m)))
        } catch {
          /* skip corrupt file */
        }
      }
    })
    // Kept as a backup rather than deleted.
    renameSync(dir, `${dir}.imported`)
  }
}

interface LegacyMessage {
  role: 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: { id: string; function: { name: string; arguments: string } }[]
  tool_call_id?: string
}

/** Older versions stored the model transcript in OpenAI wire format; the AI SDK uses ModelMessage. */
function upgradeHistory(history: unknown[]): ModelMessage[] {
  const legacy = history.some((m) => {
    const x = m as LegacyMessage
    return x.tool_calls !== undefined || x.tool_call_id !== undefined || x.content === null
  })
  if (!legacy) return history as ModelMessage[]
  const names = new Map<string, string>()
  const out: ModelMessage[] = []
  for (const m of history as LegacyMessage[]) {
    if (m.role === 'tool') {
      const part = {
        type: 'tool-result' as const,
        toolCallId: m.tool_call_id ?? '',
        toolName: names.get(m.tool_call_id ?? '') ?? 'run_sql',
        output: { type: 'text' as const, value: m.content ?? '' }
      }
      const prev = out[out.length - 1]
      if (prev?.role === 'tool') prev.content.push(part)
      else out.push({ role: 'tool', content: [part] })
    } else if (m.role === 'assistant' && m.tool_calls?.length) {
      out.push({
        role: 'assistant',
        content: [
          ...(m.content ? [{ type: 'text' as const, text: m.content }] : []),
          ...m.tool_calls.map((t) => {
            names.set(t.id, t.function.name)
            let input: unknown = {}
            try {
              input = JSON.parse(t.function.arguments)
            } catch {
              input = { sql: t.function.arguments }
            }
            return { type: 'tool-call' as const, toolCallId: t.id, toolName: t.function.name, input }
          })
        ]
      })
    } else {
      out.push({ role: m.role, content: m.content ?? '' })
    }
  }
  return out
}
