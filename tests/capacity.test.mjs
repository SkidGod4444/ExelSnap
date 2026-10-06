// Which model the app recommends for a computer (out/main/cli.js --advise).
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { test } from 'node:test'

const CLI = join(import.meta.dirname, '../out/main/cli.js')
const Q = (size) => `openhorizon/qwen2.5-${size}-q4`
function advise(ram, backend, have = '') {
  const r = spawnSync(process.execPath, [CLI, '--advise', '--ram', String(ram), '--backend', backend, '--have', have], { encoding: 'utf8' })
  const out = JSON.parse(r.stdout)
  return { ...out, recommended: out.models.find((m) => m.recommended)?.id, fit: Object.fromEntries(out.models.map((m) => [m.id, m.fit])) }
}

test('16 GB, CPU: the 7B model is recommended', () => {
  const a = advise(16, 'cpu')
  assert.equal(a.recommended, Q('7b'))
  assert.equal(a.fit[Q('7b')], 'fits')
})

test('16 GB, GPU: 7B is too large (it ran this machine out of memory), 3B is tight, 1.5B is recommended', () => {
  const a = advise(16, 'gpu')
  assert.equal(a.fit[Q('7b')], 'too-large')
  assert.equal(a.fit[Q('3b')], 'tight')
  assert.equal(a.recommended, Q('1.5b'))
})

test('hybrid is budgeted like GPU', () => {
  assert.deepEqual(advise(16, 'hybrid').fit, advise(16, 'gpu').fit)
})

test('8 GB: CPU gets 3B; in GPU mode nothing fits comfortably', () => {
  assert.equal(advise(8, 'cpu').recommended, Q('3b'))
  assert.equal(advise(8, 'cpu').fit[Q('7b')], 'too-large')
  const gpu = advise(8, 'gpu', [Q('1.5b'), Q('3b')].join(','))
  assert.equal(gpu.recommended, undefined)
  assert.equal(gpu.fit[Q('3b')], 'too-large')
  assert.equal(gpu.auto, Q('1.5b')) // the smallest one there is
})

test('32 GB, GPU: 3B is recommended, 7B is tight', () => {
  const a = advise(32, 'gpu')
  assert.equal(a.recommended, Q('3b'))
  assert.equal(a.fit[Q('7b')], 'tight')
})

test('estimates match what was measured in the app (CPU 7B: 5.2 GB resident, 6.0 GB peak; GPU 3B: 9.3 / 9.4)', () => {
  const cpu = advise(16, 'cpu').models.find((m) => m.id === Q('7b'))
  assert.ok(Math.abs(cpu.residentGb - 5.2) <= 0.4 && Math.abs(cpu.peakGb - 6.0) <= 0.3, JSON.stringify(cpu))
  const gpu = advise(16, 'gpu').models.find((m) => m.id === Q('3b'))
  assert.ok(Math.abs(gpu.residentGb - 9.3) <= 0.3 && Math.abs(gpu.peakGb - 9.4) <= 0.3, JSON.stringify(gpu))
})

test('Auto uses the best downloaded model that fits, not one that is merely recommended', () => {
  const a = advise(16, 'cpu', [Q('1.5b'), Q('3b')].join(','))
  assert.equal(a.recommended, Q('7b')) // offered as a download
  assert.equal(a.auto, Q('3b'))
  assert.equal(advise(16, 'gpu', [Q('1.5b'), Q('3b'), Q('7b')].join(',')).auto, Q('1.5b')) // 7B is installed but would not load
})

test('models without a size in their name (vision, speech) are never suggested for chat', () => {
  const a = advise(16, 'cpu', 'openhorizon/smolvlm2-500m,' + Q('3b'))
  assert.ok(!a.models.some((m) => m.id.includes('smolvlm')))
})
