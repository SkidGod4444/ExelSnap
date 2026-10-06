// Drives the real built app and saves screenshots of each UI state.
//   npm run build && npx electron scripts/snap.cjs <outDir> [model]
// Uses a throwaway userData dir so it never touches your real chats.
const { app, BrowserWindow, nativeTheme } = require('electron')
const { mkdirSync, mkdtempSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { tmpdir } = require('node:os')

const outDir = resolve(process.argv[2] || 'snaps')
const model = process.argv[3] || ''
mkdirSync(outDir, { recursive: true })
const userData = mkdtempSync(join(tmpdir(), 'exelsnap-snap-'))
app.setPath('userData', userData)
writeFileSync(join(userData, 'settings.json'), JSON.stringify({ model, autoStartSapient: false }))

require('../out/main/index.js')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sample = resolve(__dirname, '../samples/sales_demo.xlsx')

app.whenReady().then(async () => {
  let win
  while (!(win = BrowserWindow.getAllWindows()[0])) await sleep(100)
  await new Promise((r) => (win.webContents.isLoading() ? win.webContents.once('did-finish-load', r) : r()))
  const js = (code) => win.webContents.executeJavaScript(code)
  const shot = async (name) => {
    await sleep(350)
    const img = await win.webContents.capturePage()
    writeFileSync(join(outDir, `${name}.png`), img.toPNG())
    console.log('saved', name)
  }
  const waitFor = async (cond, timeoutMs) => {
    const end = Date.now() + timeoutMs
    while (Date.now() < end) {
      if (await js(cond)) return true
      await sleep(500)
    }
    return false
  }

  try {
    nativeTheme.themeSource = 'dark'
    await sleep(1200)
    await shot('01-empty-dark')

    await js(`window.__exelsnap.attachPaths(${JSON.stringify([sample])})`)
    await waitFor(`!document.querySelector('.file-card .spin') && !!document.querySelector('.file-card')`, 15000)
    await shot('02-attached')

    await js(`window.__exelsnap.send('Which region had the highest total revenue? Show it as a bar chart.')`)
    await sleep(1500)
    await shot('03-thinking')
    const done = await waitFor(`!!document.querySelector('.send-btn[aria-label="Send"]') && !document.querySelector('.thinking')`, 9 * 60_000)
    console.log('answer finished:', done)
    await shot('04-answer-dark')

    nativeTheme.themeSource = 'light'
    await sleep(800)
    await shot('05-answer-light')

    await js(`document.querySelector('.msg-user .file-card')?.click()`)
    await sleep(1500)
    await shot('06-preview-light')
    await js(`document.querySelector('.dialog .icon-btn[aria-label="Close"]')?.click()`)

    nativeTheme.themeSource = 'dark'
    await js(`document.querySelector('.model-btn')?.click()`)
    await shot('07-model-menu')
    await js(`document.querySelector('.backdrop')?.click()`)
    await js(`window.__exelsnap.openSettings()`)
    await shot('08-settings')
  } catch (err) {
    console.error(err)
  } finally {
    app.exit(0)
  }
})
