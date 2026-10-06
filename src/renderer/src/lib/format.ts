import type { Cell } from '@shared/types'

export const NUMERIC_TYPE = /INT|DOUBLE|FLOAT|DECIMAL|REAL|NUMERIC/i

export function formatCell(v: Cell): string {
  if (v === null) return '—'
  if (typeof v === 'number') {
    if (Number.isInteger(v)) return v.toLocaleString('en-US')
    return v.toLocaleString('en-US', { maximumFractionDigits: Math.abs(v) < 1 ? 4 : 2 })
  }
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  return v
}

const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })
export function formatAxis(v: unknown): string {
  if (typeof v === 'number') return Math.abs(v) >= 10000 ? compact.format(v) : v.toLocaleString('en-US', { maximumFractionDigits: 2 })
  const s = String(v ?? '')
  return s.length > 14 ? s.slice(0, 13) + '…' : s
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function shortModel(m: string): string {
  return m.replace(/^openhorizon\//, '')
}

export function toTsv(columns: string[], rows: Cell[][]): string {
  return [columns, ...rows.map((r) => r.map((c) => (c === null ? '' : String(c))))].map((r) => r.join('\t')).join('\n')
}

export function groupByDate<T extends { updatedAt: number }>(items: T[]): { label: string; items: T[] }[] {
  const startOfDay = new Date().setHours(0, 0, 0, 0)
  const day = 86_400_000
  const buckets: [string, (t: number) => boolean][] = [
    ['Today', (t) => t >= startOfDay],
    ['Yesterday', (t) => t >= startOfDay - day],
    ['Previous 7 days', (t) => t >= startOfDay - 7 * day],
    ['Previous 30 days', (t) => t >= startOfDay - 30 * day],
    ['Older', () => true]
  ]
  const groups = buckets.map(([label]) => ({ label, items: [] as T[] }))
  for (const it of items) groups[buckets.findIndex(([, test]) => test(it.updatedAt))].items.push(it)
  return groups.filter((g) => g.items.length)
}
