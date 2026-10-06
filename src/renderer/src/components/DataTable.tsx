import { useState } from 'react'
import { Check, Copy, Download } from 'lucide-react'
import type { QueryResult, ResultSource } from '@shared/types'
import { formatCell, NUMERIC_TYPE, toTsv } from '../lib/format'
import { useCopy } from '../lib/hooks'

const INITIAL_ROWS = 100

export function DataTable({
  result,
  name = 'query-result',
  tall = false,
  showTypes = false,
  footer = true,
  source
}: {
  result: QueryResult
  name?: string
  tall?: boolean
  showTypes?: boolean
  footer?: boolean
  /** Lets the export re-run the query in full instead of saving only the rows shown. */
  source?: ResultSource
}) {
  const [all, setAll] = useState(false)
  const [copied, copy] = useCopy()
  const rows = all ? result.rows : result.rows.slice(0, INITIAL_ROWS)
  const numeric = result.types.map((t) => NUMERIC_TYPE.test(t))

  if (result.columns.length === 0) return null
  return (
    <div className="data-card">
      <div className={`data-scroll${tall ? ' tall' : ''}`}>
        <table className="data-table">
          <thead>
            <tr>
              <th className="rownum" />
              {result.columns.map((c, i) => (
                <th key={i} className={numeric[i] ? 'num' : undefined}>
                  {c}
                  {showTypes && <span className="col-type">{result.types[i]}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={ri}>
                <td className="rownum">{ri + 1}</td>
                {r.map((v, ci) => (
                  <td key={ci} className={[numeric[ci] ? 'num' : '', v === null ? 'null' : ''].join(' ').trim() || undefined} title={v === null ? undefined : String(v)}>
                    {formatCell(v)}
                  </td>
                ))}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td className="rownum" />
                <td colSpan={result.columns.length} className="null">
                  No rows
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {footer && (
        <div className="data-foot">
          <span className="grow">
            {result.truncated ? `First ${result.rowCount.toLocaleString()} rows` : `${result.rowCount.toLocaleString()} row${result.rowCount === 1 ? '' : 's'}`}
            {' · '}
            {result.columns.length} column{result.columns.length === 1 ? '' : 's'}
          </span>
          {result.rows.length > INITIAL_ROWS && (
            <button className="chip-btn" onClick={() => setAll(!all)}>
              {all ? 'Show less' : `Show all ${result.rows.length.toLocaleString()}`}
            </button>
          )}
          <button className="chip-btn" onClick={() => copy(toTsv(result.columns, result.rows))} title="Copy as TSV — pastes straight into Excel">
            {copied ? <Check size={14} /> : <Copy size={14} />}
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button className="chip-btn" onClick={() => void window.api.exportData(name, result, source)} title="Save all rows as an Excel workbook or CSV">
            <Download size={14} />
            Export
          </button>
        </div>
      )}
    </div>
  )
}
