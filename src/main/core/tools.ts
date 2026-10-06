import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { ChartSpec, ChartType, QueryResult, TableInfo } from '@shared/types'
import type { WorkbookSession } from './workbook'

/** Tool definitions for the AI SDK. No `execute`: the agent loop runs them so it can guard against loops and bad arguments. */
export const TOOLS = {
  run_sql: tool({
    description:
      'Run ONE read-only DuckDB SQL query over the spreadsheet tables and get the result rows. Use it for every number you report. The result is also shown to the user as a table.',
    inputSchema: z.object({ sql: z.string().describe('A single DuckDB SELECT query.') })
  }),
  make_chart: tool({
    description:
      'Draw a chart for the user from a DuckDB SQL query. The query should return one label/date column (x) and one or more numeric columns (y).',
    inputSchema: z.object({
      sql: z.string().describe('DuckDB SELECT query producing the chart data.'),
      type: z.enum(['bar', 'line', 'area', 'pie', 'scatter']),
      x: z.string().optional().describe('Result column for the x axis / pie labels.'),
      y: z.array(z.string()).optional().describe('Numeric result column(s) to plot.'),
      title: z.string().optional()
    })
  })
} satisfies ToolSet

export const TOOL_NAMES = Object.keys(TOOLS)

const MODEL_ROWS = 40 // rows of each result the model gets to read
const UI_ROWS = 500 // rows the user gets to see

export interface ToolOutcome {
  /** Text sent back to the model as the tool message. */
  forModel: string
  result?: QueryResult
  chart?: ChartSpec
  error?: string
}

/** Tool arguments as an object. Accepts what the SDK parsed, a JSON string, or (from small models) bare SQL. */
export function parseArgs(name: string, input: unknown): Record<string, unknown> {
  if (input && typeof input === 'object') return input as Record<string, unknown>
  const s = String(input ?? '').trim()
  if (!s) return {}
  try {
    const v = JSON.parse(s)
    return v && typeof v === 'object' ? v : { value: v }
  } catch {
    // Models occasionally pass bare SQL instead of JSON.
    if (name === 'run_sql' || name === 'make_chart') return { sql: s }
    return { raw: s }
  }
}

function fmtCell(v: unknown): string {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'number') return v.toLocaleString('en-US', { maximumFractionDigits: 4 })
  const s = String(v)
  return s.length > 60 ? s.slice(0, 57) + '…' : s
}

export function resultForModel(r: QueryResult): string {
  if (r.rowCount === 0) return 'The query returned 0 rows.'
  const lines = [r.columns.join(' | ')]
  for (const row of r.rows.slice(0, MODEL_ROWS)) lines.push(row.map(fmtCell).join(' | '))
  const shown = Math.min(r.rowCount, MODEL_ROWS)
  const more = r.truncated ? `more than ${r.rowCount}` : String(r.rowCount)
  lines.push(shown < r.rowCount || r.truncated ? `(${more} rows; first ${shown} shown — aggregate if you need all of them)` : `(${r.rowCount} row${r.rowCount === 1 ? '' : 's'})`)
  return lines.join('\n')
}

const NUMERIC_TYPE = /INT|DOUBLE|FLOAT|DECIMAL|REAL|NUMERIC|HUGEINT/i

function pickChart(args: Record<string, unknown>, r: QueryResult): ChartSpec {
  const type = (['bar', 'line', 'area', 'pie', 'scatter'] as ChartType[]).includes(args.type as ChartType)
    ? (args.type as ChartType)
    : 'bar'
  const find = (name: unknown) => r.columns.find((c) => c.toLowerCase() === String(name ?? '').toLowerCase())
  const numeric = r.columns.filter((_, i) => NUMERIC_TYPE.test(r.types[i]))
  const x = find(args.x) ?? r.columns.find((c) => !numeric.includes(c)) ?? r.columns[0]
  const yArg = Array.isArray(args.y) ? args.y : args.y != null ? [args.y] : []
  let y = yArg.map(find).filter((c): c is string => !!c && c !== x)
  if (y.length === 0) y = numeric.filter((c) => c !== x)
  if (y.length === 0) throw new Error(`The chart query needs at least one numeric column. Got columns: ${r.columns.join(', ')}`)
  return { type, x, y: type === 'pie' ? y.slice(0, 1) : y.slice(0, 8), title: typeof args.title === 'string' ? args.title : undefined }
}

export async function runTool(session: WorkbookSession, name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  try {
    if (session.tables.length === 0) throw new Error('No spreadsheet is attached yet. Ask the user to attach one.')
    switch (name) {
      case 'run_sql': {
        const result = await session.query(String(args.sql ?? ''), UI_ROWS)
        return { forModel: resultForModel(result), result }
      }
      case 'make_chart': {
        const result = await session.query(String(args.sql ?? ''), UI_ROWS)
        const chart = pickChart(args, result)
        return {
          forModel: `Chart shown to the user (${chart.type}: ${chart.y.join(', ')} by ${chart.x}). Data:\n${resultForModel(result)}`,
          result,
          chart
        }
      }
      default:
        throw new Error(`Unknown tool "${name}". Available tools: ${TOOL_NAMES.join(', ')}`)
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    return { forModel: `ERROR: ${error}\nFix the query and call the tool again.`, error }
  }
}

// ---------------------------------------------------------------- system prompt

const DETAILED_COLUMNS = 60
const LISTED_COLUMNS = 200

export function schemaText(tables: TableInfo[]): string {
  return tables
    .map((t) => {
      const head = `TABLE "${t.table}" — ${t.rowCount.toLocaleString('en-US')} rows (file ${t.file}, sheet "${t.sheet}")`
      const cols = t.columns.slice(0, DETAILED_COLUMNS).map((c) => {
        let line = `  "${c.name}" ${c.type}`
        if (c.header && c.header !== c.name) line += `  [header: "${c.header}"]`
        if (c.type === 'VARCHAR' || c.type === 'BOOLEAN') {
          const many = c.distinct >= 1000 ? '1000+' : String(c.distinct)
          const shown = c.samples.slice(0, 5)
          line += `  ${many} distinct${c.distinct > shown.length ? ` (only ${shown.length} shown)` : ''}: ${shown.map((s) => JSON.stringify(s)).join(', ')}`
        } else if (c.min !== undefined) {
          line += `  range ${c.min} … ${c.max}`
        }
        if (c.nulls > 0) line += `  (${c.nulls} empty)`
        return line
      })
      // Very wide sheets would fill a small model's context: the rest are listed by name and type only.
      const rest = t.columns.slice(DETAILED_COLUMNS)
      if (rest.length) {
        const listed = rest.slice(0, LISTED_COLUMNS).map((c) => `"${c.name}" ${c.type}`).join(', ')
        cols.push(`  … and ${rest.length} more columns: ${listed}${rest.length > LISTED_COLUMNS ? ', … (run DESCRIBE to see all)' : ''}`)
      }
      const notes = t.notes.map((n) => `  note: ${n}`)
      return [head, ...cols, ...notes].join('\n')
    })
    .join('\n\n')
}

export function systemPrompt(tables: TableInfo[]): string {
  // Local calendar date (toISOString is UTC, which is yesterday for part of the day east of Greenwich).
  const today = new Date().toLocaleDateString('en-CA')
  const data =
    tables.length > 0
      ? `The user's spreadsheets are loaded as DuckDB tables:\n\n${schemaText(tables)}`
      : 'No spreadsheet is attached yet. If the user asks about data, tell them to attach an Excel or CSV file with the + button or by dragging it into the window.'
  return `You are ExelSnap, a careful data analyst that answers questions about the user's spreadsheets. Everything runs offline on the user's computer. Today is ${today}.

${data}

How to work:
- Never guess or invent numbers, names or any other value. Everything you state must come from a run_sql result in this conversation.
- The table description above shows only a few example values per column, NOT the data. To list, count, find, name or check anything, query it with run_sql first.
- Use only the tables and columns listed above. Wrap column names in double quotes.
- For an overview ("what is this?", "summarise this") look at the rows first: SELECT * FROM the table LIMIT 20, then say what one row represents, what each column holds and how many rows there are.
- Each run_sql call takes ONE DuckDB SELECT query. For totals and comparisons use aggregates (SUM, AVG, COUNT, GROUP BY, ORDER BY).
- When the user asks to list or show rows, select every matching row. Never add LIMIT unless the user asks for a top N.
- To change the data (filter, sort, remove duplicates, add or clean a column, combine sheets or files) write a SELECT that returns the new version. The user can save any result as an Excel file with the Export button under it; mention that only when they asked for a changed, filtered or new version of the data.
- Dates: use date_trunc('month', "col"), strftime, EXTRACT(year FROM "col").
- A VARCHAR column that holds numbers or dates mixed with text: convert with TRY_CAST("col" AS DOUBLE) or try_strptime("col", '%d/%m/%Y').
- If a query fails, read the error, fix the query and try again.
- Use make_chart when the user asks for a chart, plot or graph, or when a trend over time is clearer as a picture.
- The user already sees every query result as a table right above your answer, so never re-type a result as a table. Answer in a few sentences of Markdown with the key numbers in **bold**; write out a list of values only when the user asked for a list.`
}
