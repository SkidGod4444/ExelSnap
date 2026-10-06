import { useEffect, useState, type ReactNode } from 'react'
import { FileSpreadsheet, FolderOpen, LoaderCircle, X } from 'lucide-react'
import type { Attachment, PreviewResult, SapientStatus, Settings } from '@shared/types'
import { formatBytes, shortModel } from '../lib/format'
import { useOutsideClose } from '../lib/hooks'
import { DataTable } from './DataTable'

function Dialog({ title, onClose, wide, children, flush }: { title: ReactNode; onClose: () => void; wide?: boolean; flush?: boolean; children: ReactNode }) {
  useOutsideClose(true, onClose)
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`dialog${wide ? ' wide' : ''}`} role="dialog" aria-modal="true">
        <div className="dialog-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={20} />
          </button>
        </div>
        <div className={`dialog-body${flush ? ' flush' : ''}`}>{children}</div>
      </div>
    </div>
  )
}

const BACKEND_HINT = {
  cpu: 'CPU only: least memory (about the size of the model). Recommended.',
  gpu: 'GPU only: the graphics chip runs the model. Needs several times the memory of CPU mode, so only small models fit.',
  hybrid: 'Hybrid: the GPU reads the prompt, the CPU writes the answer. Needs a SAPIENT build with GPU support and as much memory as GPU mode.'
} as const

/** Which model suits this computer in the current mode, in one sentence. */
function modelHint(status: SapientStatus | null): string {
  if (!status) return ''
  const best = status.models.find((m) => m.recommended)
  const where = `${status.device.memoryGb} GB of memory, ${status.backend === 'cpu' ? 'CPU' : status.backend === 'gpu' ? 'GPU' : 'hybrid'} mode`
  if (!best) return `No model fits this computer comfortably (${where}). Try CPU mode or a smaller model.`
  const name = shortModel(best.id)
  return `Best for this computer (${where}): ${name}, about ${best.residentGb} GB once loaded${best.downloaded ? '' : ' — not downloaded yet, get it from the model menu'}. Auto uses the best one you have.`
}

export function SettingsDialog({
  settings,
  status,
  onChange,
  onStart,
  onStop,
  onClose
}: {
  settings: Settings
  status: SapientStatus | null
  onChange: (patch: Partial<Settings>) => void
  onStart: () => void
  onStop: () => void
  onClose: () => void
}) {
  const [url, setUrl] = useState(settings.baseUrl)
  const [bin, setBin] = useState(settings.sapientPath)
  const models = (status?.models ?? []).filter((m) => m.downloaded).map((m) => m.id)

  return (
    <Dialog title="Settings" onClose={onClose}>
      <div className="setting-section">SAPIENT engine</div>
      <div className="setting">
        <span className={`dot ${status?.state ?? ''}`} />
        <div className="label">
          <div>
            {status?.state === 'online' ? 'Running' : status?.state === 'starting' ? 'Starting…' : status?.binary ? 'Not running' : 'Not installed'}
            {status?.version ? ` · v${status.version}` : ''}
          </div>
          <div className="hint">
            {status?.error ? status.error : status?.binary ?? 'Install with: npm i -g openhorizon, then run `openhorizon update`.'}
          </div>
        </div>
        {status?.state === 'online' ? (
          status.managed && (
            <button className="btn" onClick={onStop}>
              Stop
            </button>
          )
        ) : (
          <button className="btn primary" onClick={onStart} disabled={!status?.binary || status.state === 'starting'}>
            {status?.state === 'starting' ? <LoaderCircle size={14} className="spin" /> : null} Start
          </button>
        )}
      </div>
      <div className="setting">
        <div className="label">
          <div>Model</div>
          <div className="hint">{modelHint(status)}</div>
        </div>
        <select className="field" value={settings.model} onChange={(e) => onChange({ model: e.target.value })}>
          <option value="">Auto ({status ? shortModel(status.activeModel) : '…'})</option>
          {models.map((m) => (
            <option key={m} value={m}>
              {shortModel(m)}
            </option>
          ))}
          {settings.model && !models.includes(settings.model) && <option value={settings.model}>{shortModel(settings.model)}</option>}
        </select>
      </div>
      <div className="setting">
        <div className="label">
          <div>Run models on</div>
          <div className="hint">
            {BACKEND_HINT[settings.backend]}
            {status?.backendNote ? ` ${status.backendNote}` : ''}
            {status?.state === 'online' && !status.managed
              ? ' SAPIENT was started outside ExelSnap: set this to the mode you started it in, the memory estimates rely on it. (Started without options it runs on the GPU and keeps 3 models loaded.)'
              : ''}
          </div>
        </div>
        <div className="segmented">
          {(['cpu', 'gpu', 'hybrid'] as const).map((b) => (
            <button key={b} className={settings.backend === b ? 'on' : ''} onClick={() => settings.backend !== b && onChange({ backend: b })}>
              {b === 'cpu' ? 'CPU' : b === 'gpu' ? 'GPU' : 'Hybrid'}
            </button>
          ))}
        </div>
      </div>
      <div className="setting">
        <div className="label">
          <div>Start SAPIENT automatically</div>
          <div className="hint">Launch `sapient serve` when ExelSnap opens or when you send a message.</div>
        </div>
        <button
          className={`switch${settings.autoStartSapient ? ' on' : ''}`}
          role="switch"
          aria-checked={settings.autoStartSapient}
          onClick={() => onChange({ autoStartSapient: !settings.autoStartSapient })}
        />
      </div>
      <div className="setting">
        <div className="label">
          <div>Server URL</div>
          <div className="hint">OpenAI-compatible endpoint.</div>
        </div>
        <input className="field" style={{ width: 240 }} value={url} onChange={(e) => setUrl(e.target.value)} onBlur={() => url !== settings.baseUrl && onChange({ baseUrl: url.trim() })} />
      </div>
      <div className="setting">
        <div className="label">
          <div>SAPIENT binary</div>
          <div className="hint">Leave empty to auto-detect.</div>
        </div>
        <input
          className="field"
          style={{ width: 240 }}
          placeholder={status?.binary ?? '/usr/local/bin/sapient'}
          value={bin}
          onChange={(e) => setBin(e.target.value)}
          onBlur={() => bin !== settings.sapientPath && onChange({ sapientPath: bin.trim() })}
        />
      </div>
      <div className="setting">
        <div className="label">
          <div>Temperature</div>
          <div className="hint">Lower is more precise. {settings.temperature.toFixed(1)}</div>
        </div>
        <input type="range" min={0} max={1} step={0.1} value={settings.temperature} onChange={(e) => onChange({ temperature: Number(e.target.value) })} />
      </div>

      <div className="setting-section">Help</div>
      <div className="setting">
        <div className="label">
          <div>Debug log</div>
          <div className="hint">
            Records what the app does — your questions, the queries the model writes, timings and errors — but never the rows of your spreadsheets. Export it and
            send the file with a bug report.
          </div>
        </div>
        <button className="btn" onClick={() => void window.api.showDebugLog()}>
          Show folder
        </button>
        <button className="btn primary" onClick={() => void window.api.exportDebugLog()}>
          Export…
        </button>
      </div>

      <div className="setting-section">Appearance</div>
      <div className="setting">
        <div className="label">
          <div>Theme</div>
        </div>
        <div className="segmented">
          {(['system', 'light', 'dark'] as const).map((t) => (
            <button key={t} className={settings.theme === t ? 'on' : ''} onClick={() => onChange({ theme: t })}>
              {t[0].toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
      </div>
    </Dialog>
  )
}

export function PreviewDialog({ conversationId, attachment, onClose }: { conversationId: string; attachment: Attachment; onClose: () => void }) {
  const [table, setTable] = useState(attachment.tables[0]?.table ?? '')
  const [data, setData] = useState<PreviewResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const info = attachment.tables.find((t) => t.table === table)

  useEffect(() => {
    if (!table) return
    setData(null)
    setError(null)
    window.api
      .preview(conversationId, table)
      .then(setData)
      .catch((e) => setError(String(e?.message ?? e)))
  }, [conversationId, table])

  return (
    <Dialog
      wide
      flush
      onClose={onClose}
      title={
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
          <span className="file-icon" style={{ width: 28, height: 28, borderRadius: 7 }}>
            <FileSpreadsheet size={15} />
          </span>
          {attachment.name}
          <button className="icon-btn sm" title="Show in folder" onClick={() => void window.api.revealFile(attachment.path)}>
            <FolderOpen size={16} />
          </button>
        </span>
      }
    >
      <div className="preview">
        {attachment.tables.length > 1 && (
          <div className="tabs">
            {attachment.tables.map((t) => (
              <button key={t.table} className={`chip-btn${t.table === table ? ' active' : ''}`} onClick={() => setTable(t.table)}>
                {t.sheet}
              </button>
            ))}
          </div>
        )}
        {info && (
          <div className="preview-meta">
            <span>
              Table <code>{info.table}</code>
            </span>
            <span>{info.rowCount.toLocaleString()} rows</span>
            <span>{info.columns.length} columns</span>
            {attachment.size > 0 && <span>{formatBytes(attachment.size)}</span>}
            {info.notes.map((n) => (
              <span key={n}>{n}</span>
            ))}
          </div>
        )}
        {error && <div className="tool-error" style={{ margin: 16 }}>{error}</div>}
        {!data && !error && (
          <div className="preview-meta">
            <LoaderCircle size={14} className="spin" /> Loading…
          </div>
        )}
        {data && <DataTable result={data.result} name={table} tall showTypes source={{ conversationId, sql: `SELECT * FROM "${table}"` }} />}
      </div>
    </Dialog>
  )
}

export function DropOverlay() {
  return (
    <div className="drop-overlay">
      <div className="drop-box">
        <div className="icons">
          <div className="file-icon">
            <FileSpreadsheet size={24} />
          </div>
        </div>
        <h2>Add spreadsheets</h2>
        <p>Drop .xlsx, .xls, .csv or .ods files to analyze them locally</p>
      </div>
    </div>
  )
}
