import { useMemo, useState } from 'react'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell as PieCell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts'
import { ChartColumn, Download, Table2 } from 'lucide-react'
import type { ChartSpec, QueryResult } from '@shared/types'
import { formatAxis, formatCell } from '../lib/format'
import { useCssVars } from '../lib/hooks'
import { DataTable } from './DataTable'

const VARS = ['--series-1', '--series-2', '--series-3', '--series-4', '--series-5', '--series-6', '--series-7', '--series-8', '--chart-grid', '--chart-axis', '--bg', '--bg-hover']
const PIE_MAX = 7 // slices beyond this fold into "Other"

type Row = Record<string, string | number | null>

function ChartTooltip({ active, payload, label, xLabel }: any) {
  if (!active || !payload?.length) return null
  const title = label ?? payload[0]?.payload?.[xLabel] ?? payload[0]?.name
  return (
    <div className="chart-tooltip">
      {title != null && <div className="t">{String(title)}</div>}
      {payload.map((p: any, i: number) => (
        <div className="row" key={i}>
          <span className="sw" style={{ background: p.color ?? p.payload?.fill }} />
          <span>{p.name}</span>
          <span className="v">{formatCell(p.value)}</span>
        </div>
      ))}
    </div>
  )
}

export function ChartView({ spec, result }: { spec: ChartSpec; result: QueryResult }) {
  const vars = useCssVars(VARS)
  const colors = vars.slice(0, 8)
  const [grid, axis, bg, hover] = vars.slice(8)
  const [mode, setMode] = useState<'chart' | 'table'>('chart')

  const data: Row[] = useMemo(() => {
    const idx = Object.fromEntries(result.columns.map((c, i) => [c, i]))
    return result.rows.map((r) => {
      const o: Row = {}
      o[spec.x] = r[idx[spec.x]] as string | number | null
      for (const y of spec.y) {
        const v = r[idx[y]]
        o[y] = typeof v === 'number' ? v : v === null ? null : Number(v)
      }
      return o
    })
  }, [result, spec])

  const pieData = useMemo(() => {
    if (spec.type !== 'pie') return []
    const y = spec.y[0]
    const sorted = [...data].sort((a, b) => Number(b[y] ?? 0) - Number(a[y] ?? 0))
    if (sorted.length <= PIE_MAX + 1) return sorted
    const rest = sorted.slice(PIE_MAX).reduce((s, r) => s + Number(r[y] ?? 0), 0)
    return [...sorted.slice(0, PIE_MAX), { [spec.x]: 'Other', [y]: rest }]
  }, [data, spec])

  const axisProps = {
    tick: { fill: axis, fontSize: 12 },
    tickLine: false,
    axisLine: { stroke: grid },
    tickFormatter: formatAxis
  }
  const multi = spec.y.length > 1
  const legend = multi ? <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12, paddingTop: 8 }} /> : null
  const tooltip = <Tooltip content={<ChartTooltip xLabel={spec.x} />} cursor={spec.type === 'bar' ? { fill: hover } : { stroke: axis, strokeDasharray: '3 3' }} />
  const many = data.length > 40

  let chart: React.ReactElement
  switch (spec.type) {
    case 'line':
      chart = (
        <LineChart data={data} margin={{ top: 8, right: 16, left: 8, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke={grid} />
          <XAxis dataKey={spec.x} {...axisProps} minTickGap={24} />
          <YAxis {...axisProps} axisLine={false} width={56} />
          {tooltip}
          {legend}
          {spec.y.map((y, i) => (
            <Line key={y} type="monotone" dataKey={y} stroke={colors[i]} strokeWidth={2} dot={many ? false : { r: 4, strokeWidth: 2, stroke: bg, fill: colors[i] }} activeDot={{ r: 5, strokeWidth: 2, stroke: bg }} />
          ))}
        </LineChart>
      )
      break
    case 'area':
      chart = (
        <AreaChart data={data} margin={{ top: 8, right: 16, left: 8, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke={grid} />
          <XAxis dataKey={spec.x} {...axisProps} minTickGap={24} />
          <YAxis {...axisProps} axisLine={false} width={56} />
          {tooltip}
          {legend}
          {spec.y.map((y, i) => (
            <Area key={y} type="monotone" dataKey={y} stroke={colors[i]} strokeWidth={2} fill={colors[i]} fillOpacity={0.15} stackId={multi ? 'a' : undefined} />
          ))}
        </AreaChart>
      )
      break
    case 'scatter':
      chart = (
        <ScatterChart margin={{ top: 8, right: 16, left: 8, bottom: 0 }}>
          <CartesianGrid stroke={grid} />
          <XAxis type="number" dataKey={spec.x} name={spec.x} {...axisProps} />
          <YAxis type="number" dataKey={spec.y[0]} name={spec.y[0]} {...axisProps} axisLine={false} width={56} />
          <Tooltip content={<ChartTooltip />} cursor={{ stroke: axis, strokeDasharray: '3 3' }} />
          <Scatter data={data} fill={colors[0]} stroke={bg} strokeWidth={1} />
        </ScatterChart>
      )
      break
    case 'pie':
      chart = (
        <PieChart>
          <Tooltip content={<ChartTooltip />} />
          <Legend iconType="circle" iconSize={8} layout="vertical" align="right" verticalAlign="middle" wrapperStyle={{ fontSize: 12 }} />
          <Pie data={pieData} dataKey={spec.y[0]} nameKey={spec.x} innerRadius="55%" outerRadius="85%" paddingAngle={1} stroke={bg} strokeWidth={2} isAnimationActive={false}>
            {pieData.map((_, i) => (
              <PieCell key={i} fill={colors[i % colors.length]} />
            ))}
          </Pie>
        </PieChart>
      )
      break
    default:
      chart = (
        <BarChart data={data} margin={{ top: 8, right: 16, left: 8, bottom: 0 }} barGap={2} barCategoryGap="20%">
          <CartesianGrid vertical={false} stroke={grid} />
          <XAxis dataKey={spec.x} {...axisProps} interval="preserveStartEnd" minTickGap={8} />
          <YAxis {...axisProps} axisLine={false} width={56} />
          {tooltip}
          {legend}
          {spec.y.map((y, i) => (
            <Bar key={y} dataKey={y} fill={colors[i]} radius={[4, 4, 0, 0]} maxBarSize={56} />
          ))}
        </BarChart>
      )
  }

  const title = spec.title || `${spec.y.join(', ')} by ${spec.x}`
  return (
    <div className="chart-card">
      <div className="chart-top">
        <div className="chart-title">{title}</div>
        <button className={`chip-btn${mode === 'chart' ? ' active' : ''}`} onClick={() => setMode('chart')}>
          <ChartColumn size={14} /> Chart
        </button>
        <button className={`chip-btn${mode === 'table' ? ' active' : ''}`} onClick={() => setMode('table')}>
          <Table2 size={14} /> Data
        </button>
        <button className="chip-btn" onClick={() => void window.api.exportCsv(title.replace(/[^\w-]+/g, '_'), result)} title="Export data as CSV">
          <Download size={14} />
        </button>
      </div>
      <div className={`chart-body${mode === 'table' ? ' table-mode' : ''}`}>
        {mode === 'chart' ? (
          <ResponsiveContainer width="100%" height="100%">
            {chart}
          </ResponsiveContainer>
        ) : (
          <DataTable result={result} name={title} />
        )}
      </div>
    </div>
  )
}
