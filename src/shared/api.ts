import type {
  AppEvent,
  Attachment,
  Conversation,
  ConversationSummary,
  PreviewResult,
  QueryResult,
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
  removeAttachment(conversationId: string, attachmentId: string): Promise<Conversation>
  send(conversationId: string | null, text: string, attachmentIds: string[]): Promise<Conversation>
  stop(conversationId: string): Promise<void>
  preview(conversationId: string, table: string): Promise<PreviewResult>
  getSettings(): Promise<Settings>
  saveSettings(patch: Partial<Settings>): Promise<Settings>
  sapientStatus(): Promise<SapientStatus>
  startSapient(): Promise<SapientStatus>
  stopSapient(): Promise<SapientStatus>
  exportCsv(suggestedName: string, result: QueryResult): Promise<boolean>
  revealFile(path: string): Promise<void>
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
  'removeAttachment',
  'send',
  'stop',
  'preview',
  'getSettings',
  'saveSettings',
  'sapientStatus',
  'startSapient',
  'stopSapient',
  'exportCsv',
  'revealFile'
]
