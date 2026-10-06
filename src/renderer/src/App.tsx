import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ChartLine, FileSpreadsheet, ListOrdered, Paperclip, ShieldCheck, Sparkles } from 'lucide-react'
import type { Attachment, ChatMessage, Conversation, ConversationSummary, SapientStatus, Settings, TableInfo } from '@shared/types'
import { Composer, type ComposerHandle } from './components/Composer'
import { DropOverlay, PreviewDialog, SettingsDialog } from './components/Dialogs'
import type { DraftFile } from './components/FileCard'
import { Header } from './components/Header'
import { AssistantMessage, UserMessage } from './components/Message'
import { Sidebar } from './components/Sidebar'

const api = window.api
const SUPPORTED = /\.(xlsx|xlsm|xlsb|xls|ods|csv|tsv)$/i

function readPref(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key)
    return v === null ? fallback : v === '1'
  } catch {
    return fallback
  }
}

function suggestionsFor(tables: TableInfo[]): { icon: typeof Sparkles; label: string; prompt: string }[] {
  const out = [{ icon: Sparkles, label: 'Summarize this data', prompt: 'Give me a quick overview of this data: what each table contains, the key totals, and anything notable.' }]
  const t = tables[0]
  if (t) {
    const nums = t.columns.filter((c) => (c.type === 'DOUBLE' || c.type === 'BIGINT') && !/(^|_)(id|code|year|zip|phone)$/i.test(c.name))
    const num = nums.find((c) => /revenue|sales|amount|total|profit|cost|price|value|spend|income/i.test(c.name)) ?? nums[0]
    const cat = t.columns.find((c) => c.type === 'VARCHAR' && c.distinct > 1 && c.distinct <= 50)
    const date = t.columns.find((c) => c.type === 'DATE' || c.type === 'TIMESTAMP')
    if (num && cat) out.push({ icon: ListOrdered, label: `Top ${cat.header} by ${num.header}`, prompt: `What are the top 5 ${cat.header} by total ${num.header}?` })
    if (num && date) out.push({ icon: ChartLine, label: `${num.header} by month`, prompt: `Chart total ${num.header} by month as a line chart.` })
  }
  out.push({ icon: ShieldCheck, label: 'Check data quality', prompt: 'Check this data for quality issues: empty values, duplicate rows and obvious outliers. Use queries to verify.' })
  return out
}

export default function App() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [status, setStatus] = useState<SapientStatus | null>(null)
  const [summaries, setSummaries] = useState<ConversationSummary[]>([])
  const [conv, setConv] = useState<Conversation | null>(null)
  const [draft, setDraft] = useState<DraftFile[]>([])
  const [sidebarOpen, setSidebarOpen] = useState(() => readPref('sidebar', true))
  const [showSettings, setShowSettings] = useState(false)
  const [preview, setPreview] = useState<Attachment | null>(null)
  const [dragging, setDragging] = useState(false)
  const [atBottom, setAtBottom] = useState(true)

  const convRef = useRef<Conversation | null>(null)
  convRef.current = conv
  const composer = useRef<ComposerHandle>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const attachChain = useRef<Promise<unknown>>(Promise.resolve())

  // ------------------------------------------------------------ bootstrap + events
  useEffect(() => {
    void api.getSettings().then(setSettings)
    void api.listConversations().then(setSummaries)
    void api.sapientStatus().then(setStatus)
    return api.onEvent((e) => {
      if (e.type === 'sapient') setStatus(e.status)
      else if (e.type === 'conversations') setSummaries(e.conversations)
      else if (e.type === 'conversation') setConv((c) => (c?.id === e.conversation.id ? e.conversation : c))
      else if (e.type === 'message')
        setConv((c) => {
          if (!c || c.id !== e.conversationId) return c
          const i = c.messages.findIndex((m) => m.id === e.message.id)
          const messages = i >= 0 ? c.messages.map((m, j) => (j === i ? e.message : m)) : [...c.messages, e.message]
          return { ...c, messages }
        })
    })
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem('sidebar', sidebarOpen ? '1' : '0')
    } catch {
      /* storage unavailable */
    }
  }, [sidebarOpen])

  // ------------------------------------------------------------ scrolling
  const scrollToBottom = useCallback((smooth = false) => {
    const el = scroller.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
    stick.current = true
  }, [])

  useLayoutEffect(() => {
    if (stick.current) scrollToBottom()
  }, [conv?.messages, scrollToBottom])

  const onScroll = () => {
    const el = scroller.current
    if (!el) return
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    stick.current = bottom
    setAtBottom(bottom)
  }

  // ------------------------------------------------------------ actions
  const newChat = useCallback(() => {
    setConv(null)
    setDraft([])
    stick.current = true
    requestAnimationFrame(() => composer.current?.focus())
  }, [])

  const selectChat = useCallback(async (id: string) => {
    const c = await api.getConversation(id)
    if (!c) return
    setConv(c)
    setDraft([])
    stick.current = true
    requestAnimationFrame(() => scrollToBottom())
  }, [scrollToBottom])

  const attachPaths = useCallback((paths: string[]) => {
    if (paths.length === 0) return
    const placeholders: DraftFile[] = paths.map((p) => ({
      id: `tmp-${Math.random().toString(36).slice(2)}`,
      name: p.split(/[\\/]/).pop() ?? p,
      status: SUPPORTED.test(p) ? 'loading' : 'error',
      error: SUPPORTED.test(p) ? undefined : 'Not a spreadsheet (.xlsx, .xls, .csv, .ods)',
      tables: [],
      size: 0
    }))
    setDraft((d) => [...d, ...placeholders])
    const valid = paths.filter((p) => SUPPORTED.test(p))
    const loading = placeholders.filter((p) => p.status === 'loading').map((p) => p.id)
    if (valid.length === 0) return
    // Serialize so two quick drops don't create two conversations.
    attachChain.current = attachChain.current.then(async () => {
      try {
        const res = await api.attachFiles(convRef.current?.id ?? null, valid)
        convRef.current = res.conversation
        setConv(res.conversation)
        setDraft((d) => {
          const rest = d.filter((f) => !loading.includes(f.id))
          const fresh = res.added.filter((a) => !rest.some((r) => r.id === a.id))
          return [...rest, ...fresh]
        })
      } catch (err) {
        setDraft((d) => d.map((f) => (loading.includes(f.id) ? { ...f, status: 'error', error: String((err as Error)?.message ?? err) } : f)))
      }
    })
  }, [])

  const pickFiles = useCallback(async () => attachPaths(await api.pickFiles()), [attachPaths])

  const removeDraft = useCallback(async (id: string) => {
    setDraft((d) => d.filter((f) => f.id !== id))
    const c = convRef.current
    if (c && !id.startsWith('tmp-') && c.attachments.some((a) => a.id === id)) setConv(await api.removeAttachment(c.id, id))
  }, [])

  const send = useCallback(
    async (text: string) => {
      const ids = draft.filter((f) => f.status === 'ready').map((f) => f.id)
      if (!text && ids.length === 0) return
      stick.current = true
      const c = await api.send(convRef.current?.id ?? null, text, ids)
      setConv(c)
      setDraft([])
      requestAnimationFrame(() => scrollToBottom())
    },
    [draft, scrollToBottom]
  )

  const retry = useCallback(() => {
    const lastUser = [...(convRef.current?.messages ?? [])].reverse().find((m) => m.role === 'user')
    const text = lastUser?.parts.map((p) => (p.kind === 'text' ? p.text : '')).join('') ?? ''
    if (text) void send(text)
  }, [send])

  const stop = useCallback(() => {
    if (convRef.current) void api.stop(convRef.current.id)
  }, [])

  const updateSettings = useCallback(async (patch: Partial<Settings>) => setSettings(await api.saveSettings(patch)), [])
  const startEngine = useCallback(async () => setStatus(await api.startSapient()), [])
  const stopEngine = useCallback(async () => setStatus(await api.stopSapient()), [])

  const deleteChat = useCallback(
    async (id: string) => {
      await api.deleteConversation(id)
      if (convRef.current?.id === id) newChat()
    },
    [newChat]
  )

  const openAttachment = useCallback((idOrAtt: string | Attachment) => {
    const c = convRef.current
    const att = typeof idOrAtt === 'string' ? c?.attachments.find((a) => a.id === idOrAtt) : c?.attachments.find((a) => a.id === idOrAtt.id) ?? idOrAtt
    if (att) setPreview(att)
  }, [])

  // Hook for scripts/snap.cjs (UI screenshots). Grants nothing beyond what window.api already exposes.
  useEffect(() => {
    ;(window as unknown as { __exelsnap: unknown }).__exelsnap = { attachPaths, send, openSettings: () => setShowSettings(true) }
  }, [attachPaths, send])

  // ------------------------------------------------------------ keyboard + drag & drop
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (!mod) return
      const k = e.key.toLowerCase()
      if (e.shiftKey && k === 'o') (e.preventDefault(), newChat())
      else if (e.shiftKey && k === 's') (e.preventDefault(), setSidebarOpen((o) => !o))
      else if (!e.shiftKey && k === 'o') (e.preventDefault(), void pickFiles())
      else if (k === ',') (e.preventDefault(), setShowSettings(true))
    }
    let depth = 0
    const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files')
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth++
      setDragging(true)
    }
    const over = (e: DragEvent) => hasFiles(e) && e.preventDefault()
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return
      depth = Math.max(0, depth - 1)
      if (depth === 0) setDragging(false)
    }
    const drop = (e: DragEvent) => {
      e.preventDefault()
      depth = 0
      setDragging(false)
      const files = [...(e.dataTransfer?.files ?? [])]
      attachPaths(files.map((f) => api.pathForFile(f)).filter(Boolean))
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragover', over)
    window.addEventListener('dragleave', leave)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragover', over)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('drop', drop)
    }
  }, [attachPaths, newChat, pickFiles])

  // ------------------------------------------------------------ derived
  const messages: ChatMessage[] = conv?.messages ?? []
  const last = messages[messages.length - 1]
  const running = !!last && last.role === 'assistant' && (last.status === 'thinking' || last.status === 'streaming')
  const readyDraft = draft.filter((f) => f.status === 'ready')
  const dataName = readyDraft[readyDraft.length - 1]?.name ?? conv?.attachments[conv.attachments.length - 1]?.name
  const tables = useMemo(() => [...(conv?.attachments ?? []).flatMap((a) => a.tables)], [conv?.attachments])
  const empty = messages.length === 0

  const composerEl = (
    <Composer
      ref={composer}
      files={draft}
      running={running}
      hasData={tables.length > 0}
      dataName={dataName}
      onSend={(t) => void send(t)}
      onStop={stop}
      onAttach={() => void pickFiles()}
      onRemoveFile={(id) => void removeDraft(id)}
      onOpenFile={openAttachment}
    />
  )

  return (
    <div className="app">
      <Sidebar
        open={sidebarOpen}
        conversations={summaries}
        activeId={conv?.id ?? null}
        status={status}
        onToggle={() => setSidebarOpen(false)}
        onNew={newChat}
        onSelect={(id) => void selectChat(id)}
        onRename={(id, t) => void api.renameConversation(id, t)}
        onDelete={(id) => void deleteChat(id)}
        onOpenSettings={() => setShowSettings(true)}
      />

      <main className="main">
        <Header
          sidebarOpen={sidebarOpen}
          status={status}
          selectedModel={settings?.model ?? ''}
          onToggleSidebar={() => setSidebarOpen(true)}
          onNew={newChat}
          onPickModel={(m) => void updateSettings({ model: m })}
          onStartEngine={() => void startEngine()}
          onStopEngine={() => void stopEngine()}
          onOpenSettings={() => setShowSettings(true)}
        />

        {empty ? (
          <div className="empty">
            <h1>{tables.length ? 'What should we look at?' : 'What should we analyze today?'}</h1>
            <div className="composer-wrap centered">{composerEl}</div>
            <div className="suggestions">
              {tables.length > 0 ? (
                suggestionsFor(tables).map((s) => (
                  <button key={s.label} className="suggestion" onClick={() => void send(s.prompt)} disabled={running}>
                    <s.icon size={16} /> {s.label}
                  </button>
                ))
              ) : (
                <button className="suggestion" onClick={() => void pickFiles()}>
                  <Paperclip size={16} /> Attach a spreadsheet
                </button>
              )}
            </div>
            {tables.length === 0 && (
              <p className="empty-note">
                <FileSpreadsheet size={14} style={{ verticalAlign: '-2px' }} /> Drop an Excel or CSV file anywhere. It never leaves this computer —
                <br />
                SAPIENT runs the model locally and DuckDB crunches the numbers.
              </p>
            )}
          </div>
        ) : (
          <>
            <div className="scroller" ref={scroller} onScroll={onScroll}>
              <div className="thread">
                {messages.map((m, i) =>
                  m.role === 'user' ? (
                    <UserMessage key={m.id} message={m} onOpenFile={openAttachment} />
                  ) : (
                    <AssistantMessage key={m.id} message={m} isLast={i === messages.length - 1} onRetry={retry} onStartEngine={() => void startEngine()} />
                  )
                )}
              </div>
            </div>
            {!atBottom && (
              <button className="scroll-down" onClick={() => scrollToBottom(true)} aria-label="Scroll to bottom">
                <ArrowDown size={18} />
              </button>
            )}
            <div className="composer-wrap">
              {composerEl}
              <div className="disclaimer">ExelSnap runs fully offline. Local models can make mistakes — check the query results.</div>
            </div>
          </>
        )}
      </main>

      {dragging && <DropOverlay />}
      {showSettings && settings && (
        <SettingsDialog
          settings={settings}
          status={status}
          onChange={(p) => void updateSettings(p)}
          onStart={() => void startEngine()}
          onStop={() => void stopEngine()}
          onClose={() => setShowSettings(false)}
        />
      )}
      {preview && conv && <PreviewDialog conversationId={conv.id} attachment={preview} onClose={() => setPreview(null)} />}
    </div>
  )
}
