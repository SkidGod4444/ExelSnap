import type { ExelSnapApi } from '../shared/api'

declare global {
  interface Window {
    api: ExelSnapApi
  }
}

export {}
