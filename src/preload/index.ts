import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { INVOKE_METHODS, type ExelSnapApi } from '@shared/api'
import type { AppEvent } from '@shared/types'

const api = {
  platform: process.platform,
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  onEvent: (cb: (e: AppEvent) => void) => {
    const listener = (_: unknown, e: AppEvent) => cb(e)
    ipcRenderer.on('event', listener)
    return () => ipcRenderer.removeListener('event', listener)
  }
} as Partial<ExelSnapApi>

for (const m of INVOKE_METHODS) {
  ;(api as Record<string, unknown>)[m] = (...args: unknown[]) => ipcRenderer.invoke(`api:${m}`, ...args)
}

contextBridge.exposeInMainWorld('api', api)
