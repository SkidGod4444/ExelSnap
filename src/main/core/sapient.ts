import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, createWriteStream } from 'node:fs'
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

/** SAPIENT's own installer: picks the build for this Mac, verifies its checksum, installs without a password when given a user folder. */
const INSTALL_SCRIPT = 'https://github.com/openhorizon-labs/sapient/releases/latest/download/install.sh'
/** Where the app installs SAPIENT when the computer has none: the same place its installer uses for a user install, so the terminal finds it too. */
const INSTALL_DIR = process.env.EXELSNAP_SAPIENT_DIR || join(homedir(), '.local', 'bin')

/** Apps launched from Finder get a minimal PATH, so also look in the usual install locations. */
export function findSapientBinary(override?: string): string | null {
  if (override) return existsSync(override) ? override : null
  // EXELSNAP_SAPIENT_DIR pins the app to one folder (used by tests, or to keep it apart from a system install).
  if (process.env.EXELSNAP_SAPIENT_DIR) return existsSync(join(INSTALL_DIR, 'sapient')) ? join(INSTALL_DIR, 'sapient') : null
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
  private gpuEngine: GpuEngine | undefined // wgpu (hybrid/GPU builds) or Metal (the Apple-only build), once known
  private engineUpdating = false
  private engineInstalling = false
  private preparing: Promise<void> | null = null
  private engineNote: string | undefined

  constructor(
    private opts: {
      baseUrl: () => string
      binaryOverride: () => string
      preferredModel: () => string
      backend: () => Backend
      answerSeconds?: (model: string, backend: Backend) => number | undefined
      logPath?: string
    }
  ) {}

  /** The binary to run: a path set in Settings, else the SAPIENT installed on this computer. */
  private binary(): { path: string | null; source: 'custom' | 'system' | 'none' } {
    const override = this.opts.binaryOverride()
    if (override) return { path: existsSync(override) ? override : null, source: 'custom' }
    const system = findSapientBinary()
    return { path: system, source: system ? 'system' : 'none' }
  }

  /**
   * Called every time the app opens (and from "Set up" in the UI). If the computer has no SAPIENT,
   * install it with SAPIENT's own install script; otherwise let it update itself to the latest
   * release. Both need the network; offline the app keeps whatever is installed. A binary set in
   * Settings is left alone.
   */
  prepareEngine(): Promise<void> {
    this.preparing ??= this.prepareNow().finally(() => (this.preparing = null))
    return this.preparing
  }

  /** A question sent while SAPIENT is still being installed waits for the install instead of failing. */
  async ensureInstalled(): Promise<void> {
    if (!this.binary().path && !this.opts.binaryOverride()) await this.prepareEngine()
  }

  private async prepareNow(): Promise<void> {
    if (this.opts.binaryOverride()) return
    const installed = this.binary().path
    this.engineNote = undefined
    if (!installed) {
      this.engineInstalling = true
      try {
        log.info('sapient', 'not found on this computer; installing', { dir: INSTALL_DIR })
        // SAPIENT_INSTALL_DIR keeps the installer from asking for an administrator password;
        // the hybrid build has all three modes the app offers (CPU, GPU, hybrid).
        const { stdout, stderr } = await exec('/bin/sh', ['-c', `set -o pipefail 2>/dev/null; /usr/bin/curl -fsSL ${INSTALL_SCRIPT} | /bin/sh`], {
          timeout: 10 * 60_000,
          maxBuffer: 16 << 20,
          env: { ...process.env, SAPIENT_INSTALL_DIR: INSTALL_DIR, SAPIENT_VARIANT: 'hybrid', NO_COLOR: '1' }
        })
        const path = this.binary().path
        if (!path) throw new Error(lastLine(`${stdout}\n${stderr}`) || 'the installer finished but SAPIENT is still missing')
        log.info('sapient', 'installed', { path, version: await sapientVersion(path) })
      } catch (err) {
        this.engineNote = `SAPIENT could not be installed: ${(err instanceof Error ? lastLine(err.message) : String(err)).slice(0, 200)}. Check the internet connection and try again.`
        log.error('sapient', 'install failed', err)
      } finally {
        this.engineInstalling = false
        this.versionCache = undefined
        this.invalidateModels()
      }
      return
    }
    this.engineUpdating = true
    try {
      const before = await sapientVersion(installed)
      const { stdout, stderr } = await exec(installed, ['update'], { timeout: 180_000 })
      const output = lastLine(`${stdout}\n${stderr}`)
      const after = await sapientVersion(installed)
      // "sapient 0.6.5 (Metal (MLX, GPU)) is already up to date." — also tells which GPU engine this build has.
      if (/\(\s*Metal/i.test(output)) this.gpuEngine = 'metal'
      else if (/\(\s*(Hybrid|GPU)/i.test(output)) this.gpuEngine = 'wgpu'
      if (after && before && after !== before) this.engineNote = `Updated SAPIENT ${before} → ${after}.`
      log.info('sapient', 'update check', { before, after, output })
    } catch (err) {
      // Offline, rate-limited, or the download failed: keep what is installed.
      log.warn('sapient', 'update check failed', err)
    } finally {
      this.engineUpdating = false
      this.versionCache = undefined
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
    // Until the build is known, budget for wgpu: it has the larger loading spike.
    const advice = adviseModels(models, backend, device.memoryGb, this.gpuEngine ?? 'wgpu')
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
      engine: { source, installing: this.engineInstalling, updating: this.engineUpdating, note: this.engineNote },
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
    const flags = wanted !== 'gpu' ? [wanted] : process.platform !== 'darwin' ? ['wgpu'] : this.gpuEngine === 'metal' ? ['metal', 'wgpu'] : ['wgpu', 'metal']
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
    if (!binary) throw new Error('SAPIENT is not installed yet. Open Settings and choose Set up.')
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
