import { FileSpreadsheet, LoaderCircle, X } from 'lucide-react'
import type { Attachment } from '@shared/types'
import { formatBytes } from '../lib/format'

export type DraftFile = Pick<Attachment, 'id' | 'name' | 'status' | 'error' | 'tables' | 'size'>

export function fileSubtitle(f: DraftFile): string {
  if (f.status === 'loading') return 'Reading…'
  if (f.status === 'error') return f.error ?? 'Could not read file'
  const rows = f.tables.reduce((s, t) => s + t.rowCount, 0)
  const sheets = f.tables.length
  return `${sheets > 1 ? `${sheets} sheets · ` : ''}${rows.toLocaleString()} rows${f.size ? ` · ${formatBytes(f.size)}` : ''}`
}

export function FileCard({ file, onOpen, onRemove }: { file: DraftFile; onOpen?: () => void; onRemove?: () => void }) {
  const Tag = onOpen ? 'button' : 'div'
  return (
    <Tag className={`file-card${file.status === 'error' ? ' error' : ''}`} onClick={onOpen} title={file.name}>
      <div className="file-icon">{file.status === 'loading' ? <LoaderCircle size={18} className="spin" /> : <FileSpreadsheet size={18} />}</div>
      <div className="meta">
        <div className="name">{file.name}</div>
        <div className="sub">{fileSubtitle(file)}</div>
      </div>
      {onRemove && (
        <span
          role="button"
          aria-label={`Remove ${file.name}`}
          className="remove"
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
        >
          <X size={12} strokeWidth={3} />
        </span>
      )}
    </Tag>
  )
}
