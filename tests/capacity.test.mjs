// Which model the app recommends for a computer (out/main/cli.js --advise).
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { test } from 'node:test'

const CLI = join(import.meta.dirname, '../out/main/cli.js')
const Q = (size) => `openhorizon/qwen2.5-${size}-q4`
function advise(ram, backend, have = '', gpuEngine = 'wgpu') {
  const r = spawnSync(process.execPath, [CLI, '--advise', '--ram', String(ram), '--backend', backend, '--have', have, '--gpu-engine', gpuEngine], { encoding: 'utf8' })
  const out = JSON.parse(r.stdout)
  return { ...out, recommended: out.models.find((m) => m.recommended)?.id, fit: Object.fromEntries(out.models.map((m) => [m.id, m.fit])) }
}
const model = (a, size) => a.models.find((m) => m.id === Q(size))
const near = (actual, expected, tolerance = 0.4) => Math.abs(actual - expected) <= tolerance

test('16 GB, CPU: the 7B model is recommended', () => {
  const a = advise(16, 'cpu')
  assert.equal(a.recommended, Q('7b'))
  assert.equal(a.fit[Q('7b')], 'fits')
})

test('16 GB, GPU or hybrid: 3B and 7B are too large, 1.5B is tight, only 0.5B fits comfortably', () => {
  for (const mode of ['gpu', 'hybrid']) {
    const a = advise(16, mode)
    assert.equal(a.fit[Q('7b')], 'too-large', mode)
    assert.equal(a.fit[Q('3b')], 'too-large', mode)
    assert.equal(a.fit[Q('1.5b')], 'tight', mode)
    assert.equal(a.recommended, Q('0.5b'), mode)
  }
})

test('16 GB, GPU on the Metal build: 7B is too large (it ran this machine out of memory), 3B is tight', () => {
  const a = advise(16, 'gpu', '', 'metal')
  assert.equal(a.fit[Q('7b')], 'too-large')
  assert.equal(a.fit[Q('3b')], 'tight')
  assert.equal(a.recommended, Q('1.5b'))
})

test('8 GB: CPU gets 3B; GPU only the smallest', () => {
  assert.equal(advise(8, 'cpu').recommended, Q('3b'))
  assert.equal(advise(8, 'cpu').fit[Q('7b')], 'too-large')
  const gpu = advise(8, 'gpu', [Q('1.5b'), Q('3b')].join(','))
  assert.equal(gpu.recommended, Q('0.5b')) // offered as a download
  assert.equal(gpu.fit[Q('1.5b')], 'too-large')
  assert.equal(gpu.auto, Q('1.5b')) // nothing downloaded fits: the smallest there is
})

test('32 GB, GPU: 1.5B is recommended, 3B is tight, 7B is too large', () => {
  const a = advise(32, 'gpu')
  assert.equal(a.recommended, Q('1.5b'))
  assert.equal(a.fit[Q('3b')], 'tight')
  assert.equal(a.fit[Q('7b')], 'too-large')
})

test('estimates match what was measured (GB resident / peak)', () => {
  const cpu = model(advise(16, 'cpu'), '7b') // 5.2 / 6.0
  assert.ok(near(cpu.residentGb, 5.2) && near(cpu.peakGb, 6.0), JSON.stringify(cpu))
  const wgpu = model(advise(16, 'gpu'), '1.5b') // 1.4 / 9.5
  assert.ok(near(wgpu.residentGb, 1.4) && near(wgpu.peakGb, 9.5), JSON.stringify(wgpu))
  const hybrid = model(advise(16, 'hybrid'), '1.5b') // 2.7 / 10.0
  assert.ok(near(hybrid.residentGb, 2.7) && near(hybrid.peakGb, 10.0), JSON.stringify(hybrid))
  const metal = model(advise(16, 'gpu', '', 'metal'), '3b') // 9.3 / 9.4
  assert.ok(near(metal.residentGb, 9.3) && near(metal.peakGb, 9.4), JSON.stringify(metal))
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
