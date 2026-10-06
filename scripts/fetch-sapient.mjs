// Downloads the SAPIENT engine that ships inside the app into vendor/sapient/sapient.
//   node scripts/fetch-sapient.mjs [--arch arm64|x64] [--force]
// The hybrid build is used: it has all three modes the app offers (CPU, GPU, hybrid). The archive's
// SHA-256 is checked against the checksum published with the release. At run time the app copies
// this binary to its data folder and lets it update itself (see SapientManager.prepareEngine).
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const REPO = 'openhorizon-labs/sapient'
const { values } = parseArgs({ options: { arch: { type: 'string' }, force: { type: 'boolean' } } })
const arch = values.arch ?? process.arch
const triple = { arm64: 'aarch64-apple-darwin', x64: 'x86_64-apple-darwin' }[arch]
if (process.platform !== 'darwin' || !triple) throw new Error(`No bundled SAPIENT for ${process.platform}/${arch} yet (macOS arm64 and x64 only).`)

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'vendor', 'sapient')
const target = join(out, 'sapient')
const version = () => execFileSync(target, ['--version'], { encoding: 'utf8' }).trim()

const headers = { 'User-Agent': 'exelsnap-build', ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) }
const get = async (url) => {
  const res = await fetch(url, { headers, redirect: 'follow' })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`)
  return res
}

const release = await (await get(`https://api.github.com/repos/${REPO}/releases/latest`)).json()
const tag = release.tag_name
if (!values.force && existsSync(target) && version().includes(tag.replace(/^v/, ''))) {
  console.log(`vendor/sapient is already ${version()} (${arch})`)
  process.exit(0)
}

const name = `sapient-${triple}-hybrid.tar.gz`
const base = `https://github.com/${REPO}/releases/download/${tag}/${name}`
console.log(`downloading ${name} ${tag} …`)
const archive = Buffer.from(await (await get(base)).arrayBuffer())
const expected = (await (await get(`${base}.sha256`)).text()).trim().split(/\s+/)[0]
const actual = createHash('sha256').update(archive).digest('hex')
if (actual !== expected) throw new Error(`Checksum mismatch for ${name}: expected ${expected}, got ${actual}`)

const tmp = mkdtempSync(join(tmpdir(), 'sapient-'))
writeFileSync(join(tmp, name), archive)
execFileSync('tar', ['-xzf', join(tmp, name), '-C', tmp])
mkdirSync(out, { recursive: true })
renameSync(join(tmp, 'sapient'), target)
chmodSync(target, 0o755)
rmSync(tmp, { recursive: true, force: true })
console.log(`vendor/sapient/sapient: ${arch === process.arch ? version() : tag} (${arch}, hybrid build, checksum verified)`)
