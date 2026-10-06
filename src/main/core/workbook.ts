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
  'references', 'in', 'is', 'like', 'between', 'distinct', 'offset', 'with', 'to', 'using', 'window', 'over',
  // Words the read-only guard (sql.ts) rejects: a file called export.csv or a column called "Load" must stay queryable unquoted.
  'insert', 'update', 'delete', 'drop', 'create', 'alter', 'attach', 'detach', 'copy', 'export', 'import', 'install', 'load',
  'pragma', 'set', 'reset', 'call', 'checkpoint', 'vacuum', 'use', 'begin', 'commit', 'rollback', 'truncate', 'grant', 'revoke', 'merge'
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
    .replace(/[^\p{L}\p{N}]+/gu, '_')
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

/** Accepts "1,234.5", "$1,234", "(250)", "12.5%", "€ 99" — common spreadsheet text-numbers. `decimalComma`: "1.234,56". */
function parseNumericString(s: string, decimalComma = false): number | null {
  const t = s.trim()
  if (!/[0-9]/.test(t)) return null
  const negative = /^\(.*\)$/.test(t) || t.startsWith('-')
  const pct = t.endsWith('%')
  const bare = t.replace(/[()$€£₹¥%\s]/g, '').replace(/^-/, '')
  const cleaned = decimalComma ? bare.replace(/\./g, '').replace(',', '.') : bare.replace(/,/g, '')
  if (!/^\d*\.?\d+(e[+-]?\d+)?$/i.test(cleaned)) return null
  let n = Number(cleaned)
  if (!Number.isFinite(n)) return null
  if (pct) n /= 100
  return negative ? -n : n
}

/** Digits that are an identifier, not a quantity: leading zeros ("00123", zip codes) or too long for a number. */
function isCodeLike(s: string): boolean {
  const t = s.trim()
  return /^0\d+$/.test(t) || /^\d{16,}$/.test(t)
}

/**
 * Whether a column's text numbers use a decimal comma ("1.234,56", "99,90"). Decided for the whole
 * column: "1,234" on its own is ambiguous and stays a thousands separator.
 */
function usesDecimalComma(values: Raw[]): boolean {
  let evidence = false
  for (const v of values) {
    if (typeof v !== 'string') continue
    const t = v.trim().replace(/[()$€£₹¥%\s]/g, '').replace(/^-/, '')
    if (!/[0-9]/.test(t)) continue
    if (!/^(\d{1,3}(\.\d{3})+|\d+)(,\d+)?$/.test(t)) return false
    if (/,\d{1,2}$|,\d{4,}$/.test(t) || (t.includes('.') && t.includes(','))) evidence = true
  }
  return evidence
}

const ISO_DATE = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?Z?)?$/
const DAY_MONTH_DATE = /^(\d{1,2})([./-])(\d{1,2})\2(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/
type DateOrder = 'iso' | 'dmy' | 'mdy'

/** How a column of text dates is written, 'ambiguous' when day and month can't be told apart, null when it isn't dates. */
function textDateOrder(values: Raw[]): DateOrder | 'ambiguous' | null {
  const texts = values.filter((v): v is string => typeof v === 'string' && !NULL_TOKENS.has(v.trim().toLowerCase())).map((v) => v.trim())
  if (texts.length === 0) return null
  if (texts.every((t) => ISO_DATE.test(t))) return 'iso'
  let firstOver12 = false, secondOver12 = false, dots = true
  for (const t of texts) {
    const m = DAY_MONTH_DATE.exec(t)
    if (!m) return null
    if (Number(m[1]) > 12) firstOver12 = true
    if (Number(m[3]) > 12) secondOver12 = true
    if (m[2] !== '.') dots = false
  }
  if (firstOver12 && secondOver12) return null
  if (firstOver12) return 'dmy'
  if (secondOver12) return 'mdy'
  return dots ? 'dmy' : 'ambiguous' // 31.01.2025 style is always day first
}

/** Local-time Date like the ones SheetJS produces, or null for an impossible date (31/02). */
function parseTextDate(text: string, order: DateOrder): Date | null {
  const t = text.trim()
  const m = order === 'iso' ? ISO_DATE.exec(t) : DAY_MONTH_DATE.exec(t)
  if (!m) return null
  const [y, mo, d] =
    order === 'iso' ? [Number(m[1]), Number(m[2]), Number(m[3])] : order === 'dmy' ? [Number(m[4]), Number(m[3]), Number(m[1])] : [Number(m[4]), Number(m[1]), Number(m[3])]
  const [h, mi, sec] = order === 'iso' ? [m[4], m[5], m[6]] : [m[5], m[6], m[7]]
  const date = new Date(y, mo - 1, d, Number(h ?? 0), Number(mi ?? 0), Number(sec ?? 0))
  return date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d ? date : null
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
  /** Something about this column the model should know (shown in the schema). */
  note?: string
}

const BOOLEAN_TEXT = /^(true|false)$/i

function inferColumn(name: string, header: string, input: Raw[]): PreparedColumn {
  let raw = input
  let note: string | undefined
  const texts = raw.filter((v): v is string => typeof v === 'string' && !isNullish(v))
  const onlyText = texts.length > 0 && raw.every((v) => typeof v === 'string' || isNullish(v))
  if (onlyText && texts.every((t) => BOOLEAN_TEXT.test(t.trim()))) {
    // CSV files spell booleans out.
    raw = raw.map((v) => (isNullish(v) ? null : String(v).trim().toLowerCase() === 'true'))
  } else if (onlyText) {
    // Dates typed as text (every date in a CSV is).
    const order = textDateOrder(raw)
    if (order === 'ambiguous') {
      note = `"${name}" holds dates as text but day/month order is unclear; convert with strptime("${name}", '%d/%m/%Y') or '%m/%d/%Y'`
    } else if (order) {
      const parsed = raw.map((v) => (isNullish(v) ? null : parseTextDate(String(v), order)))
      if (parsed.every((d, i) => d !== null || isNullish(raw[i]))) raw = parsed
    }
  }

  const decimalComma = usesDecimalComma(raw)
  const toNumber = (v: Raw) => (typeof v === 'number' ? v : parseNumericString(String(v), decimalComma))
  let nums = 0, numericStrings = 0, bools = 0, dates = 0, strings = 0, nonNull = 0
  for (const v of raw) {
    if (isNullish(v)) continue
    nonNull++
    if (typeof v === 'number') nums++
    else if (typeof v === 'boolean') bools++
    else if (v instanceof Date) dates++
    else if (typeof v === 'string') {
      if (!isCodeLike(v) && parseNumericString(v, decimalComma) !== null) numericStrings++
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
      const n = toNumber(v)
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
    if (type === 'BIGINT' || type === 'DOUBLE') return toNumber(v)
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
    values,
    note
  }
}

const filled = (row: Raw[]) => row.filter((v) => v !== null)
const isBlank = (row: Raw[]) => row.every((v) => v === null)
const isLabel = (v: Raw) => typeof v === 'string' && parseNumericString(v) === null

/** Pick the header row: first of the top rows that is mostly filled with text. */
function findHeaderRow(rows: Raw[][]): number {
  let width = 0
  for (const r of rows.slice(0, 20)) width = Math.max(width, filled(r).length)
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const cells = filled(rows[i])
    if (cells.length >= Math.max(1, Math.ceil(width * 0.5)) && cells.filter(isLabel).length >= cells.length * 0.6) return i
  }
  return 0
}

/** Give every cell of a merged range the range's value, so merged headers and category labels cover their columns/rows. */
function fillMerges(ws: XLSX.WorkSheet, rows: Raw[][]) {
  const merges = ws['!merges']
  if (!merges?.length || !ws['!ref']) return
  const origin = XLSX.utils.decode_range(ws['!ref']).s
  for (const m of merges) {
    const value = rows[m.s.r - origin.r]?.[m.s.c - origin.c] ?? null
    if (value === null) continue
    for (let r = m.s.r; r <= m.e.r; r++) {
      const row = rows[r - origin.r]
      if (!row) continue
      for (let c = m.s.c; c <= m.e.c; c++) if (row[c - origin.c] == null) row[c - origin.c] = value
    }
  }
}

/**
 * A sheet can hold several tables stacked with blank rows between them. Start a new table only when
 * the row after the gap is all labels and sits over a column that held numbers or dates so far —
 * a blank spacer row inside one table never does that.
 */
function splitTables(rows: Raw[][]): Raw[][][] {
  const tables: Raw[][][] = []
  let current: Raw[][] = []
  let gap = false
  for (const row of rows) {
    if (isBlank(row)) {
      gap = current.length > 0
      continue
    }
    if (gap && current.length >= 2) {
      const cells = filled(row)
      const startsTable =
        cells.length >= 2 &&
        cells.every(isLabel) &&
        row.some((v, c) => {
          if (v === null) return false
          const above = current.slice(1).map((r) => r[c] ?? null).filter((x) => x !== null)
          return above.length > 0 && above.filter((x) => typeof x === 'number' || x instanceof Date).length >= above.length * 0.6
        })
      if (startsTable) {
        tables.push(current)
        current = []
      }
    }
    gap = false
    current.push(row)
  }
  if (current.length) tables.push(current)
  return tables
}

const TOTAL_LABEL = /\b(sub\s*-?\s*)?totals?\s*:?\s*$/i
const TOTAL_PREFIX = /^\s*(grand\s+|sub\s*-?\s*)?totals?\b/i
const FOOTER_START = /^\s*(\*|source|sources|note|notes|generated|printed|prepared|exported|confidential|page\b)/i

/** `"a", "b", "c" and 4 more` — for notes that name what was left out. */
function quoteList(items: string[], max = 3): string {
  const short = items.slice(0, max).map((t) => JSON.stringify(t.length > 40 ? t.slice(0, 37) + '…' : t))
  return short.join(', ') + (items.length > max ? ` and ${items.length - max} more` : '')
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

const EXCEL_MAX_ROWS = 1_048_575 // sheet limit, minus the header row

/** A query result as an .xlsx file: numbers stay numbers and DATE/TIMESTAMP columns become real Excel dates. */
export function resultToXlsx(result: QueryResult): Buffer {
  const temporal = result.types.map((t) => /^(DATE|TIMESTAMP)/i.test(t))
  const rows = result.rows.map((row) =>
    row.map((v, c) => {
      if (!temporal[c] || typeof v !== 'string') return v
      const d = new Date(v.replace(' ', 'T') + (v.length <= 10 ? 'T00:00:00Z' : 'Z'))
      return Number.isNaN(d.getTime()) ? v : d
    })
  )
  const ws = XLSX.utils.aoa_to_sheet([result.columns, ...rows], { cellDates: true, UTC: true })
  ws['!cols'] = result.columns.map((name, c) => {
    let width = name.length
    for (const row of result.rows.slice(0, 200)) width = Math.max(width, String(row[c] ?? '').length)
    return { wch: Math.min(Math.max(width + 2, 8), 60) }
  })
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Result')
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', compression: true }) as Buffer
}

/** A query result as CSV, with a UTF-8 byte-order mark so Excel reads accented text correctly. */
export function resultToCsv(result: QueryResult): string {
  const esc = (v: unknown) => {
    if (v === null || v === undefined) return ''
    const s = String(v)
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return '\uFEFF' + [result.columns.map(esc).join(','), ...result.rows.map((r) => r.map(esc).join(','))].join('\r\n')
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
      const text = ext === '.csv' || ext === '.tsv'
      // Text files are read as plain strings so that number and date formats are decided per column here
      // (SheetJS would guess cell by cell and read "1.234,56" as 1.234).
      const wb = XLSX.read(buf, { type: 'buffer', cellDates: true, dense: true, raw: text, FS: ext === '.tsv' ? '\t' : undefined })
      const taken = new Set(this.tables.map((t) => t.table))
      const stem = toIdentifier(basename(path, ext), 'data')

      for (const [index, sheetName] of wb.SheetNames.entries()) {
        const ws = wb.Sheets[sheetName]
        if (!ws) continue
        const rows = XLSX.utils.sheet_to_json<Raw[]>(ws, { header: 1, raw: true, defval: null, blankrows: true })
        fillMerges(ws, rows)
        const sheetNotes: string[] = []
        if (wb.Workbook?.Sheets?.[index]?.Hidden) sheetNotes.push('This sheet is hidden in the workbook')
        // Formulas are not recalculated here; a file written by a script may carry no saved results.
        let unsaved = 0
        for (const row of (ws['!data'] ?? []) as (XLSX.CellObject | undefined)[][]) for (const cell of row ?? []) if (cell?.f && cell.v === undefined) unsaved++
        if (unsaved) sheetNotes.push(`${unsaved} formula cell${unsaved === 1 ? ' has' : 's have'} no saved result and read as empty; open and save the file in Excel to recalculate`)

        const tableBase = wb.SheetNames.length === 1 && /^sheet\s?1$/i.test(sheetName) ? stem : toIdentifier(sheetName, stem)
        const blocks = splitTables(rows)
        for (const [b, block] of blocks.entries()) {
          const info = await this.loadSheet(block, {
            file: name,
            sheet: sheetName,
            tableBase: b === 0 ? tableBase : `${tableBase}_${b + 1}`,
            stem,
            taken,
            notes: blocks.length > 1 ? [...sheetNotes, `Table ${b + 1} of ${blocks.length} found on this sheet`] : sheetNotes
          })
          if (info) att.tables.push(info)
        }
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
    o: { file: string; sheet: string; tableBase: string; stem: string; taken: Set<string>; notes: string[] }
  ): Promise<TableInfo | null> {
    if (rows.length === 0) return null
    let width = 0
    for (const r of rows) if (r.length > width) width = r.length // not Math.max(...): a big sheet overflows the call stack
    const headerIdx = findHeaderRow(rows)
    const headerRow = [...(rows[headerIdx] ?? [])]
    let body = rows.slice(headerIdx + 1)
    const notes = [...o.notes]

    // Two-row headers ("2024" spanning "Q1 | Q2"): the lower row alone has blank or repeated names.
    const text = (v: Raw) => (v == null ? '' : v instanceof Date ? fmtDate(v, false) : String(v).trim())
    const names = headerRow.map(text)
    const group = headerIdx > 0 ? rows[headerIdx - 1] : undefined
    const grouped = !!group && filled(group).length >= 2 && (names.slice(0, width).some((n) => !n) || new Set(names.filter(Boolean)).size < names.filter(Boolean).length)
    if (grouped) {
      let carry = ''
      for (let c = 0; c < width; c++) {
        const top = text(group![c] ?? null)
        if (top) carry = top
        if (!names[c]) names[c] = top
        else if (carry && carry !== names[c]) names[c] = `${carry} ${names[c]}`
      }
    }
    if (headerIdx > (grouped ? 1 : 0)) notes.push('Title rows above the header were skipped')

    // Footer lines under the data ("Source: ERP export …"): a lone piece of prose in an otherwise empty row.
    const footers: string[] = []
    for (;;) {
      const last = body[body.length - 1]
      const cells = last ? filled(last) : []
      const only = cells[0]
      if (!(width >= 3 && body.length > 1 && cells.length === 1 && typeof only === 'string' && isLabel(only) && (only.trim().length >= 20 || FOOTER_START.test(only)))) break
      footers.unshift(only.trim())
      body = body.slice(0, -1)
    }
    if (footers.length) notes.push(`Left out ${footers.length} footer row${footers.length === 1 ? '' : 's'} below the data: ${quoteList(footers)}`)

    // Total and subtotal rows would be counted twice. A row is only treated as one when it is labelled
    // "… total" AND one of its numbers really is the sum of the rows above it — a line item that just
    // happens to be called "Order total" stays.
    const number = (v: Raw) => (typeof v === 'number' ? v : typeof v === 'string' ? parseNumericString(v) : null)
    const kept: Raw[][] = []
    const totals: string[] = []
    let groupStart = 0
    for (const row of body) {
      const label = row.find((v) => typeof v === 'string')
      if (typeof label === 'string' && kept.length > 0 && (TOTAL_LABEL.test(label) || TOTAL_PREFIX.test(label))) {
        const sumsRowsFrom = (from: number) =>
          row.some((v, c) => {
            const value = number(v)
            if (value === null) return false
            let sum = 0
            let count = 0
            for (let r = from; r < kept.length; r++) {
              const x = number(kept[r][c] ?? null)
              if (x !== null) {
                sum += x
                count++
              }
            }
            return count > 0 && Math.abs(sum - value) <= Math.max(0.011, Math.abs(sum) * 1e-9)
          })
        if (sumsRowsFrom(groupStart) || sumsRowsFrom(0)) {
          totals.push(label.trim())
          groupStart = kept.length
          continue
        }
      }
      kept.push(row)
    }
    body = kept
    if (totals.length) notes.push(`Left out ${totals.length} total row${totals.length === 1 ? '' : 's'} (${quoteList(totals)}): each equals the sum of the rows above it, so keeping it would double count`)
    if (body.length === 0) return null

    const taken = new Set<string>()
    const columns: PreparedColumn[] = []
    for (let c = 0; c < width; c++) {
      const header = names[c] ?? ''
      const raw = body.map((r) => (r[c] === undefined ? null : r[c]))
      if (!header && raw.every((v) => v === null)) continue
      const column = inferColumn(uniqueName(toIdentifier(header, `column_${c + 1}`), taken), header || `(column ${c + 1})`, raw)
      if (column.note) notes.push(column.note)
      columns.push(column)
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

  /** The whole result of a query, for exporting (up to what one Excel sheet can hold). */
  queryAll(sql: string): Promise<QueryResult> {
    return this.query(sql, EXCEL_MAX_ROWS)
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
