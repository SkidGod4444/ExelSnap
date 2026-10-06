// Types shared by the main process (agent, workbook engine) and the renderer (chat UI).
import type { ModelMessage } from 'ai'

export type ColumnType = 'BIGINT' | 'DOUBLE' | 'BOOLEAN' | 'DATE' | 'TIMESTAMP' | 'VARCHAR'

export interface ColumnInfo {
  name: string // SQL identifier in DuckDB
  header: string // original header text from the sheet
  type: ColumnType
  nulls: number
  distinct: number // capped count (see workbook.ts)
  min?: string
  max?: string
  samples: string[] // most frequent values (text columns) or a few example values
}

export interface TableInfo {
  table: string
  file: string
  sheet: string
  rowCount: number
  columns: ColumnInfo[]
  notes: string[] // e.g. "Skipped 1 trailing total row"
}

export interface Attachment {
  id: string
  path: string
  name: string
  size: number
  tables: TableInfo[]
  status: 'loading' | 'ready' | 'error'
  error?: string
}

export type Cell = string | number | boolean | null

export interface QueryResult {
  columns: string[]
  types: string[]
  rows: Cell[][]
  rowCount: number // rows returned (<= cap)
  truncated: boolean // more rows existed than the cap
}

/** Where a result came from, so an export can re-run it without the on-screen row cap. */
export interface ResultSource {
  conversationId: string
  sql: string
}

export type ChartType = 'bar' | 'line' | 'area' | 'pie' | 'scatter'

export interface ChartSpec {
  type: ChartType
  title?: string
  x: string
  y: string[]
}

export interface TextPart {
  kind: 'text'
  text: string
}

export interface ToolPart {
  kind: 'tool'
  id: string
  name: string
  args: Record<string, unknown>
  status: 'running' | 'done' | 'error'
  result?: QueryResult
  chart?: ChartSpec
  error?: string
  durationMs?: number
}

export type Part = TextPart | ToolPart

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  createdAt: number
  parts: Part[]
  attachments?: Attachment[]
  status?: 'thinking' | 'streaming' | 'done' | 'stopped' | 'error'
  error?: string
  model?: string
  durationMs?: number
}


export interface Conversation {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  attachments: Attachment[]
  messages: ChatMessage[]
  history: ModelMessage[] // model-facing transcript in AI SDK format (without system prompt)
}

export interface ConversationSummary {
  id: string
  title: string
  updatedAt: number
}

/** Where SAPIENT runs the model. GPU and hybrid are faster to read long prompts but hold a second copy of the weights. */
export type Backend = 'cpu' | 'gpu' | 'hybrid'

export interface DeviceInfo {
  memoryGb: number
  chip: string
  cores: number
}

/** One model and what it costs on this computer with the current backend. */
export interface ModelAdvice {
  id: string
  sizeGb: number // on disk
  residentGb: number // memory once loaded
  peakGb: number // memory while loading
  fit: 'fits' | 'tight' | 'too-large'
  downloaded: boolean
  recommended: boolean // the most capable model that fits
  typicalSeconds?: number // how long an answer has taken on this computer in the current mode, once known
}

export interface Settings {
  baseUrl: string
  model: string // '' = auto (the most capable downloaded model that fits in memory)
  temperature: number
  autoStartSapient: boolean
  sapientPath: string // '' = auto-detect
  theme: 'system' | 'dark' | 'light'
  backend: Backend
}

export interface SapientStatus {
  state: 'online' | 'offline' | 'starting' | 'error'
  baseUrl: string
  binary: string | null
  version?: string
  managed: boolean // we spawned the server
  resident: string[] // models loaded in memory
  downloaded: string[] // models in the local cache (`sapient list`)
  activeModel: string // model ExelSnap will use
  device: DeviceInfo
  backend: Backend // what the memory estimates below assume
  backendNote?: string // e.g. the chosen backend isn't in this SAPIENT build
  models: ModelAdvice[] // downloaded and recommended chat models, smallest first
  pulling?: string // model being downloaded
  /** Where the SAPIENT binary comes from: the copy shipped with the app, a path set in Settings, or one installed on the system. */
  engine: { source: 'bundled' | 'custom' | 'system' | 'none'; updating: boolean; note?: string }
  error?: string
}

export interface PreviewResult {
  table: string
  result: QueryResult
}

export type AppEvent =
  | { type: 'message'; conversationId: string; message: ChatMessage }
  | { type: 'conversations'; conversations: ConversationSummary[] }
  | { type: 'conversation'; conversation: Conversation }
  | { type: 'sapient'; status: SapientStatus }
  /** Files were opened from Finder / the Dock; fetch them with takeOpenedFiles(). */
  | { type: 'open-files' }
