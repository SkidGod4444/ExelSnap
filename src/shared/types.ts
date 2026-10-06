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

export interface Settings {
  baseUrl: string
  model: string // '' = auto (OpenHorizon default, else first served model)
  temperature: number
  autoStartSapient: boolean
  sapientPath: string // '' = auto-detect
  theme: 'system' | 'dark' | 'light'
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
