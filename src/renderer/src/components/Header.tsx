import { useState } from 'react'
import { Check, ChevronDown, PanelLeft, Power, Settings, SquarePen } from 'lucide-react'
import type { SapientStatus } from '@shared/types'
import { shortModel } from '../lib/format'

interface Props {
  sidebarOpen: boolean
  status: SapientStatus | null
  selectedModel: string // '' = auto
  onToggleSidebar: () => void
  onNew: () => void
  onPickModel: (model: string) => void
  onStartEngine: () => void
  onStopEngine: () => void
  onOpenSettings: () => void
}

export function Header(p: Props) {
  const [open, setOpen] = useState(false)
  const s = p.status
  const models = [...new Set([...(s?.downloaded ?? []), ...(s?.resident ?? [])])].sort()
  const active = s?.activeModel ?? ''

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
                  <span className="desc">Your OpenHorizon default, else whatever SAPIENT has loaded</span>
                </span>
                {p.selectedModel === '' && <Check size={16} className="check" />}
              </button>
              {models.map((m) => (
                <button key={m} className="menu-item" onClick={() => pick(m)}>
                  <span className="grow">
                    {shortModel(m)}
                    <span className="desc">On this computer</span>
                  </span>
                  {p.selectedModel === m && <Check size={16} className="check" />}
                </button>
              ))}
              {models.length === 0 && (
                <div className="menu-label" style={{ paddingBottom: 8 }}>
                  No models found. Pull one with <code>sapient pull openhorizon/qwen2.5-7b-q4</code>
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
