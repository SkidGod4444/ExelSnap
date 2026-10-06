import { readFile, stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { randomUUID } from 'node:crypto'
import * as XLSX from 'xlsx'
import {
  DuckDBInstance,
  DuckDBConnection,
  DuckDBAppender,
  dateValue,
  timestampValue
} from '@duckdb/node-api'
import type { Attachment, Cell, ColumnInfo, ColumnType, QueryResult, TableInfo } from '@shared/types'
import { guardSql, isWrappable } from './sql'

export const SUPPORTED_EXTENSIONS = ['.xlsx', '.xlsm', '.xlsb', '.xls', '.ods', '.csv', '.tsv']

const NULL_TOKENS = new Set(['', '-', '--', 'n/a', 'na', '#n/a', 'null', 'none', 'nil', '#div/0!', '#value!', '#ref!', '#num!', '#name?'])
const RESERVED = new Set([
  'select', 'from', 'where', 'group', 'order', 'by', 'limit', 'table', 'join', 'on', 'as', 'and', 'or', 'not',
  'null', 'case', 'when', 'then', 'else', 'end', 'having', 'union', 'all', 'default', 'check', 'primary', 'key',
  'references', 'in', 'is', 'like', 'between', 'distinct', 'offset', 'with', 'to', 'using', 'window', 'over'
])
const DISTINCT_CAP = 1000
const QUERY_TIMEOUT_MS = 30_000

type Raw = string | number | boolean | Date | null

export function toIdentifier(text: string, fallback: string): string {
  let id = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/%/g, ' pct ')
    .replace(/#/g, ' num ')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  if (!id) id = fallback
  if (/^[0-9]/.test(id)) id = `c_${id}`
  if (RESERVED.has(id)) id = `${id}_`
  return id.slice(0, 63)
}

function uniqueName(base: string, taken: Set<string>): string {
  let name = base
  for (let i = 2; taken.has(name); i++) name = `${base}_${i}`
  taken.add(name)
  return name
}

function parseNumericString(s: string): number | null {
  const t = s.trim()
  if (!/[0-9]/.test(t)) return null
  // Accept "1,234.5", "$1,234", "(250)", "12.5%", "€ 99" — common spreadsheet text-numbers.
  const negative = /^\(.*\)$/.test(t) || t.startsWith('-')
  const pct = t.endsWith('%')
  const cleaned = t.replace(/[()$€£₹¥,%\s]/g, '').replace(/^-/, '')
  if (!/^\d*\.?\d+(e[+-]?\d+)?$/i.test(cleaned)) return null
  let n = Number(cleaned)
  if (!Number.isFinite(n)) return null
  if (pct) n /= 100
  return negative ? -n : n
}

function isNullish(v: Raw): boolean {
  return v === null || (typeof v === 'string' && NULL_TOKENS.has(v.trim().toLowerCase()))
}

function isMidnight(d: Date): boolean {
  return d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0 && d.getMilliseconds() === 0
}

/** SheetJS builds Dates in local time; keep the wall-clock value the user sees in Excel. */
function wallClockMicros(d: Date): bigint {
  const ms = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds())
  return BigInt(ms) * 1000n
}

function fmtDate(d: Date, withTime: boolean): string {
  const p = (n: number) => String(n).padStart(2, '0')
  const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  return withTime ? `${date} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` : date
}

function fmtNumber(n: number): string {
  return Number.isInteger(n) ? n.toLocaleString('en-US') : n.toLocaleString('en-US', { maximumFractionDigits: 4 })
}

interface PreparedColumn {
  info: ColumnInfo
  values: (string | number | boolean | Date | null)[]
}

function inferColumn(name: string, header: string, raw: Raw[]): PreparedColumn {
  let nums = 0, numericStrings = 0, bools = 0, dates = 0, strings = 0, nonNull = 0
  for (const v of raw) {
    if (isNullish(v)) continue
    nonNull++
    if (typeof v === 'number') nums++
    else if (typeof v === 'boolean') bools++
    else if (v instanceof Date) dates++
    else if (typeof v === 'string') {
      if (parseNumericString(v) !== null) numericStrings++
      else strings++
    }
  }

  let type: ColumnType = 'VARCHAR'
  if (nonNull === 0) type = 'VARCHAR'
  else if (bools === nonNull) type = 'BOOLEAN'
  else if (dates === nonNull) type = raw.every((v) => !(v instanceof Date) || isMidnight(v)) ? 'DATE' : 'TIMESTAMP'
  else if (nums + numericStrings === nonNull && strings === 0) {
    const allInt = raw.every((v) => {
      if (isNullish(v)) return true
      const n = typeof v === 'number' ? v : parseNumericString(String(v))
      return n !== null && Number.isSafeInteger(n)
    })
    type = allInt ? 'BIGINT' : 'DOUBLE'
  }

  const values = raw.map((v): string | number | boolean | Date | null => {
    if (type === 'VARCHAR') {
      if (v === null) return null
      if (v instanceof Date) return fmtDate(v, !isMidnight(v))
      const s = String(v).trim()
      return s === '' ? null : s
    }
    if (isNullish(v)) return null
    if (type === 'BIGINT' || type === 'DOUBLE') return typeof v === 'number' ? v : parseNumericString(String(v))
    return v as boolean | Date
  })

  // Column profile for the model's schema summary.
  const counts = new Map<string, number>()
  let nulls = 0
  let min: number | Date | undefined
  let max: number | Date | undefined
  for (const v of values) {
    if (v === null) { nulls++; continue }
    if (typeof v === 'number' || v instanceof Date) {
      if (min === undefined || v < min) min = v
      if (max === undefined || v > max) max = v
    }
    const key = v instanceof Date ? fmtDate(v, type === 'TIMESTAMP') : String(v)
    if (counts.size < DISTINCT_CAP || counts.has(key)) counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const fmt = (x: number | Date | undefined) =>
    x === undefined ? undefined : x instanceof Date ? fmtDate(x, type === 'TIMESTAMP') : fmtNumber(x)
  const samples =
    type === 'VARCHAR' || type === 'BOOLEAN'
      ? [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k]) => (k.length > 40 ? k.slice(0, 37) + '…' : k))
      : [...counts.keys()].slice(0, 3)

  return {
    info: { name, header, type, nulls, distinct: counts.size, min: fmt(min), max: fmt(max), samples },
    values
  }
}

/** Pick the header row: first of the top rows that is mostly filled with text. */
function findHeaderRow(rows: Raw[][]): number {
  const width = Math.max(...rows.slice(0, 20).map((r) => r.filter((v) => v !== null).length), 0)
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const filled = rows[i].filter((v) => v !== null)
    const texts = filled.filter((v) => typeof v === 'string' && parseNumericString(v) === null)
    if (filled.length >= Math.max(1, Math.ceil(width * 0.5)) && texts.length >= filled.length * 0.6) return i
  }
  return 0
}

function appendValue(app: DuckDBAppender, type: ColumnType, v: string | number | boolean | Date | null) {
  if (v === null) return app.appendNull()
  switch (type) {
    case 'BIGINT': return app.appendBigInt(BigInt(v as number))
    case 'DOUBLE': return app.appendDouble(v as number)
    case 'BOOLEAN': return app.appendBoolean(v as boolean)
    case 'DATE': {
      const d = v as Date
      return app.appendDate(dateValue({ year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() }))
    }
    case 'TIMESTAMP': return app.appendTimestamp(timestampValue(wallClockMicros(v as Date)))
    default: return app.appendVarchar(String(v))
  }
}

function toCell(v: unknown): Cell {
  if (v === null || v === undefined) return null
  if (typeof v === 'bigint') return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString()
  if (typeof v === 'number') return Number.isFinite(v) ? v : String(v)
  if (typeof v === 'string' || typeof v === 'boolean') return v
  if (v instanceof Date) {
    const iso = v.toISOString()
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.replace('T', ' ').replace(/\.000Z$|Z$/, '')
  }
  if (v instanceof Uint8Array) return `<${v.length} bytes>`
  return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x))
}

/**
 * One in-memory DuckDB database per conversation. Spreadsheets are parsed in JS (SheetJS) and
 * appended as typed tables; afterwards the database is locked down so model-written SQL can only
 * read those tables (no file / network access, no config changes).
 */
export class WorkbookSession {
  private constructor(private instance: DuckDBInstance, private conn: DuckDBConnection) {}
  readonly attachments = new Map<string, Attachment>()

  static async create(): Promise<WorkbookSession> {
    const instance = await DuckDBInstance.create(':memory:', { threads: '4' })
    const conn = await instance.connect()
    await conn.run(`SET autoinstall_known_extensions = false`)
    await conn.run(`SET autoload_known_extensions = false`)
    await conn.run(`SET enable_external_access = false`)
    await conn.run(`SET lock_configuration = true`)
    return new WorkbookSession(instance, conn)
  }

  get tables(): TableInfo[] {
    return [...this.attachments.values()].flatMap((a) => a.tables)
  }

  async addFile(path: string, id: string = randomUUID()): Promise<Attachment> {
    const name = basename(path)
    const att: Attachment = { id, path, name, size: 0, tables: [], status: 'loading' }
    try {
      const ext = extname(path).toLowerCase()
      if (!SUPPORTED_EXTENSIONS.includes(ext)) throw new Error(`Unsupported file type "${ext || name}". Use .xlsx, .xls, .csv or .ods.`)
      att.size = (await stat(path)).size
      const buf = await readFile(path)
      const wb = XLSX.read(buf, { type: 'buffer', cellDates: true, dense: true, FS: ext === '.tsv' ? '\t' : undefined })
      const taken = new Set(this.tables.map((t) => t.table))
      const stem = toIdentifier(basename(path, ext), 'data')

      for (const sheetName of wb.SheetNames) {
        const ws = wb.Sheets[sheetName]
        if (!ws) continue
        const rows = XLSX.utils.sheet_to_json<Raw[]>(ws, { header: 1, raw: true, defval: null, blankrows: false })
        const info = await this.loadSheet(rows, {
          file: name,
          sheet: sheetName,
          tableBase: wb.SheetNames.length === 1 && /^sheet\s?1$/i.test(sheetName) ? stem : toIdentifier(sheetName, stem),
          stem,
          taken
        })
        if (info) att.tables.push(info)
      }
      if (att.tables.length === 0) throw new Error('No data found in this file.')
      att.status = 'ready'
    } catch (err) {
      att.status = 'error'
      att.error = err instanceof Error ? err.message : String(err)
      await this.dropTables(att)
      att.tables = []
    }
    this.attachments.set(att.id, att)
    return att
  }

  private async loadSheet(
    rows: Raw[][],
    o: { file: string; sheet: string; tableBase: string; stem: string; taken: Set<string> }
  ): Promise<TableInfo | null> {
    if (rows.length === 0) return null
    const width = Math.max(...rows.map((r) => r.length))
    const headerIdx = findHeaderRow(rows)
    const headerRow = rows[headerIdx] ?? []
    let body = rows.slice(headerIdx + 1)
    const notes: string[] = []
    if (headerIdx > 0) notes.push('Title rows above the header were skipped')

    // Drop a trailing "Total" row so sums aren't double counted.
    const last = body[body.length - 1]
    const firstText = last?.find((v) => typeof v === 'string')
    if (last && typeof firstText === 'string' && /^\s*(grand\s+)?totals?\b/i.test(firstText)) {
      body = body.slice(0, -1)
      notes.push('Skipped a trailing "Total" row')
    }
    if (body.length === 0) return null

    const names = new Set<string>()
    const columns: PreparedColumn[] = []
    for (let c = 0; c < width; c++) {
      const header = headerRow[c] == null ? '' : headerRow[c] instanceof Date ? fmtDate(headerRow[c] as Date, false) : String(headerRow[c]).trim()
      const raw = body.map((r) => (r[c] === undefined ? null : r[c]))
      if (!header && raw.every((v) => v === null)) continue
      const name = uniqueName(toIdentifier(header, `column_${c + 1}`), names)
      columns.push(inferColumn(name, header || `(column ${c + 1})`, raw))
    }
    if (columns.length === 0) return null

    let table = o.tableBase
    if (o.taken.has(table)) table = `${o.stem}_${table}`
    table = uniqueName(table, o.taken)

    const ddl = columns.map((c) => `"${c.info.name}" ${c.info.type}`).join(', ')
    await this.conn.run(`CREATE TABLE "${table}" (${ddl})`)
    const app = await this.conn.createAppender(table)
    for (let r = 0; r < body.length; r++) {
      for (const col of columns) appendValue(app, col.info.type, col.values[r])
      app.endRow()
    }
    app.flushSync()
    app.closeSync()

    return { table, file: o.file, sheet: o.sheet, rowCount: body.length, columns: columns.map((c) => c.info), notes }
  }

  private async dropTables(att: Attachment) {
    for (const t of att.tables) await this.conn.run(`DROP TABLE IF EXISTS "${t.table}"`).catch(() => {})
  }

  async removeAttachment(id: string) {
    const att = this.attachments.get(id)
    if (!att) return
    await this.dropTables(att)
    this.attachments.delete(id)
  }

  /** Run model- or user-written read-only SQL. Returns at most `maxRows` rows. */
  async query(sql: string, maxRows = 500): Promise<QueryResult> {
    const clean = guardSql(sql)
    const text = isWrappable(clean) ? `SELECT * FROM (\n${clean}\n) AS q LIMIT ${maxRows + 1}` : clean
    const timer = setTimeout(() => this.conn.interrupt(), QUERY_TIMEOUT_MS)
    try {
      const reader = await this.conn.runAndReadAll(text)
      const all = reader.getRowsJS()
      const truncated = all.length > maxRows
      const rows = all.slice(0, maxRows).map((r) => r.map(toCell))
      return {
        columns: reader.columnNames(),
        types: reader.columnTypes().map((t) => t.toString()),
        rows,
        rowCount: rows.length,
        truncated
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (/interrupt/i.test(msg)) throw new Error(`Query took longer than ${QUERY_TIMEOUT_MS / 1000}s and was cancelled.`)
      throw new Error(msg.replace(/^Error:\s*/, ''))
    } finally {
      clearTimeout(timer)
    }
  }

  async preview(table: string, limit = 200): Promise<QueryResult> {
    if (!this.tables.some((t) => t.table === table)) throw new Error(`Unknown table ${table}`)
    return this.query(`SELECT * FROM "${table}"`, limit)
  }

  close() {
    try {
      this.conn.closeSync()
      this.instance.closeSync()
    } catch {
      /* already closed */
    }
  }
}
