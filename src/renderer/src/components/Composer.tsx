import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { ArrowUp, Plus, Square } from 'lucide-react'
import {
  PromptInput,
  PromptInputBody,
  PromptInputButton,
  PromptInputFooter,
  PromptInputHeader,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  usePromptInputAttachments
} from '@/components/ai-elements/prompt-input'
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

/**
 * PromptInput keeps its own list of dropped/pasted File objects and inlines them as data URLs on submit.
 * Spreadsheets are attached by path through Electron instead (button, window drop, Finder), so discard that list.
 */
function DiscardFormFiles() {
  const attachments = usePromptInputAttachments()
  const count = attachments.files.length
  useEffect(() => {
    if (count > 0) attachments.clear()
  }, [count, attachments])
  return null
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
    <PromptInput className="composer" onSubmit={submit}>
      <DiscardFormFiles />
      {files.length > 0 && (
        <PromptInputHeader className="composer-files gap-2 px-3 pt-3">
          {files.map((f) => (
            <FileCard key={f.id} file={f} onOpen={f.status === 'ready' ? () => onOpenFile(f.id) : undefined} onRemove={() => onRemoveFile(f.id)} />
          ))}
        </PromptInputHeader>
      )}
      <PromptInputBody>
        <PromptInputTextarea
          ref={ta}
          value={text}
          placeholder={placeholder}
          onChange={(e) => setText(e.target.value)}
          className="max-h-52 min-h-12 px-4 pt-3.5 text-base md:text-base"
        />
      </PromptInputBody>
      <PromptInputFooter className="px-2.5 pb-2.5">
        <PromptInputTools>
          <PromptInputButton
            className="rounded-full"
            size="icon-sm"
            onClick={onAttach}
            aria-label="Attach spreadsheet"
            tooltip={{ content: 'Attach spreadsheet', shortcut: window.api.platform === 'darwin' ? '⌘O' : 'Ctrl+O' }}
          >
            <Plus className="size-5" />
          </PromptInputButton>
        </PromptInputTools>
        <PromptInputSubmit
          className="send-btn rounded-full"
          aria-label={running ? 'Stop' : 'Send'}
          status={running ? 'streaming' : 'ready'}
          onStop={onStop}
          disabled={!running && !canSend}
        >
          {running ? <Square className="size-3.5" fill="currentColor" /> : <ArrowUp className="size-5" strokeWidth={2.25} />}
        </PromptInputSubmit>
      </PromptInputFooter>
    </PromptInput>
  )
})
