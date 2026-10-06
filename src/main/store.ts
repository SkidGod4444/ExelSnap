import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Conversation, ConversationSummary, Settings } from '@shared/types'
import { DEFAULT_BASE_URL } from './core/sapient'

export const DEFAULT_SETTINGS: Settings = {
  baseUrl: DEFAULT_BASE_URL,
  model: '',
  temperature: 0.2,
  autoStartSapient: true,
  sapientPath: '',
  theme: 'system'
}

function writeAtomic(path: string, data: string) {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, data)
  renameSync(tmp, path)
}

/** Conversations as one JSON file each under <userData>/conversations. */
export class Store {
  private dir: string
  private settingsPath: string
  private conversations = new Map<string, Conversation>()
  private timers = new Map<string, NodeJS.Timeout>()
  settings: Settings

  constructor(root: string) {
    this.dir = join(root, 'conversations')
    this.settingsPath = join(root, 'settings.json')
    mkdirSync(this.dir, { recursive: true })
    try {
      this.settings = { ...DEFAULT_SETTINGS, ...JSON.parse(readFileSync(this.settingsPath, 'utf8')) }
    } catch {
      this.settings = { ...DEFAULT_SETTINGS }
    }
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith('.json')) continue
      try {
        const c = JSON.parse(readFileSync(join(this.dir, f), 'utf8')) as Conversation
        // A run interrupted by quitting the app can't resume.
        for (const m of c.messages) {
          if (m.status === 'thinking' || m.status === 'streaming') m.status = 'stopped'
          for (const p of m.parts) if (p.kind === 'tool' && p.status === 'running') p.status = 'error'
        }
        this.conversations.set(c.id, c)
      } catch {
        /* skip corrupt file */
      }
    }
  }

  saveSettings(patch: Partial<Settings>): Settings {
    this.settings = { ...this.settings, ...patch }
    writeAtomic(this.settingsPath, JSON.stringify(this.settings, null, 2))
    return this.settings
  }

  get(id: string): Conversation | undefined {
    return this.conversations.get(id)
  }

  list(): ConversationSummary[] {
    return [...this.conversations.values()]
      .filter((c) => c.messages.length > 0)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(({ id, title, updatedAt }) => ({ id, title, updatedAt }))
  }

  put(c: Conversation) {
    this.conversations.set(c.id, c)
    this.save(c.id)
  }

  /** Debounced write — called on every streamed token. */
  save(id: string, delay = 400) {
    clearTimeout(this.timers.get(id))
    this.timers.set(
      id,
      setTimeout(() => {
        this.timers.delete(id)
        const c = this.conversations.get(id)
        if (c) writeAtomic(join(this.dir, `${id}.json`), JSON.stringify(c))
      }, delay)
    )
  }

  delete(id: string) {
    clearTimeout(this.timers.get(id))
    this.conversations.delete(id)
    rmSync(join(this.dir, `${id}.json`), { force: true })
  }

  flush() {
    for (const [id, t] of this.timers) {
      clearTimeout(t)
      const c = this.conversations.get(id)
      if (c) writeAtomic(join(this.dir, `${id}.json`), JSON.stringify(c))
    }
    this.timers.clear()
  }
}
