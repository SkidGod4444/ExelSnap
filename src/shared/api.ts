import type {
  AppEvent,
  Attachment,
  Conversation,
  ConversationSummary,
  PreviewResult,
  QueryResult,
  ResultSource,
  SapientStatus,
  Settings
} from './types'

/** Everything the renderer can ask of the main process (exposed as `window.api`). */
export interface InvokeApi {
  listConversations(): Promise<ConversationSummary[]>
  getConversation(id: string): Promise<Conversation | null>
  deleteConversation(id: string): Promise<void>
  renameConversation(id: string, title: string): Promise<void>
  attachFiles(conversationId: string | null, paths: string[]): Promise<{ conversation: Conversation; added: Attachment[] }>
  pickFiles(): Promise<string[]>
  /** Files opened from Finder / the Dock since the last call. */
  takeOpenedFiles(): Promise<string[]>
  removeAttachment(conversationId: string, attachmentId: string): Promise<Conversation>
  send(conversationId: string | null, text: string, attachmentIds: string[]): Promise<Conversation>
  stop(conversationId: string): Promise<void>
  preview(conversationId: string, table: string): Promise<PreviewResult>
  getSettings(): Promise<Settings>
  saveSettings(patch: Partial<Settings>): Promise<Settings>
  sapientStatus(): Promise<SapientStatus>
  startSapient(): Promise<SapientStatus>
  stopSapient(): Promise<SapientStatus>
  /** Download a model with `sapient pull`. Resolves when the download ends. */
  pullModel(id: string): Promise<SapientStatus>
  /** Save a result as .xlsx or .csv. With `source` the query is re-run in full (results on screen stop at 500 rows). */
  exportData(suggestedName: string, result: QueryResult, source?: ResultSource): Promise<boolean>
  revealFile(path: string): Promise<void>
  /** Save the debug log (what the app did, no spreadsheet contents) to a file the user can send in. Resolves to the saved path. */
  exportDebugLog(): Promise<string | null>
  /** Open the folder that holds the live debug log. */
  showDebugLog(): Promise<void>
}

export interface ExelSnapApi extends InvokeApi {
  platform: NodeJS.Platform
  /** Absolute path of a dropped File (Electron's webUtils). */
  pathForFile(file: File): string
  onEvent(cb: (e: AppEvent) => void): () => void
}

export const INVOKE_METHODS: (keyof InvokeApi)[] = [
  'listConversations',
  'getConversation',
  'deleteConversation',
  'renameConversation',
  'attachFiles',
  'pickFiles',
  'takeOpenedFiles',
  'removeAttachment',
  'send',
  'stop',
  'preview',
  'getSettings',
  'saveSettings',
  'sapientStatus',
  'startSapient',
  'stopSapient',
  'pullModel',
  'exportData',
  'revealFile',
  'exportDebugLog',
  'showDebugLog'
]
