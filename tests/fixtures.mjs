// Deliberately awkward workbooks: the shapes real spreadsheets come in.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as XLSX from 'xlsx'

function book(sheets) {
  const wb = XLSX.utils.book_new()
  for (const [name, rows, tweak] of sheets) {
    const ws = XLSX.utils.aoa_to_sheet(rows, { cellDates: true })
    tweak?.(ws)
    XLSX.utils.book_append_sheet(wb, ws, name)
  }
  return wb
}

export function writeFixtures(dir) {
  const save = (name, wb, bookType = name.split('.').pop()) => writeFileSync(join(dir, name), XLSX.write(wb, { type: 'buffer', bookType, cellDates: true }))
  const text = (name, content) => writeFileSync(join(dir, name), content)

  save('merged_header.xlsx', book([['Report', [
    ['Region', '2024', null, '2025', null],
    [null, 'Q1', 'Q2', 'Q1', 'Q2'],
    ['North', 10, 20, 30, 40],
    ['South', 11, 21, 31, 41]
  ], (ws) => {
    ws['!merges'] = [{ s: { r: 0, c: 1 }, e: { r: 0, c: 2 } }, { s: { r: 0, c: 3 }, e: { r: 0, c: 4 } }, { s: { r: 0, c: 0 }, e: { r: 1, c: 0 } }]
  }]]))

  save('formulas.xlsx', book([['Calc', [['Item', 'Qty', 'Price', 'Total'], ['A', 2, 5, 10], ['B', 3, 7, 21]], (ws) => {
    ws.D2 = { t: 'n', v: 10, f: 'B2*C2' }
    ws.D3 = { t: 'n', f: 'B3*C3' } // written by a script: formula without a saved result
  }]]))

  const hidden = book([['Data', [['Name', 'Score'], ['x', 1], ['y', 2]]], ['Secret', [['k', 'v'], ['a', 1]]], ['Empty', []]])
  hidden.Workbook = { Sheets: [{ Hidden: 0 }, { Hidden: 1 }, { Hidden: 0 }] }
  save('hidden_empty.xlsx', hidden)

  save('two_tables.xlsx', book([['Sheet1', [
    [], [],
    [null, null, 'Product', 'Units'], [null, null, 'A', 5], [null, null, 'B', 6],
    [], [],
    [null, null, 'City', 'Population', 'Country'], [null, null, 'Pune', 7000000, 'IN'], [null, null, 'Oslo', 700000, 'NO']
  ]]]))

  save('spacer_rows.xlsx', book([['S', [['Name', 'Team', 'Score'], ['a', 'x', 1], [], ['b', 'y', 2], [], ['c', 'z', 3]]]]))

  save('dates.xlsx', book([['Dates', [
    ['iso_text', 'dmy_text', 'us_text', 'real_dt', 'month_text', 'unclear'],
    ['2025-01-31', '31/01/2025', '01/31/2025', new Date(2025, 0, 31, 14, 30), 'Jan 2025', '01/02/2025'],
    ['2025-02-28', '28/02/2025', '02/28/2025', new Date(2025, 1, 28, 9, 5), 'Feb 2025', '03/04/2025'],
    ['2025-03-15', '15/03/2025', '03/15/2025', new Date(2025, 2, 15, 0, 0), 'Mar 2025', '05/06/2025']
  ]]]))

  save('numbers.xlsx', book([['Nums', [
    ['pct_cell', 'text_thousands', 'euro_text', 'neg_paren', 'zip', 'card'],
    [0.15, '1,234.50', '1.234,56', '(250)', '00123', '4111111111111111'],
    [0.2, '12,000', '99,90', '(1,000.5)', '00456', '5500000000000004']
  ]]]))

  save('subtotals.xlsx', book([['Sales', [
    ['Region', 'Rep', 'Amount'],
    ['North', 'A', 10], ['North', 'B', 20], ['North Total', null, 30],
    ['South', 'C', 5], ['South', 'D', 15], ['South Total', null, 20],
    ['Grand Total', null, 50],
    [],
    ['Source: ERP export 2025-01-01']
  ]]]))

  save('total_named_rows.xlsx', book([['Co', [['Company', 'Country', 'Revenue'], ['Total Energies', 'FR', 5], ['Acme', 'US', 7], ['Total Wine', 'US', 9], ['Zed', 'UK', 1], ['Order total', 'UK', 3]]]]))

  // one filled cell in the last row, but it is data, not a footnote
  save('sparse_last_row.xlsx', book([['S', [['Code', 'Qty', 'Note'], ['A1', 1, 'ok'], ['B2', 2, 'ok'], ['C3', null, null]]]]))

  text('semicolon.csv', '﻿Name;Betrag;Datum;Aktiv\nMüller;1.234,56;31.01.2025;true\nØrsted;99,90;01.02.2025;false\n')
  text('quoted.csv', 'id,comment,amount\n1,"hello, world",10\n2,"line1\nline2",20\n3,"say ""hi""",30\n')
  text('tabs.tsv', 'sku\tqty\tprice\nA-1\t3\t9.50\nB-2\t4\t10.25\n')

  save('mixed.xlsx', book([['Mix', [['flag', 'value', 'mostly_num'], [true, 1, 10], [false, 2, 'n/a'], [true, 3, 'unknown'], [false, 4, 40]], (ws) => {
    ws.B4 = { t: 'e', v: 7, w: '#DIV/0!' }
  }]]))

  save('names.xlsx', book([['Q1 – Verkäufe (2025)', [['a'], [1]]], ['数据', [['名称', '数量'], ['苹果', 3]]], ['select', [['from', 'where'], [1, 2]]], ['123', [['x'], [1]]]]))

  const people = () => book([['People', [['Name', 'Joined', 'Salary'], ['Ann', new Date(2020, 4, 1), 5000.5], ['Bob', new Date(2021, 6, 15), 6100]]]])
  save('people.xls', people(), 'biff8')
  save('people.ods', people())
  save('people.xlsb', people())

  const big = [['id', 'date', 'region', 'units', 'revenue']]
  for (let i = 0; i < 150_000; i++) big.push([i, new Date(2024, i % 12, 1 + (i % 28)), ['N', 'S', 'E', 'W'][i % 4], i % 17, (i % 17) * 9.5])
  save('big.xlsx', book([['Big', big]]))

  const head = Array.from({ length: 300 }, (_, i) => `col ${i + 1}`)
  save('wide.xlsx', book([['Wide', [head, head.map((_, i) => i), head.map((_, i) => i * 2)]]]))
}
