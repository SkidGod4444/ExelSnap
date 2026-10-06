import { useState } from 'react'
import { Check, ChevronDown, Download, LoaderCircle, PanelLeft, Power, Settings, SquarePen } from 'lucide-react'
import type { SapientStatus } from '@shared/types'
import { shortModel } from '../lib/format'

interface Props {
  sidebarOpen: boolean
  status: SapientStatus | null
  selectedModel: string // '' = auto
  onToggleSidebar: () => void
  onNew: () => void
  onPickModel: (model: string) => void
  onPullModel: (model: string) => void
  onStartEngine: () => void
  onStopEngine: () => void
  onOpenSettings: () => void
}

const MODE = { cpu: 'CPU', gpu: 'GPU', hybrid: 'Hybrid' } as const

const isSmall = (model: string) => Number(/(?:^|[-_/])(\d+(?:\.\d+)?)b(?:$|[-_])/i.exec(model)?.[1] ?? 0) < 7
const duration = (seconds: number) => (seconds < 90 ? `${seconds} s` : `${Math.round(seconds / 60)} min`)

export function Header(p: Props) {
  const [open, setOpen] = useState(false)
  const s = p.status
  // Chat models only (vision and speech models are downloaded through the same tool), smallest first.
  const models = (s?.models ?? []).filter((m) => m.downloaded).map((m) => m.id)
  if (p.selectedModel && !models.includes(p.selectedModel)) models.push(p.selectedModel)
  const active = s?.activeModel ?? ''
  const advice = new Map((s?.models ?? []).map((m) => [m.id, m]))
  // The best model for this computer, when it still has to be downloaded.
  const suggested = s?.models.find((m) => m.recommended && !m.downloaded)

  const describe = (id: string): string => {
    const a = advice.get(id)
    if (!a) return 'On this computer'
    const memory = `${a.residentGb} GB of memory`
    // Measured on this computer once the model has answered here; a rough word until then.
    const speed = a.typicalSeconds ? `about ${duration(a.typicalSeconds)} per answer here` : isSmall(id) ? 'quick' : s!.backend === 'cpu' ? 'slow on the CPU' : ''
    const facts = [memory, speed].filter(Boolean).join(', ')
    if (a.fit === 'too-large') return `Too large for this computer in ${MODE[s!.backend]} mode — needs ${a.peakGb} GB to load`
    if (a.fit === 'tight') return `Tight on this computer · ${memory}, ${a.peakGb} GB while loading`
    if (a.recommended) return `Recommended: the most reliable that fits · ${facts}`
    return `Less reliable · ${facts}`
  }

  const pick = (m: string) => {
    p.onPickModel(m)
    setOpen(false)
  }

  return (
    <header className={`header drag${p.sidebarOpen ? '' : ' sidebar-closed'}`}>
      {!p.sidebarOpen && (
        <>
          <button className="icon-btn" onClick={p.onToggleSidebar} title="Open sidebar" aria-label="Open sidebar">
            <PanelLeft size={20} />
          </button>
          <button className="icon-btn" onClick={p.onNew} title="New chat" aria-label="New chat">
            <SquarePen size={19} />
          </button>
        </>
      )}
      <div className="model-wrap">
        <button className="model-btn" onClick={() => setOpen(!open)}>
          ExelSnap <span className="model-name">{active ? shortModel(active) : ''}</span>
          <ChevronDown size={16} />
        </button>
        {open && (
          <>
            <div className="backdrop" onClick={() => setOpen(false)} />
            <div className="menu" style={{ top: 42, left: 0, width: 320 }}>
              <div className="menu-label">Local models</div>
              <button className="menu-item" onClick={() => pick('')}>
                <span className="grow">
                  Auto
                  <span className="desc">The best downloaded model that fits this computer{active && p.selectedModel === '' ? ` — ${shortModel(active)}` : ''}</span>
                </span>
                {p.selectedModel === '' && <Check size={16} className="check" />}
              </button>
              {models.map((m) => (
                <button key={m} className="menu-item" onClick={() => pick(m)}>
                  <span className="grow">
                    {shortModel(m)}
                    <span className={`desc${advice.get(m)?.fit === 'too-large' ? ' warn' : ''}`}>{describe(m)}</span>
                  </span>
                  {p.selectedModel === m && <Check size={16} className="check" />}
                </button>
              ))}
              {suggested && (
                <div className="menu-item static">
                  <span className="grow">
                    {shortModel(suggested.id)}
                    <span className="desc">
                      Recommended for this computer, not downloaded yet · {suggested.sizeGb} GB download, about {suggested.residentGb} GB of memory
                    </span>
                  </span>
                  <button className="btn" onClick={() => p.onPullModel(suggested.id)} disabled={!!s?.pulling || !s?.binary}>
                    {s?.pulling === suggested.id ? <LoaderCircle size={14} className="spin" /> : <Download size={14} />}
                    {s?.pulling === suggested.id ? 'Downloading…' : 'Download'}
                  </button>
                </div>
              )}
              {s && (
                <div className="menu-label" style={{ paddingBottom: 8, lineHeight: 1.5 }}>
                  This computer: {s.device.memoryGb} GB memory · {s.device.chip} · {MODE[s.backend]} mode
                </div>
              )}
              <div className="menu-sep" />
              {s?.state === 'online' ? (
                s.managed && (
                  <button className="menu-item" onClick={() => (p.onStopEngine(), setOpen(false))}>
                    <Power size={16} /> Stop SAPIENT
                  </button>
                )
              ) : (
                <button className="menu-item" onClick={() => (p.onStartEngine(), setOpen(false))} disabled={!s?.binary || s.state === 'starting'}>
                  <Power size={16} /> {s?.state === 'starting' ? 'Starting SAPIENT…' : 'Start SAPIENT'}
                </button>
              )}
              <button className="menu-item" onClick={() => (p.onOpenSettings(), setOpen(false))}>
                <Settings size={16} /> Settings
              </button>
            </div>
          </>
        )}
      </div>
      <div className="header-spacer" />
      {s && s.state !== 'online' && (
        <div className="status-pill">
          <span className={`dot ${s.state}`} />
          {s.state === 'starting' ? 'Starting SAPIENT…' : s.binary ? 'SAPIENT is offline' : 'SAPIENT not found'}
          {s.state !== 'starting' && (s.binary ? <button onClick={p.onStartEngine}>Start</button> : <button onClick={p.onOpenSettings}>Set up</button>)}
        </div>
      )}
    </header>
  )
}
