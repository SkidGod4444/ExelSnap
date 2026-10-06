import { memo, useState } from 'react'
import { Check, ChevronRight, CircleAlert, Copy, Database, LoaderCircle, RotateCcw } from 'lucide-react'
import type { Attachment, ChatMessage, ToolPart } from '@shared/types'
import { shortModel } from '../lib/format'
import { useCopy } from '../lib/hooks'
import { ChartView } from './ChartView'
import { DataTable } from './DataTable'
import { FileCard } from './FileCard'
import { CodeBlock, Markdown } from './Markdown'

export function UserMessage({ message, onOpenFile }: { message: ChatMessage; onOpenFile: (a: Attachment) => void }) {
  const text = message.parts.map((p) => (p.kind === 'text' ? p.text : '')).join('')
  return (
    <div className="msg msg-user">
      {!!message.attachments?.length && (
        <div className="files">
          {message.attachments.map((a) => (
            <FileCard key={a.id} file={a} onOpen={() => onOpenFile(a)} />
          ))}
        </div>
      )}
      {text && <div className="bubble">{text}</div>}
    </div>
  )
}

function toolLabel(p: ToolPart): string {
  const secs = p.durationMs != null ? ` · ${p.durationMs < 1000 ? `${p.durationMs} ms` : `${(p.durationMs / 1000).toFixed(1)} s`}` : ''
  if (p.status === 'running') return p.name === 'make_chart' ? 'Building chart' : 'Running query'
  if (p.status === 'error') return `Query failed${p.error ? ` — ${p.error.split('\n')[0]}` : ''}`
  if (p.name === 'make_chart') return `Built ${p.chart?.type ?? ''} chart${secs}`
  const n = p.result?.rowCount ?? 0
  return `Queried data · ${p.result?.truncated ? `${n}+` : n} row${n === 1 ? '' : 's'}${secs}`
}

function ToolStep({ part, defaultOpen }: { part: ToolPart; defaultOpen: boolean }) {
  const [open, setOpen] = useState(false)
  const sql = typeof part.args.sql === 'string' ? part.args.sql : JSON.stringify(part.args, null, 2)
  const running = part.status === 'running'
  const showResult = part.status === 'done' && part.result && !part.chart && (defaultOpen || open)
  return (
    <div className="tool">
      <button className={`tool-head${part.status === 'error' ? ' error' : ''}`} onClick={() => setOpen(!open)} disabled={running}>
        {running ? <LoaderCircle size={15} className="spin" /> : <Database size={15} />}
        <span className={`label${running ? ' shimmer' : ''}`}>{toolLabel(part)}</span>
        {!running && <ChevronRight size={15} className={`chev${open ? ' open' : ''}`} />}
      </button>
      {open && (
        <div className="tool-body">
          {part.error && <div className="tool-error">{part.error}</div>}
          <CodeBlock code={sql.trim()} lang="sql" />
        </div>
      )}
      {showResult && <DataTable result={part.result!} />}
      {part.chart && part.result && <ChartView spec={part.chart} result={part.result} />}
    </div>
  )
}

export const AssistantMessage = memo(function AssistantMessage({
  message,
  isLast,
  onRetry,
  onStartEngine
}: {
  message: ChatMessage
  isLast: boolean
  onRetry: () => void
  onStartEngine: () => void
}) {
  const [copied, copy] = useCopy()
  const busy = message.status === 'thinking' || message.status === 'streaming'
  const parts = message.parts
  const lastTool = [...parts].reverse().find((p): p is ToolPart => p.kind === 'tool')
  // Show the newest successful query's table inline; older ones collapse behind their header.
  const lastResultId = [...parts].reverse().find((p): p is ToolPart => p.kind === 'tool' && p.status === 'done' && !!p.result && !p.chart)?.id
  const text = parts.map((p) => (p.kind === 'text' ? p.text : '')).filter(Boolean).join('\n\n')
  const offline = message.error && /reach SAPIENT|ECONNREFUSED|not installed/i.test(message.error)

  let thinkingLabel = 'Thinking'
  if (lastTool?.status === 'done' || lastTool?.status === 'error') thinkingLabel = 'Reading the results'
  if (parts.length === 0 && message.status === 'thinking') thinkingLabel = 'Thinking'

  return (
    <div className="msg msg-assistant">
      {parts.map((p, i) =>
        p.kind === 'text' ? (
          p.text ? <Markdown key={i} text={p.text} /> : null
        ) : (
          <ToolStep key={p.id} part={p} defaultOpen={p.id === lastResultId} />
        )
      )}

      {busy && message.status === 'thinking' && !(lastTool?.status === 'running') && (
        <div className="thinking">
          <span className="orb" />
          <span className="shimmer">{thinkingLabel}</span>
        </div>
      )}

      {message.status === 'stopped' && <div className="stopped-note">Stopped</div>}
      {message.status === 'done' && parts.length === 0 && <div className="stopped-note">The model didn't return an answer. Try asking again.</div>}

      {message.status === 'error' && (
        <div className="error-card">
          <CircleAlert size={18} />
          <div>
            <div>{message.error}</div>
            <div className="actions">
              {offline && (
                <button className="btn primary" onClick={onStartEngine}>
                  Start SAPIENT
                </button>
              )}
              <button className="btn" onClick={onRetry}>
                <RotateCcw size={14} /> Retry
              </button>
            </div>
          </div>
        </div>
      )}

      {!busy && message.status !== 'error' && (
        <div className={`msg-actions${isLast ? ' visible' : ''}`}>
          {text && (
            <button className="icon-btn sm" onClick={() => copy(text)} title="Copy">
              {copied ? <Check size={16} /> : <Copy size={16} />}
            </button>
          )}
          {isLast && (
            <button className="icon-btn sm" onClick={onRetry} title="Ask again">
              <RotateCcw size={16} />
            </button>
          )}
          {message.model && (
            <span className="meta">
              {shortModel(message.model)}
              {message.durationMs ? ` · ${(message.durationMs / 1000).toFixed(1)}s` : ''}
            </span>
          )}
        </div>
      )}
    </div>
  )
})
