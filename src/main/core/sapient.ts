import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, createWriteStream } from 'node:fs'
import { homedir, totalmem } from 'node:os'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'
import type { SapientStatus } from '@shared/types'
import { ModelClient } from './model'

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

/** Parameter count in billions from a model id ("qwen2.5-7b-q4" → 7); 0 when the id doesn't say (vision/speech models). */
export function modelSize(id: string): number {
  const m = /(?:^|[-_/])(\d+(?:\.\d+)?)b(?:$|[-_])/i.exec(id)
  return m ? Number(m[1]) : 0
}

export interface DownloadedModel {
  id: string
  /** Size of the weights on disk in GB (0 when `sapient list` doesn't say). */
  gb: number
}

/**
 * Memory a model takes while it loads, as a multiple of its size on disk. Measured on SAPIENT 0.6.5
 * (Apple M4): the CPU backend peaks at 1.3x (7B q4: 4.8 GB resident, 6.0 GB peak); the default Metal
 * backend holds 2.2x and peaks at 3.4x (3B q4: 4.6 GB resident, up to 7.9 GB peak), which for a 7B
 * model is more than a 16 GB Mac has.
 */
export const LOAD_FACTOR = { cpu: 1.3, default: 3.4 }

/**
 * The most capable downloaded chat model that loads into half of this computer's memory (the other
 * half is for macOS and everything else that is open). Small models answer fast but skip steps and
 * misread results, so "Auto" should not settle for one when a better one fits.
 */
export function bestModel(downloaded: DownloadedModel[], loadFactor: number, memoryGb = totalmem() / 2 ** 30): string | null {
  const needs = (m: DownloadedModel) => (m.gb || modelSize(m.id) * 0.7) * loadFactor
  const fits = downloaded.filter((m) => modelSize(m.id) > 0 && needs(m) <= memoryGb / 2)
  return fits.sort((a, b) => modelSize(b.id) - modelSize(a.id))[0]?.id ?? null
}

/** Parse `sapient list` (downloaded models and their size on disk). */
export async function listDownloaded(binary: string): Promise<DownloadedModel[]> {
  try {
    const { stdout } = await exec(binary, ['list'], { timeout: 10_000 })
    return [...stdout.matchAll(/^\s*([\w.-]+\/[\w.:-]+)\s+(.*)$/gm)]
      .filter((m) => !m[1].startsWith('MODEL'))
      .map((m) => {
        const size = /(\d+(?:\.\d+)?)\s*(GB|MB)\s*$/i.exec(m[2])
        return { id: m[1], gb: size ? Number(size[1]) / (size[2].toUpperCase() === 'MB' ? 1024 : 1) : 0 }
      })
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
  private startPromise: Promise<void> | null = null
  private lastError: string | undefined
  private downloadedCache: { at: number; models: DownloadedModel[] } | null = null
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
    const models = this.downloadedCache?.models ?? []
    const downloaded = models.map((m) => m.id)
    let resident: string[] = []
    let online = false
    try {
      resident = await new ModelClient(baseUrl).listModels(AbortSignal.timeout(2_000))
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
      // A server we did not start runs with SAPIENT's defaults, which need far more memory per model.
      activeModel: this.resolveModel(resident, models, online && !this.managed ? LOAD_FACTOR.default : LOAD_FACTOR.cpu),
      error: online ? undefined : this.lastError
    }
  }

  resolveModel(resident: string[], downloaded: DownloadedModel[], loadFactor: number): string {
    return this.opts.preferredModel() || bestModel(downloaded, loadFactor) || openHorizonDefaultModel() || resident[0] || downloaded[0]?.id || FALLBACK_MODEL
  }

  invalidateModels() {
    this.downloadedCache = null
  }

  /** Spawn `sapient serve` on the configured port and wait until it answers. Concurrent callers share one startup. */
  start(): Promise<void> {
    this.startPromise ??= this.startNow().finally(() => (this.startPromise = null))
    return this.startPromise
  }

  private async startNow(): Promise<void> {
    const baseUrl = this.opts.baseUrl()
    if (!isLocal(baseUrl)) throw new Error('SAPIENT can only be started automatically for a localhost URL.')
    const binary = findSapientBinary(this.opts.binaryOverride() || undefined)
    if (!binary) throw new Error('SAPIENT is not installed. Install it with: npm i -g openhorizon (then run `openhorizon update`).')
    if (this.managed) return
    this.starting = true
    this.lastError = undefined
    try {
      const args = [
        'serve',
        '--port', portOf(baseUrl),
        // One generation at a time: overlapping requests corrupt SAPIENT 0.6.5's model state.
        '--max-concurrency', '1',
        // SAPIENT keeps the last 3 models in memory by default. Switching model in the menu must free
        // the old one, or a 16 GB Mac runs out of memory.
        '--max-models', '1',
        // Half the memory of the default Metal backend and no slower for these model sizes (see LOAD_FACTOR).
        '--backend', 'cpu'
      ]
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
      // Without this a failed spawn (binary not executable, removed mid-run) is an uncaught exception.
      child.on('error', (err) => {
        log?.end()
        if (this.child === child) this.child = null
        this.lastError = `Could not run SAPIENT (${binary}): ${err.message}`
      })
      child.on('exit', (code) => {
        log?.end()
        if (this.child === child) this.child = null
        if (code && code !== 0) this.lastError = `SAPIENT exited with code ${code}. ${lastLine(tail)}`.trim()
      })
      const provider = new ModelClient(baseUrl)
      const deadline = Date.now() + 60_000
      while (Date.now() < deadline) {
        if (child.exitCode !== null || this.child !== child) throw new Error(this.lastError ?? 'SAPIENT exited during startup.')
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
