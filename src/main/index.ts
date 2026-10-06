import { join } from 'node:path'
import { release } from 'node:os'
import { readFile, stat, truncate, writeFile } from 'node:fs/promises'
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, screen, session, shell, type MenuItemConstructorOptions } from 'electron'
import type { InvokeApi } from '@shared/api'
import type { AppEvent, QueryResult, SapientStatus } from '@shared/types'
import { ChatService } from './chat'
import { deviceInfo } from './core/capacity'
import { configureLog, log, logDirectory, readLog } from './core/log'
import { SapientManager } from './core/sapient'
import { resultToCsv, resultToXlsx, SUPPORTED_EXTENSIONS } from './core/workbook'
import { Store } from './store'

// Before anything reads userData, so dev and packaged runs share one profile folder.
app.setName('ExelSnap')
// Two instances would fight over the conversation files and the SAPIENT port.
if (!app.requestSingleInstanceLock()) app.exit(0)

const isDev = !app.isPackaged && !!process.env.ELECTRON_RENDERER_URL
let win: BrowserWindow | null = null

configureLog(join(app.getPath('userData'), 'logs'))
const system = () => ({
  app: app.getVersion(),
  packaged: app.isPackaged,
  electron: process.versions.electron,
  node: process.versions.node,
  platform: `${process.platform} ${release()} ${process.arch}`,
  locale: app.getLocale(),
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  ...deviceInfo()
})
log.info('app', 'starting', system())
process.on('uncaughtException', (err) => {
  log.error('app', 'uncaught exception', err)
  dialog.showErrorBox('ExelSnap hit an unexpected error', `${err.message}\n\nHelp ▸ Export Debug Log… saves a report you can send in.`)
})
process.on('unhandledRejection', (reason) => log.error('app', 'unhandled promise rejection', reason))

const store = new Store(app.getPath('userData'))
log.info('app', 'settings', store.settings)
const sapientLog = join(app.getPath('userData'), 'sapient.log')
// SAPIENT's own output is appended on every start; don't let it grow without bound.
void stat(sapientLog)
  .then((s) => (s.size > 5 * 1024 * 1024 ? truncate(sapientLog, 0) : undefined))
  .catch(() => {})
const sapient = new SapientManager({
  baseUrl: () => store.settings.baseUrl,
  binaryOverride: () => store.settings.sapientPath,
  preferredModel: () => store.settings.model,
  backend: () => store.settings.backend,
  answerSeconds: (model, backend) => store.answerSeconds(model, backend),
  logPath: sapientLog,
  // SAPIENT ships inside the app (see scripts/fetch-sapient.mjs) and keeps itself current from a writable copy.
  engine: {
    seed: app.isPackaged ? join(process.resourcesPath, 'sapient', 'sapient') : join(app.getAppPath(), 'vendor', 'sapient', 'sapient'),
    dir: join(app.getPath('userData'), 'engine')
  }
})

function emit(e: AppEvent) {
  if (win && !win.isDestroyed()) win.webContents.send('event', e)
}

// Spreadsheets opened from Finder ("Open With", or dropped on the Dock icon). They can arrive before
// the window exists, so they wait here until the renderer asks for them.
let pendingFiles: string[] = []
function openFiles(paths: string[]) {
  pendingFiles.push(...paths)
  if (!app.isReady()) return
  if (!win || win.isDestroyed()) return createWindow()
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  emit({ type: 'open-files' })
}
app.on('open-file', (e, path) => {
  e.preventDefault()
  openFiles([path])
})
app.on('second-instance', () => openFiles([]))
const chat = new ChatService(store, sapient, emit)

let lastStatus = ''
async function publishStatus(): Promise<SapientStatus> {
  const s = await sapient.status()
  const key = JSON.stringify(s)
  if (key !== lastStatus) {
    // Logged only when it changes, so the log shows when the server came up, went away or switched model.
    if (JSON.stringify({ ...s, models: undefined }) !== JSON.stringify({ ...(lastStatus ? JSON.parse(lastStatus) : {}), models: undefined })) {
      log.info('sapient', 'status', { state: s.state, managed: s.managed, version: s.version, backend: s.backend, note: s.backendNote, activeModel: s.activeModel, downloaded: s.downloaded, error: s.error, pulling: s.pulling })
    }
    lastStatus = key
    emit({ type: 'sapient', status: s })
  }
  return s
}

function exportTo(path: string, result: QueryResult): Promise<void> {
  return writeFile(path, /\.csv$/i.test(path) ? resultToCsv(result) : resultToXlsx(result))
}

const handlers: InvokeApi = {
  listConversations: async () => store.list(),
  getConversation: async (id) => {
    const c = store.get(id) ?? null
    if (c) void chat.session(id) // warm DuckDB (re-reads attached files from disk)
    return c
  },
  deleteConversation: async (id) => chat.delete(id),
  renameConversation: async (id, title) => chat.rename(id, title),
  attachFiles: (id, paths) => chat.attach(id, paths),
  pickFiles: async () => {
    const r = await dialog.showOpenDialog(win!, {
      title: 'Attach spreadsheets',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Spreadsheets', extensions: SUPPORTED_EXTENSIONS.map((e) => e.slice(1)) }]
    })
    return r.canceled ? [] : r.filePaths
  },
  takeOpenedFiles: async () => {
    const paths = pendingFiles
    pendingFiles = []
    return paths
  },
  removeAttachment: (id, attId) => chat.removeAttachment(id, attId),
  send: (id, text, ids) => chat.send(id, text, ids),
  stop: async (id) => chat.stop(id),
  preview: (id, table) => chat.preview(id, table),
  getSettings: async () => store.settings,
  saveSettings: async (patch) => {
    const s = store.saveSettings(patch)
    log.info('app', 'settings changed', patch)
    if (patch.theme) nativeTheme.themeSource = s.theme
    sapient.invalidateModels()
    if (patch.backend) {
      sapient.backendChanged()
      // The backend is a start-up option of the server, so a running one has to be restarted.
      if (sapient.managed) {
        sapient.stop()
        void handlers.startSapient()
      }
    }
    void publishStatus()
    return s
  },
  sapientStatus: () => publishStatus(),
  startSapient: async () => {
    emit({ type: 'sapient', status: { ...(await sapient.status()), state: 'starting' } })
    try {
      await sapient.start()
    } catch {
      /* surfaced through status.error */
    }
    lastStatus = ''
    return publishStatus()
  },
  stopSapient: async () => {
    sapient.stop()
    lastStatus = ''
    return publishStatus()
  },
  pullModel: async (id) => {
    const done = sapient.pull(id)
    lastStatus = ''
    void publishStatus()
    try {
      await done
    } catch (err) {
      dialog.showErrorBox('Download failed', err instanceof Error ? err.message : String(err))
    }
    lastStatus = ''
    return publishStatus()
  },
  exportData: async (name, result, source) => {
    const r = await dialog.showSaveDialog(win!, {
      defaultPath: `${name}.xlsx`,
      filters: [
        { name: 'Excel workbook', extensions: ['xlsx'] },
        { name: 'CSV', extensions: ['csv'] }
      ]
    })
    if (r.canceled || !r.filePath) return false
    try {
      await exportTo(r.filePath, source ? await chat.exportQuery(source.conversationId, source.sql) : result)
      return true
    } catch (err) {
      // The query is run again for the export, so it can fail after a file name was chosen (e.g. the source file moved).
      dialog.showErrorBox('Export failed', err instanceof Error ? err.message : String(err))
      return false
    }
  },
  revealFile: async (path) => shell.showItemInFolder(path),
  exportDebugLog: () => exportDebugLog(),
  showDebugLog: async () => {
    const dir = logDirectory()
    if (dir) void shell.openPath(dir)
  }
}

/**
 * One text file with everything needed to look into a problem: the computer, the settings, the
 * model server's state and the app's own log. No spreadsheet contents (see core/log.ts).
 */
async function exportDebugLog(): Promise<string | null> {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-')
  const r = await dialog.showSaveDialog(win!, {
    title: 'Export Debug Log',
    defaultPath: join(app.getPath('downloads'), `ExelSnap-debug-${stamp}.log`),
    filters: [{ name: 'Log', extensions: ['log', 'txt'] }]
  })
  if (r.canceled || !r.filePath) return null
  log.info('app', 'debug log exported')
  const status = await sapient.status().catch((err) => ({ error: String(err) }))
  const home = app.getPath('home')
  const section = (title: string, body: string) => `\n===== ${title} =====\n${body.trimEnd()}\n`
  const json = (v: unknown) => JSON.stringify(v, null, 2).split(home).join('~')
  const sapientOut = await readFile(sapientLog, 'utf8').catch(() => '')
  const text =
    `ExelSnap debug log, exported ${new Date().toISOString()}\n` +
    'Contains what the app did: questions asked, the SQL the model wrote, timings and errors. It does not contain spreadsheet rows or query results.\n' +
    section('System', json(system())) +
    section('Settings', json(store.settings)) +
    section('SAPIENT', json(status)) +
    section('Chats', `${store.list().length} saved`) +
    section('App log (one JSON object per line)', await readLog()) +
    section('SAPIENT output (last 200 lines)', sapientOut.split('\n').slice(-200).join('\n').split(home).join('~'))
  await writeFile(r.filePath, text)
  shell.showItemInFolder(r.filePath)
  return r.filePath
}

for (const [name, fn] of Object.entries(handlers)) {
  ipcMain.handle(`api:${name}`, async (_e, ...args: unknown[]) => {
    try {
      return await (fn as (...a: unknown[]) => unknown)(...args)
    } catch (err) {
      log.error('ipc', name, err)
      throw err
    }
  })
}

function createWindow() {
  const mac = process.platform === 'darwin'
  // Don't open larger than the screen on small MacBook displays.
  const area = screen.getPrimaryDisplay().workAreaSize
  win = new BrowserWindow({
    width: Math.min(1280, area.width),
    height: Math.min(840, area.height),
    minWidth: 720,
    minHeight: 520,
    show: false,
    // In macOS fullscreen the close/minimise/zoom buttons are hidden. Keep them: the green button zooms the window instead.
    fullscreenable: false,
    title: 'ExelSnap',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#212121' : '#ffffff',
    titleBarStyle: mac ? 'hiddenInset' : 'default',
    trafficLightPosition: mac ? { x: 16, y: 18 } : undefined,
    autoHideMenuBar: !mac,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true
    }
  })
  win.once('ready-to-show', () => win?.show())
  // Problems in the window (the React UI) end up in the same log as the main process.
  win.webContents.on('console-message', (e) => {
    if (e.level === 'error') log.error('window', e.message, { source: `${e.sourceId}:${e.lineNumber}` })
  })
  win.webContents.on('render-process-gone', (_e, details) => log.error('window', 'renderer process gone', details))
  win.webContents.on('did-fail-load', (_e, code, description, url) => log.error('window', 'page failed to load', { code, description, url }))
  win.on('unresponsive', () => log.warn('window', 'unresponsive'))
  win.on('responsive', () => log.info('window', 'responsive again'))
  // Links in answers open in the browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (!isDev || !url.startsWith(process.env.ELECTRON_RENDERER_URL!)) e.preventDefault()
  })
  if (isDev) void win.loadURL(process.env.ELECTRON_RENDERER_URL!)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

function buildMenu() {
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' } as const] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        // Reload and DevTools are development tools; a reload mid-answer would drop the streamed reply.
        ...(app.isPackaged ? [] : ([{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }] as const)),
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' }
      ]
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Export Debug Log…', click: () => void exportDebugLog().catch((err) => dialog.showErrorBox('Could not export the log', String(err))) },
        { label: 'Show Log Folder', click: () => void handlers.showDebugLog() }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

app.whenReady().then(async () => {
  nativeTheme.themeSource = store.settings.theme
  buildMenu()
  // The packaged app gets its icon from the bundle; in development show it in the Dock too.
  if (!app.isPackaged && process.platform === 'darwin') app.dock?.setIcon(join(__dirname, '../../resources/icon.png'))
  if (!isDev) {
    session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
      cb({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'"
          ]
        }
      })
    })
  }
  createWindow()

  // Bring the bundled SAPIENT up to date before starting it. The window is already usable; if the
  // check is slow (bad network) the app carries on with the version it has and the update finishes
  // in the background for the next start.
  const prepared = sapient.prepareEngine().catch((err) => log.error('sapient', 'engine preparation failed', err))
  void publishStatus()
  await Promise.race([prepared, new Promise((r) => setTimeout(r, 20_000))])
  lastStatus = ''
  const status = await publishStatus()
  if (status.state === 'offline' && store.settings.autoStartSapient && status.binary) {
    void handlers.startSapient()
  }
  void prepared.then(() => ((lastStatus = ''), publishStatus()))
  setInterval(() => void publishStatus(), 8_000)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  log.info('app', 'quitting')
  store.flush()
  void chat.shutdown()
  sapient.stop() // only stops a server ExelSnap started itself
})
