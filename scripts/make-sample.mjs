// Generates samples/sales_demo.xlsx — a deliberately "real-world" workbook (title row, total row, N/A cells).
import * as XLSX from 'xlsx'
import { writeFileSync } from 'node:fs'

let seed = 42
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
const pick = (a) => a[Math.floor(rand() * a.length)]
const regions = ['North', 'South', 'East', 'West', 'Central']
const products = [['Laptop', 899], ['Monitor', 229], ['Keyboard', 49], ['Mouse', 25], ['Headset', 89], ['Dock', 149]]
const reps = ['Asha', 'Rahul', 'Meera', 'Vikram', 'Priya', 'Arjun', 'Neha']

const rows = [['FY2025 Sales Ledger — exported from ERP'], [], ['Order ID', 'Order Date', 'Region', 'Product', 'Sales Rep', 'Units', 'Unit Price ($)', 'Discount %', 'Revenue ($)']]
let total = 0
for (let i = 0; i < 1500; i++) {
  const d = new Date(2025, Math.floor(rand() * 12), 1 + Math.floor(rand() * 28))
  const [p, price] = pick(products)
  const region = pick(regions)
  const units = 1 + Math.floor(rand() * (p === 'Laptop' ? 5 : 20))
  const disc = pick([0, 0, 0, 0.05, 0.1, 0.15])
  const rev = Math.round(units * price * (1 - disc) * (region === 'West' ? 1.1 : 1) * 100) / 100
  total += rev
  rows.push([`SO-${10000 + i}`, d, region, p, pick(reps), units, price, i % 97 === 0 ? 'N/A' : disc, rev])
}
rows.push(['Total', null, null, null, null, null, null, null, Math.round(total * 100) / 100])

const targets = [['Region', 'Q1 Target', 'Q2 Target', 'Q3 Target', 'Q4 Target']]
for (const r of regions) targets.push([r, ...[1, 2, 3, 4].map(() => 80000 + Math.round(rand() * 60000))])

const wb = XLSX.utils.book_new()
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows, { cellDates: true }), 'Sales')
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(targets), 'Targets')
writeFileSync('samples/sales_demo.xlsx', XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', cellDates: true }))
console.log('wrote samples/sales_demo.xlsx')
