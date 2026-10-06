import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, createWriteStream } from 'node:fs'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'
import type { Backend, SapientStatus } from '@shared/types'
import { adviseModels, autoModel, deviceInfo, type DownloadedModel, type GpuEngine } from './capacity'
import { log } from './log'
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
  private backendNote: string | undefined
  private cpuFallback = false // the chosen backend isn't in this SAPIENT build
  private pulling: string | undefined
  private stopping: Promise<void> = Promise.resolve()
  private gpuEngine: GpuEngine | undefined // which GPU flag this binary accepted
  private engineUpdating = false
  private engineNote: string | undefined

  constructor(
    private opts: {
      baseUrl: () => string
      binaryOverride: () => string
      preferredModel: () => string
      backend: () => Backend
      answerSeconds?: (model: string, backend: Backend) => number | undefined
      logPath?: string
      /** The SAPIENT binary shipped with the app, and the writable folder its working copy lives in. */
      engine?: { seed: string; dir: string }
    }
  ) {}

  private get enginePath(): string | null {
    return this.opts.engine ? join(this.opts.engine.dir, 'sapient') : null
  }

  /** The binary to run: a path set in Settings, else the app's own copy, else one installed on the system. */
  private binary(): { path: string | null; source: 'bundled' | 'custom' | 'system' | 'none' } {
    const override = this.opts.binaryOverride()
    if (override) return { path: existsSync(override) ? override : null, source: 'custom' }
    if (this.enginePath && existsSync(this.enginePath)) return { path: this.enginePath, source: 'bundled' }
    const system = findSapientBinary()
    return { path: system, source: system ? 'system' : 'none' }
  }

  /**
   * Called when the app opens. Installs the bundled SAPIENT into a writable folder (the copy inside
   * a signed app can't be changed) and lets it update itself to the latest release, so users are
   * never stuck on the engine version the app was built with. Needs the network only for the
   * update; offline it simply keeps the version it has.
   */
  async prepareEngine(): Promise<void> {
    const engine = this.opts.engine
    const path = this.enginePath
    if (!engine || !path || this.opts.binaryOverride()) return
    this.engineUpdating = true
    try {
      if (existsSync(engine.seed)) {
        const [have, shipped] = await Promise.all([existsSync(path) ? sapientVersion(path) : undefined, sapientVersion(engine.seed)])
        if (!have || (shipped && newer(shipped, have))) {
          await mkdir(engine.dir, { recursive: true })
          // Written as a new file rather than copied, so no quarantine attribute comes along from the app bundle.
          await writeFile(path, await readFile(engine.seed))
          await chmod(path, 0o755)
          log.info('sapient', 'installed bundled engine', { version: shipped, replaced: have })
        }
      }
      if (!existsSync(path)) return
      const before = await sapientVersion(path)
      try {
        // --hybrid: the build that has all three modes (CPU, GPU, hybrid).
        const { stdout, stderr } = await exec(path, ['update', '--hybrid'], { timeout: 180_000 })
        const after = await sapientVersion(path)
        this.engineNote = after && before && after !== before ? `Updated SAPIENT ${before} → ${after}.` : undefined
        log.info('sapient', 'update check', { before, after, output: lastLine(`${stdout}\n${stderr}`) })
      } catch (err) {
        // Offline, rate-limited, or the download failed: keep what is installed.
        this.engineNote = `Could not check for a SAPIENT update (using ${before ?? 'the installed version'}).`
        log.warn('sapient', 'update check failed', { before, error: err })
      }
      this.versionCache = undefined
    } finally {
      this.engineUpdating = false
    }
  }

  get managed() {
    return this.child !== null && this.child.exitCode === null
  }

  async status(): Promise<SapientStatus> {
    const baseUrl = this.opts.baseUrl()
    const { path: binary, source } = this.binary()
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
    // For a server started outside the app the mode can't be read back, so the setting is taken as
    // what the user started it with (Settings says so).
    const backend: Backend = this.cpuFallback ? 'cpu' : this.opts.backend()
    const device = deviceInfo()
    // The bundled engine is the wgpu build; another binary is assumed to be the Metal build until it shows otherwise.
    const advice = adviseModels(models, backend, device.memoryGb, this.gpuEngine ?? (source === 'bundled' ? 'wgpu' : 'metal'))
    for (const m of advice) m.typicalSeconds = this.opts.answerSeconds?.(m.id, backend)
    return {
      state: online ? 'online' : this.starting ? 'starting' : this.lastError ? 'error' : 'offline',
      baseUrl,
      binary,
      version: this.versionCache,
      managed: this.managed,
      resident,
      downloaded,
      activeModel: this.opts.preferredModel() || autoModel(advice) || openHorizonDefaultModel() || resident[0] || FALLBACK_MODEL,
      device,
      backend,
      backendNote: this.backendNote,
      models: advice,
      pulling: this.pulling,
      engine: { source, updating: this.engineUpdating, note: this.engineNote },
      error: online ? undefined : this.lastError
    }
  }

  invalidateModels() {
    this.downloadedCache = null
  }

  /** The user picked another backend: forget that an earlier one was unavailable. */
  backendChanged() {
    this.cpuFallback = false
    this.backendNote = undefined
  }

  /** Download a model with `sapient pull`. */
  async pull(id: string): Promise<void> {
    const binary = this.binary().path
    if (!binary) throw new Error('SAPIENT is not installed.')
    if (this.pulling) throw new Error(`Already downloading ${this.pulling}.`)
    this.pulling = id
    log.info('sapient', 'downloading model', { id })
    try {
      await exec(binary, ['pull', id], { timeout: 6 * 60 * 60_000, maxBuffer: 64 << 20 })
    } catch (err) {
      log.error('sapient', 'download failed', { id, error: err })
      throw err
    } finally {
      this.pulling = undefined
      this.invalidateModels()
    }
  }

  /** Spawn `sapient serve` on the configured port and wait until it answers. Concurrent callers share one startup. */
  async start(): Promise<void> {
    // A start that is still waiting for a server which has since been stopped (the user switched
    // backend or pressed Stop while it was coming up) is about to fail. Let it, then start afresh
    // instead of handing that failure to the new caller.
    if (this.startPromise && !this.managed) await this.startPromise.catch(() => {})
    this.startPromise ??= this.startNow().finally(() => (this.startPromise = null))
    return this.startPromise
  }

  private async startNow(): Promise<void> {
    const wanted = this.cpuFallback ? 'cpu' : this.opts.backend()
    // "GPU" is wgpu in the hybrid/GPU builds and Metal (MLX) in the Apple-only Metal build.
    const flags = wanted !== 'gpu' ? [wanted] : this.binary().source === 'bundled' ? ['wgpu'] : process.platform === 'darwin' ? ['metal', 'wgpu'] : ['wgpu']
    let failure: unknown
    for (const flag of flags) {
      try {
        await this.launch(flag)
        if (wanted === 'gpu') this.gpuEngine = flag as GpuEngine
        return
      } catch (err) {
        failure = err
        // e.g. "cannot serve with --backend hybrid: this binary was built without GPU (wgpu) support"
        if (!/cannot serve with --backend|built without|not available/i.test(err instanceof Error ? err.message : String(err))) throw err
      }
    }
    if (wanted === 'cpu') throw failure
    const message = failure instanceof Error ? failure.message : String(failure)
    this.cpuFallback = true
    log.warn('sapient', 'backend not available in this build; falling back to CPU', { wanted, message })
    this.backendNote = `${wanted === 'gpu' ? 'GPU' : 'Hybrid'} mode isn't available in this SAPIENT build, so it is running on the CPU. (${message.replace(/^SAPIENT exited with code \d+\.\s*/, '').replace(/^✗\s*/, '').slice(0, 220)})`
    await this.launch('cpu')
  }

  private async launch(backend: string): Promise<void> {
    const baseUrl = this.opts.baseUrl()
    if (!isLocal(baseUrl)) throw new Error('SAPIENT can only be started automatically for a localhost URL.')
    const binary = this.binary().path
    if (!binary) throw new Error('SAPIENT is not installed. Install it with: npm i -g openhorizon (then run `openhorizon update`).')
    if (this.managed) return
    this.starting = true
    this.lastError = undefined
    try {
      await this.stopping
      const args = [
        'serve',
        '--port', portOf(baseUrl),
        // One generation at a time: overlapping requests corrupt SAPIENT 0.6.5's model state.
        '--max-concurrency', '1',
        // SAPIENT keeps the last 3 models in memory by default. Switching model in the menu must free
        // the old one, or a 16 GB Mac runs out of memory.
        '--max-models', '1',
        '--backend', backend
      ]
      log.info('sapient', 'starting', { binary, args: args.join(' '), version: this.versionCache })
      const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      const started = Date.now()
      this.child = child
      let tail = ''
      const out = this.opts.logPath ? createWriteStream(this.opts.logPath, { flags: 'a' }) : null
      const onData = (b: Buffer) => {
        out?.write(b)
        tail = (tail + b.toString()).slice(-2000)
      }
      child.stdout?.on('data', onData)
      child.stderr?.on('data', onData)
      // Without this a failed spawn (binary not executable, removed mid-run) is an uncaught exception.
      child.on('error', (err) => {
        out?.end()
        if (this.child === child) this.child = null
        this.lastError = `Could not run SAPIENT (${binary}): ${err.message}`
        log.error('sapient', 'could not be run', { binary, error: err.message })
      })
      child.on('exit', (code, signal) => {
        log.info('sapient', 'exited', { code, signal, afterMs: Date.now() - started, lastOutput: lastLine(tail) })
        out?.end()
        if (this.child === child) this.child = null
        if (code && code !== 0) this.lastError = `SAPIENT exited with code ${code}. ${lastLine(tail)}`.trim()
      })
      const provider = new ModelClient(baseUrl)
      const deadline = Date.now() + 60_000
      while (Date.now() < deadline) {
        if (child.exitCode !== null || this.child !== child) throw new Error(this.lastError ?? 'SAPIENT exited during startup.')
        try {
          await provider.listModels(AbortSignal.timeout(1_000))
          log.info('sapient', 'ready', { afterMs: Date.now() - started })
          return
        } catch {
          await new Promise((r) => setTimeout(r, 500))
        }
      }
      throw new Error('SAPIENT did not start within 60 seconds.')
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err)
      log.error('sapient', 'start failed', { backend, error: this.lastError })
      throw err
    } finally {
      this.starting = false
    }
  }

  stop() {
    const child = this.child
    this.child = null
    if (!child || child.exitCode !== null) return
    // SAPIENT holds a lock file and the port until it has exited; a start right after a stop must wait for that.
    this.stopping = new Promise<void>((resolve) => {
      child.once('exit', () => resolve())
      setTimeout(resolve, 5_000)
    })
    log.info('sapient', 'stopping')
    child.kill()
  }
}

/** Whether version `a` ("0.7.1") is newer than `b`. */
function newer(a: string, b: string): boolean {
  const [x, y] = [a, b].map((v) => v.split(/[.\s-]/).map((n) => parseInt(n, 10) || 0))
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)
  return false
}

function lastLine(s: string): string {
  const lines = s.split('\n').map((l) => l.trim()).filter(Boolean)
  return lines.find((l) => /error|panic|failed/i.test(l)) ?? lines[lines.length - 1] ?? ''
}
