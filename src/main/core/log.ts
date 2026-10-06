import { appendFile, mkdir, readFile, rename, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * The app's debug log: one JSON object per line in <userData>/logs/exelsnap.log, so a user can
 * export it (Help ▸ Export Debug Log…) and send it in with a bug report.
 *
 * It records what the app did — start-up, settings, the model server, each question, the SQL the
 * model wrote, timings and every error — and deliberately not what is in the spreadsheets: query
 * results and cell values never go in, only row and column counts. Home-directory paths are
 * shortened to "~".
 *
 * Until `configureLog` is called (the headless CLI never calls it) logging does nothing.
 */

type Level = 'info' | 'warn' | 'error'

const MAX_BYTES = 5 * 1024 * 1024 // then exelsnap.log becomes exelsnap.1.log (one generation kept)
const MAX_STRING = 4000

let dir: string | null = null
let queue: Promise<unknown> = Promise.resolve()
let written = 0

const file = (n = '') => join(dir!, `exelsnap${n}.log`)

export function configureLog(logDir: string) {
  dir = logDir
  queue = mkdir(logDir, { recursive: true })
    .then(() => stat(file()))
    .then((s) => (written = s.size))
    .catch(() => {})
}

/** JSON-safe copy with long strings cut, errors flattened and the home directory hidden. */
function clean(value: unknown, depth = 0): unknown {
  if (value instanceof Error) return { name: value.name, message: clean(value.message), stack: clean(value.stack?.split('\n').slice(0, 8).join('\n')) }
  if (typeof value === 'string') {
    const s = value.split(homedir()).join('~')
    return s.length > MAX_STRING ? `${s.slice(0, MAX_STRING)}… (${s.length} characters)` : s
  }
  if (typeof value === 'bigint') return value.toString()
  if (value === null || typeof value !== 'object') return value
  if (depth > 5) return '[…]'
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => clean(v, depth + 1))
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clean(v, depth + 1)]))
}

function write(level: Level, scope: string, message: string, data?: unknown) {
  if (!dir) return
  let line: string
  try {
    line = JSON.stringify({ t: new Date().toISOString(), level, scope, message, ...(data === undefined ? {} : { data: clean(data) }) }) + '\n'
  } catch {
    line = JSON.stringify({ t: new Date().toISOString(), level, scope, message, data: '[unserialisable]' }) + '\n'
  }
  queue = queue
    .then(async () => {
      if (written > MAX_BYTES) {
        await rename(file(), file('.1')).catch(() => {})
        written = 0
      }
      await appendFile(file(), line)
      written += Buffer.byteLength(line)
    })
    .catch(() => {}) // a full disk must not take the app down
}

export const log = {
  info: (scope: string, message: string, data?: unknown) => write('info', scope, message, data),
  warn: (scope: string, message: string, data?: unknown) => write('warn', scope, message, data),
  error: (scope: string, message: string, data?: unknown) => write('error', scope, message, data)
}

/** Everything written so far (previous generation first), once pending writes have landed. */
export async function readLog(): Promise<string> {
  if (!dir) return ''
  await queue
  const parts = await Promise.all([file('.1'), file()].map((f) => readFile(f, 'utf8').catch(() => '')))
  return parts.join('')
}

export const logDirectory = () => dir
