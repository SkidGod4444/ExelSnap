import { memo, useState } from 'react'
import { Check, CircleAlert, Copy, RotateCcw } from 'lucide-react'
import type { Attachment, ChatMessage, ToolPart } from '@shared/types'
import { CodeBlock, CodeBlockActions, CodeBlockCopyButton, CodeBlockHeader, CodeBlockTitle } from '@/components/ai-elements/code-block'
import { Message, MessageAction, MessageActions, MessageContent, MessageResponse } from '@/components/ai-elements/message'
import { Shimmer } from '@/components/ai-elements/shimmer'
import { Tool, ToolContent, ToolHeader } from '@/components/ai-elements/tool'
import { shortModel } from '../lib/format'
import { useCopy } from '../lib/hooks'
import { ChartView } from './ChartView'
import { DataTable } from './DataTable'
import { FileCard } from './FileCard'

export function UserMessage({ message, onOpenFile }: { message: ChatMessage; onOpenFile: (a: Attachment) => void }) {
  const text = message.parts.map((p) => (p.kind === 'text' ? p.text : '')).join('')
  return (
    <Message from="user" className="msg msg-user max-w-[85%]">
      {!!message.attachments?.length && (
        <div className="files ml-auto flex flex-wrap justify-end gap-2">
          {message.attachments.map((a) => (
            <FileCard key={a.id} file={a} onOpen={() => onOpenFile(a)} />
          ))}
        </div>
      )}
      {text && (
        <MessageContent className="select-text whitespace-pre-wrap break-words text-base leading-relaxed group-[.is-user]:rounded-3xl group-[.is-user]:px-5 group-[.is-user]:py-2.5">
          {text}
        </MessageContent>
      )}
    </Message>
  )
}

function toolLabel(p: ToolPart): string {
  const secs = p.durationMs != null ? ` · ${p.durationMs < 1000 ? `${p.durationMs} ms` : `${(p.durationMs / 1000).toFixed(1)} s`}` : ''
  if (p.status === 'running') return p.name === 'make_chart' ? 'Building chart' : 'Running query'
  if (p.status === 'error') return 'Query failed'
  if (p.name === 'make_chart') return `Built ${p.chart?.type ?? ''} chart${secs}`
  const n = p.result?.rowCount ?? 0
  return `Queried data · ${p.result?.truncated ? `${n}+` : n} row${n === 1 ? '' : 's'}${secs}`
}

// Everything is offline, so an image in a reply can never load; the chart is drawn by make_chart instead.
const stripImages = (md: string) => md.replace(/!\[[^\]]*\]\([^)]*\)/g, '')

const TOOL_STATE = { running: 'input-available', done: 'output-available', error: 'output-error' } as const

function ToolStep({ part, defaultOpen, conversationId }: { part: ToolPart; defaultOpen: boolean; conversationId: string }) {
  const [open, setOpen] = useState(false)
  const sql = typeof part.args.sql === 'string' ? part.args.sql : JSON.stringify(part.args, null, 2)
  const source = typeof part.args.sql === 'string' ? { conversationId, sql: part.args.sql } : undefined
  const showResult = part.status === 'done' && part.result && !part.chart && (defaultOpen || open)
  return (
    <div className="tool-step flex flex-col gap-2">
      <Tool className="mb-0 rounded-xl" open={open} onOpenChange={setOpen}>
        <ToolHeader className="tool-head" type={`tool-${part.name}`} state={TOOL_STATE[part.status]} title={toolLabel(part)} />
        <ToolContent className="space-y-3 pt-0">
          {part.error && <div className="whitespace-pre-wrap rounded-md bg-destructive/10 p-3 font-mono text-destructive text-xs">{part.error}</div>}
          <CodeBlock code={sql.trim()} language="sql">
            <CodeBlockHeader>
              <CodeBlockTitle>sql</CodeBlockTitle>
              <CodeBlockActions>
                <CodeBlockCopyButton />
              </CodeBlockActions>
            </CodeBlockHeader>
          </CodeBlock>
        </ToolContent>
      </Tool>
      {showResult && <DataTable result={part.result!} source={source} />}
      {part.chart && part.result && <ChartView spec={part.chart} result={part.result} source={source} />}
    </div>
  )
}

export const AssistantMessage = memo(function AssistantMessage({
  message,
  conversationId,
  isLast,
  onRetry,
  onStartEngine
}: {
  message: ChatMessage
  conversationId: string
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
  const thinkingLabel = lastTool?.status === 'done' || lastTool?.status === 'error' ? 'Reading the results' : 'Thinking'

  return (
    <Message from="assistant" className="msg msg-assistant max-w-full">
      <MessageContent className="w-full select-text gap-3 overflow-visible text-base leading-7">
        {parts.map((p, i) =>
          p.kind === 'text' ? (
            p.text ? (
              <MessageResponse key={i} className="md" isAnimating={message.status === 'streaming'}>
                {stripImages(p.text)}
              </MessageResponse>
            ) : null
          ) : (
            <ToolStep key={p.id} part={p} defaultOpen={p.id === lastResultId} conversationId={conversationId} />
          )
        )}

        {busy && message.status === 'thinking' && !(lastTool?.status === 'running') && (
          <div className="thinking">
            <Shimmer as="span" className="text-[15px]">
              {thinkingLabel}
            </Shimmer>
          </div>
        )}

        {message.status === 'stopped' && <div className="text-muted-foreground text-sm">Stopped</div>}
        {message.status === 'done' && parts.length === 0 && (
          <div className="text-muted-foreground text-sm">The model didn't return an answer. Try asking again.</div>
        )}

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
      </MessageContent>

      {!busy && message.status !== 'error' && (
        <MessageActions className={`-ml-2 gap-0.5 transition-opacity ${isLast ? '' : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100'}`}>
          {text && (
            <MessageAction tooltip="Copy" onClick={() => copy(text)}>
              {copied ? <Check /> : <Copy />}
            </MessageAction>
          )}
          {isLast && (
            <MessageAction tooltip="Ask again" onClick={onRetry}>
              <RotateCcw />
            </MessageAction>
          )}
          {message.model && (
            <span className="ml-1.5 text-muted-foreground text-xs">
              {shortModel(message.model)}
              {message.durationMs ? ` · ${(message.durationMs / 1000).toFixed(1)}s` : ''}
            </span>
          )}
        </MessageActions>
      )}
    </Message>
  )
})
