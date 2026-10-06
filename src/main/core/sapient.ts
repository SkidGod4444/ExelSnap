import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, createWriteStream } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'
import type { SapientStatus } from '@shared/types'
import { OpenAICompatibleProvider } from './provider'

const exec = promisify(execFile)

export const DEFAULT_BASE_URL = 'http://localhost:11435/v1'
export const FALLBACK_MODEL = 'openhorizon/qwen2.5-1.5b-q4'

/** Apps launched from Finder get a minimal PATH, so also look in the usual install locations. */
export function findSapientBinary(override?: string): string | null {
  if (override) return existsSync(override) ? override : null
  const exe = process.platform === 'win32' ? 'sapient.exe' : 'sapient'
  const dirs = [
    ...(process.env.PATH ?? '').split(delimiter),
    join(homedir(), '.local', 'bin'),
    join(homedir(), '.cargo', 'bin'),
    join(homedir(), '.openhorizon', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin'
  ]
  for (const d of dirs) {
    if (d && existsSync(join(d, exe))) return join(d, exe)
  }
  return null
}

/** The model the user picked with `openhorizon model` (~/.openhorizon/config.json), if any. */
export function openHorizonDefaultModel(): string | null {
  try {
    const j = JSON.parse(readFileSync(join(homedir(), '.openhorizon', 'config.json'), 'utf8'))
    return typeof j.model === 'string' && j.model ? j.model : null
  } catch {
    return null
  }
}

/** Parse `sapient list` (downloaded models). */
export async function listDownloaded(binary: string): Promise<string[]> {
  try {
    const { stdout } = await exec(binary, ['list'], { timeout: 10_000 })
    return [...stdout.matchAll(/^\s*([\w.-]+\/[\w.:-]+)\s+/gm)].map((m) => m[1]).filter((m) => !m.startsWith('MODEL'))
  } catch {
    return []
  }
}

export async function sapientVersion(binary: string): Promise<string | undefined> {
  try {
    const { stdout } = await exec(binary, ['--version'], { timeout: 5_000 })
    return stdout.trim().replace(/^sapient\s*/i, '')
  } catch {
    return undefined
  }
}

function portOf(baseUrl: string): string {
  try {
    const u = new URL(baseUrl)
    return u.port || (u.protocol === 'https:' ? '443' : '80')
  } catch {
    return '11435'
  }
}

function isLocal(baseUrl: string): boolean {
  try {
    return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(baseUrl).hostname)
  } catch {
    return false
  }
}

/**
 * Talks to (and optionally owns) the local SAPIENT server. Today it uses a system install;
 * bundling later means pointing `binary` at a copy inside the app's resources.
 */
export class SapientManager {
  private child: ChildProcess | null = null
  private starting = false
  private lastError: string | undefined
  private downloadedCache: { at: number; models: string[] } | null = null
  private versionCache: string | undefined

  constructor(private opts: { baseUrl: () => string; binaryOverride: () => string; preferredModel: () => string; logPath?: string }) {}

  get managed() {
    return this.child !== null && this.child.exitCode === null
  }

  async status(): Promise<SapientStatus> {
    const baseUrl = this.opts.baseUrl()
    const binary = findSapientBinary(this.opts.binaryOverride() || undefined)
    if (binary && this.versionCache === undefined) this.versionCache = await sapientVersion(binary)
    if (binary && (!this.downloadedCache || Date.now() - this.downloadedCache.at > 30_000)) {
      this.downloadedCache = { at: Date.now(), models: await listDownloaded(binary) }
    }
    const downloaded = this.downloadedCache?.models ?? []
    let resident: string[] = []
    let online = false
    try {
      resident = await new OpenAICompatibleProvider(baseUrl).listModels(AbortSignal.timeout(2_000))
      online = true
    } catch {
      online = false
    }
    return {
      state: online ? 'online' : this.starting ? 'starting' : this.lastError ? 'error' : 'offline',
      baseUrl,
      binary,
      version: this.versionCache,
      managed: this.managed,
      resident,
      downloaded,
      activeModel: this.resolveModel(resident, downloaded),
      error: online ? undefined : this.lastError
    }
  }

  resolveModel(resident: string[], downloaded: string[]): string {
    return this.opts.preferredModel() || openHorizonDefaultModel() || resident[0] || downloaded[0] || FALLBACK_MODEL
  }

  invalidateModels() {
    this.downloadedCache = null
  }

  /** Spawn `sapient serve` on the configured port and wait until it answers. */
  async start(): Promise<void> {
    const baseUrl = this.opts.baseUrl()
    if (!isLocal(baseUrl)) throw new Error('SAPIENT can only be started automatically for a localhost URL.')
    const binary = findSapientBinary(this.opts.binaryOverride() || undefined)
    if (!binary) throw new Error('SAPIENT is not installed. Install it with: npm i -g openhorizon (then run `openhorizon update`).')
    if (this.managed) return
    this.starting = true
    this.lastError = undefined
    try {
      // One generation at a time: overlapping requests corrupt SAPIENT 0.6.5's model state.
      const args = ['serve', '--port', portOf(baseUrl), '--max-concurrency', '1']
      const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      this.child = child
      let tail = ''
      const log = this.opts.logPath ? createWriteStream(this.opts.logPath, { flags: 'a' }) : null
      const onData = (b: Buffer) => {
        log?.write(b)
        tail = (tail + b.toString()).slice(-2000)
      }
      child.stdout?.on('data', onData)
      child.stderr?.on('data', onData)
      child.on('exit', (code) => {
        log?.end()
        if (this.child === child) this.child = null
        if (code && code !== 0) this.lastError = `SAPIENT exited with code ${code}. ${lastLine(tail)}`.trim()
      })
      const provider = new OpenAICompatibleProvider(baseUrl)
      const deadline = Date.now() + 60_000
      while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(this.lastError ?? 'SAPIENT exited during startup.')
        try {
          await provider.listModels(AbortSignal.timeout(1_000))
          return
        } catch {
          await new Promise((r) => setTimeout(r, 500))
        }
      }
      throw new Error('SAPIENT did not start within 60 seconds.')
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err)
      throw err
    } finally {
      this.starting = false
    }
  }

  stop() {
    if (this.child && this.child.exitCode === null) this.child.kill()
    this.child = null
  }
}

function lastLine(s: string): string {
  const lines = s.split('\n').map((l) => l.trim()).filter(Boolean)
  return lines.find((l) => /error|panic|failed/i.test(l)) ?? lines[lines.length - 1] ?? ''
}
