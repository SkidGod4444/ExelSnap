import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { ArrowUp, Plus, Square } from 'lucide-react'
import { FileCard, type DraftFile } from './FileCard'

export interface ComposerHandle {
  focus(): void
  setText(t: string): void
}

interface Props {
  files: DraftFile[]
  running: boolean
  hasData: boolean
  dataName?: string
  onSend: (text: string) => void
  onStop: () => void
  onAttach: () => void
  onRemoveFile: (id: string) => void
  onOpenFile: (id: string) => void
}

export const Composer = forwardRef<ComposerHandle, Props>(function Composer(
  { files, running, hasData, dataName, onSend, onStop, onAttach, onRemoveFile, onOpenFile },
  ref
) {
  const [text, setText] = useState('')
  const ta = useRef<HTMLTextAreaElement>(null)

  useImperativeHandle(ref, () => ({
    focus: () => ta.current?.focus(),
    setText: (t) => {
      setText(t)
      requestAnimationFrame(() => ta.current?.focus())
    }
  }))

  // Auto-grow up to the CSS max-height.
  useEffect(() => {
    const el = ta.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = `${el.scrollHeight}px`
  }, [text])

  useEffect(() => ta.current?.focus(), [])

  const loading = files.some((f) => f.status === 'loading')
  const readyFiles = files.filter((f) => f.status === 'ready')
  const canSend = !running && !loading && (text.trim().length > 0 || readyFiles.length > 0)

  const submit = () => {
    if (!canSend) return
    onSend(text.trim())
    setText('')
  }

  const placeholder = dataName ? `Ask anything about ${dataName}` : hasData ? 'Ask anything about your data' : 'Attach a spreadsheet, then ask anything'

  return (
    <div className="composer" onClick={(e) => e.target === e.currentTarget && ta.current?.focus()}>
      {files.length > 0 && (
        <div className="composer-files">
          {files.map((f) => (
            <FileCard key={f.id} file={f} onOpen={f.status === 'ready' ? () => onOpenFile(f.id) : undefined} onRemove={() => onRemoveFile(f.id)} />
          ))}
        </div>
      )}
      <textarea
        ref={ta}
        rows={1}
        value={text}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            submit()
          }
        }}
      />
      <div className="composer-bar">
        <button className="round" onClick={onAttach} title="Attach spreadsheet (⌘O)" aria-label="Attach spreadsheet">
          <Plus size={20} />
        </button>
        <div className="grow" />
        {running ? (
          <button className="send-btn" onClick={onStop} title="Stop" aria-label="Stop">
            <Square size={14} fill="currentColor" />
          </button>
        ) : (
          <button className="send-btn" onClick={submit} disabled={!canSend} title="Send" aria-label="Send">
            <ArrowUp size={20} strokeWidth={2.25} />
          </button>
        )}
      </div>
    </div>
  )
})
