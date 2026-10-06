import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, screen, session, shell, type MenuItemConstructorOptions } from 'electron'
import type { InvokeApi } from '@shared/api'
import type { AppEvent, QueryResult, SapientStatus } from '@shared/types'
import { ChatService } from './chat'
import { SapientManager } from './core/sapient'
import { SUPPORTED_EXTENSIONS } from './core/workbook'
import { Store } from './store'

// Before anything reads userData, so dev and packaged runs share one profile folder.
app.setName('ExelSnap')
// Two instances would fight over the conversation files and the SAPIENT port.
if (!app.requestSingleInstanceLock()) app.exit(0)

const isDev = !app.isPackaged && !!process.env.ELECTRON_RENDERER_URL
let win: BrowserWindow | null = null

const store = new Store(app.getPath('userData'))
const sapient = new SapientManager({
  baseUrl: () => store.settings.baseUrl,
  binaryOverride: () => store.settings.sapientPath,
  preferredModel: () => store.settings.model,
  logPath: join(app.getPath('userData'), 'sapient.log')
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
    lastStatus = key
    emit({ type: 'sapient', status: s })
  }
  return s
}

function csv(result: QueryResult): string {
  const esc = (v: unknown) => {
    if (v === null || v === undefined) return ''
    const s = String(v)
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return [result.columns.map(esc).join(','), ...result.rows.map((r) => r.map(esc).join(','))].join('\n')
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
    if (patch.theme) nativeTheme.themeSource = s.theme
    sapient.invalidateModels()
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
  exportCsv: async (name, result) => {
    const r = await dialog.showSaveDialog(win!, { defaultPath: `${name}.csv`, filters: [{ name: 'CSV', extensions: ['csv'] }] })
    if (r.canceled || !r.filePath) return false
    await writeFile(r.filePath, csv(result))
    return true
  },
  revealFile: async (path) => shell.showItemInFolder(path)
}

for (const [name, fn] of Object.entries(handlers)) {
  ipcMain.handle(`api:${name}`, (_e, ...args: unknown[]) => (fn as (...a: unknown[]) => unknown)(...args))
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
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    { role: 'windowMenu' }
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

  const status = await publishStatus()
  if (status.state === 'offline' && store.settings.autoStartSapient && status.binary) {
    void handlers.startSapient()
  }
  setInterval(() => void publishStatus(), 8_000)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  store.flush()
  void chat.shutdown()
  sapient.stop() // only stops a server ExelSnap started itself
})
