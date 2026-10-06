// How spreadsheets are read, queried and exported, checked through the headless CLI (out/main/cli.js).
//   npm test
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { before, test } from 'node:test'
import { writeFixtures } from './fixtures.mjs'

const CLI = join(import.meta.dirname, '../out/main/cli.js')
const dir = mkdtempSync(join(tmpdir(), 'exelsnap-test-'))
const fx = (name) => join(dir, name)

function cli(args, env = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 64 << 20 })
  return { out: r.stdout, err: r.stderr, code: r.status }
}
const tables = (file, env) => JSON.parse(cli(['-f', file, '--tables'], env).out)
const sql = (file, query, env) => JSON.parse(cli(['-f', file, '--sql', query], env).out)
const col = (table, name) => table.columns.find((c) => c.name === name)
const types = (table) => Object.fromEntries(table.columns.map((c) => [c.name, c.type]))

before(() => writeFixtures(dir))

test('sample workbook: title row, N/A cells and the Total row', () => {
  const [sales, targets] = tables(join(import.meta.dirname, '../samples/sales_demo.xlsx'))
  assert.equal(sales.rowCount, 1500)
  assert.equal(targets.rowCount, 5)
  assert.equal(col(sales, 'order_date').type, 'DATE')
  assert.equal(col(sales, 'discount_pct').nulls, 16)
  assert.ok(sales.notes.some((n) => /Title rows/.test(n)))
  assert.ok(sales.notes.some((n) => /total row/.test(n) && /"Total"/.test(n)))
})

test('merged two-row header becomes one name per column', () => {
  const [t] = tables(fx('merged_header.xlsx'))
  assert.deepEqual(t.columns.map((c) => c.header), ['Region', '2024 Q1', '2024 Q2', '2025 Q1', '2025 Q2'])
  assert.equal(t.rowCount, 2)
})

test('a metadata line above the header is not merged into the column names', () => {
  const [t] = tables(fx('metadata_row.xlsx'))
  assert.deepEqual(t.columns.map((c) => c.header), ['Name', 'Amount', 'Qty', 'Region', '(column 5)'])
})

test('formula without a saved result is reported, not silently empty', () => {
  const [t] = tables(fx('formulas.xlsx'))
  assert.equal(col(t, 'total').nulls, 1)
  assert.ok(t.notes.some((n) => /formula/.test(n)))
})

test('hidden sheets are loaded and flagged; empty sheets are skipped', () => {
  const ts = tables(fx('hidden_empty.xlsx'))
  assert.deepEqual(ts.map((t) => t.sheet), ['Data', 'Secret'])
  assert.ok(ts[1].notes.some((n) => /hidden/.test(n)))
})

test('two tables stacked on one sheet load as two tables', () => {
  const ts = tables(fx('two_tables.xlsx'))
  assert.equal(ts.length, 2)
  assert.deepEqual(types(ts[0]), { product: 'VARCHAR', units: 'BIGINT' })
  assert.deepEqual(types(ts[1]), { city: 'VARCHAR', population: 'BIGINT', country: 'VARCHAR' })
})

test('blank spacer rows inside a table do not split it', () => {
  const ts = tables(fx('spacer_rows.xlsx'))
  assert.equal(ts.length, 1)
  assert.equal(ts[0].rowCount, 3)
})

test('text dates become DATE; unclear day/month order stays text with a note', () => {
  const [t] = tables(fx('dates.xlsx'))
  assert.deepEqual(types(t), { iso_text: 'DATE', dmy_text: 'DATE', us_text: 'DATE', real_dt: 'TIMESTAMP', month_text: 'VARCHAR', unclear: 'VARCHAR' })
  assert.ok(t.notes.some((n) => /unclear/.test(n) && /strptime/.test(n)))
  const r = sql(fx('dates.xlsx'), 'select count(*) from dates where iso_text = dmy_text and dmy_text = us_text and iso_text = cast(real_dt as date)')
  assert.equal(r.rows[0][0], 3)
})

test('dates do not shift with the time zone', () => {
  for (const TZ of ['Asia/Kolkata', 'America/Los_Angeles', 'Pacific/Auckland', 'UTC']) {
    const r = sql(fx('dates.xlsx'), 'select min(iso_text), max(dmy_text), min(real_dt) from dates', { TZ })
    assert.deepEqual(r.rows[0], ['2025-01-31', '2025-03-15', '2025-01-31 14:30:00'], TZ)
  }
})

test('text numbers: thousands, decimal comma, negatives in brackets', () => {
  const r = sql(fx('numbers.xlsx'), 'select sum(text_thousands), sum(euro_text), sum(neg_paren), sum(pct_cell) from nums')
  assert.deepEqual(r.rows[0], [13234.5, 1334.46, -1250.5, 0.35])
})

test('codes with leading zeros and long digit strings stay text', () => {
  const [t] = tables(fx('numbers.xlsx'))
  assert.equal(col(t, 'zip').type, 'VARCHAR')
  assert.deepEqual(col(t, 'zip').samples.sort(), ['00123', '00456'])
  assert.equal(col(t, 'card').type, 'VARCHAR')
})

test('subtotal, grand total and footer rows are left out', () => {
  const [t] = tables(fx('subtotals.xlsx'))
  assert.equal(t.rowCount, 4)
  assert.equal(sql(fx('subtotals.xlsx'), 'select sum(amount) from sales').rows[0][0], 50)
  // what was left out is named, so it can be checked
  assert.ok(t.notes.some((n) => /"North Total", "South Total", "Grand Total"/.test(n)))
  assert.ok(t.notes.some((n) => /footer/.test(n) && /Source: ERP export/.test(n)))
})

test('rows only named like a total (their number is not the sum above) are kept', () => {
  const [t] = tables(fx('total_named_rows.xlsx'))
  assert.equal(t.rowCount, 5)
  assert.deepEqual(t.notes, [])
})

test('a sparse last row of data is not mistaken for a footnote', () => {
  const [t] = tables(fx('sparse_last_row.xlsx'))
  assert.equal(t.rowCount, 3)
  assert.deepEqual(t.notes, [])
})

test('semicolon CSV with decimal commas, dotted dates and booleans', () => {
  const [t] = tables(fx('semicolon.csv'))
  assert.deepEqual(types(t), { name: 'VARCHAR', betrag: 'DOUBLE', datum: 'DATE', aktiv: 'BOOLEAN' })
  assert.deepEqual(sql(fx('semicolon.csv'), 'select sum(betrag), max(datum) from semicolon').rows[0], [1334.46, '2025-02-01'])
})

test('CSV quoting and TSV', () => {
  assert.equal(sql(fx('quoted.csv'), `select comment from quoted where id = 3`).rows[0][0], 'say "hi"')
  assert.equal(tables(fx('quoted.csv'))[0].rowCount, 3)
  assert.deepEqual(types(tables(fx('tabs.tsv'))[0]), { sku: 'VARCHAR', qty: 'BIGINT', price: 'DOUBLE' })
})

test('booleans, error cells and mixed columns', () => {
  const [t] = tables(fx('mixed.xlsx'))
  assert.deepEqual(types(t), { flag: 'BOOLEAN', value: 'BIGINT', mostly_num: 'VARCHAR' })
  assert.equal(col(t, 'value').nulls, 1) // #DIV/0!
  assert.equal(sql(fx('mixed.xlsx'), 'select sum(try_cast(mostly_num as double)) from mix').rows[0][0], 50)
})

test('sheet and column names: accents, non-Latin scripts, SQL keywords, digits', () => {
  const ts = tables(fx('names.xlsx'))
  assert.deepEqual(ts.map((t) => t.table), ['q1_verkaufe_2025', '数据', 'select_', 'c_123'])
  assert.equal(sql(fx('names.xlsx'), 'select "数量" from "数据"').rows[0][0], 3)
  assert.equal(sql(fx('names.xlsx'), 'select "from_" + "where_" from "select_"').rows[0][0], 3)
})

test('.xls, .ods and .xlsb read like .xlsx', () => {
  for (const f of ['people.xls', 'people.ods', 'people.xlsb']) {
    const [t] = tables(fx(f))
    assert.deepEqual(types(t), { name: 'VARCHAR', joined: 'DATE', salary: 'DOUBLE' }, f)
    assert.deepEqual(sql(fx(f), 'select min(joined), sum(salary) from people').rows[0], ['2020-05-01', 11100.5], f)
  }
})

test('150,000 rows load and aggregate', () => {
  const r = sql(fx('big.xlsx'), 'select count(*), count(distinct region), min(date), max(date) from big')
  assert.deepEqual(r.rows[0], [150000, 4, '2024-01-01', '2024-12-28'])
})

test('a 300-column sheet keeps the schema prompt small', () => {
  const { out } = cli(['-f', fx('wide.xlsx'), '--schema'])
  assert.ok(out.length < 12_000, `prompt is ${out.length} characters`)
  assert.match(out, /more columns/)
  assert.equal(tables(fx('wide.xlsx'))[0].columns.length, 300)
})

test('unsupported and unreadable files fail with a clear message', () => {
  assert.match(cli(['-f', join(import.meta.dirname, 'loader.test.mjs'), '--tables']).err, /Unsupported file type/)
  assert.match(cli(['-f', fx('missing.xlsx'), '--tables']).err, /✗ missing\.xlsx/)
})

test('queries are read-only', () => {
  for (const q of ['drop table sales', "copy sales to 'x.csv'", 'select 1; select 2', "select * from read_csv('/etc/passwd')"]) {
    const r = cli(['-f', fx('subtotals.xlsx'), '--sql', q])
    assert.notEqual(r.code, 0, q)
  }
})

test('export to .xlsx and .csv round-trips every row with its types', () => {
  const query = 'select id, date, region, revenue from big order by id'
  for (const name of ['export.xlsx', 'export.csv']) {
    assert.equal(cli(['-f', fx('big.xlsx'), '--sql', query, '--export', fx(name)]).code, 0)
    // the exported sheet is named "Result"; a file called export.csv becomes export_ because the read-only guard rejects the word EXPORT
    const table = name.endsWith('.xlsx') ? 'result' : 'export_'
    const [t] = tables(fx(name))
    assert.equal(t.rowCount, 150000, name) // not the 500 rows shown on screen
    assert.deepEqual(types(t), { id: 'BIGINT', date: 'DATE', region: 'VARCHAR', revenue: 'DOUBLE' }, name)
    assert.deepEqual(sql(fx(name), `select min(date), max(date), sum(revenue) from ${table}`).rows[0], ['2024-01-01', '2024-12-28', 11399658], name)
  }
})

test('exported dates keep their day in any time zone', () => {
  for (const TZ of ['Asia/Kolkata', 'America/Los_Angeles']) {
    cli(['-f', fx('dates.xlsx'), '--sql', 'select iso_text as d, real_dt as ts from dates order by 1', '--export', fx(`tz.xlsx`)], { TZ })
    assert.deepEqual(sql(fx('tz.xlsx'), 'select min(d), min(ts) from result', { TZ }).rows[0], ['2025-01-31', '2025-01-31 14:30:00'], TZ)
  }
})
