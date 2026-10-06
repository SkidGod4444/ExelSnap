import { useState } from 'react'
import { Ellipsis, PanelLeft, Pencil, Search, SquarePen, Trash } from 'lucide-react'
import type { ConversationSummary, SapientStatus } from '@shared/types'
import { groupByDate, shortModel } from '../lib/format'

interface Props {
  open: boolean
  conversations: ConversationSummary[]
  activeId: string | null
  status: SapientStatus | null
  onToggle: () => void
  onNew: () => void
  onSelect: (id: string) => void
  onRename: (id: string, title: string) => void
  onDelete: (id: string) => void
  onOpenSettings: () => void
}

export function statusText(s: SapientStatus | null): string {
  if (!s) return 'Checking…'
  switch (s.state) {
    case 'online':
      return shortModel(s.activeModel)
    case 'starting':
      return 'Starting…'
    case 'error':
      return 'Error — open settings'
    default:
      return s.binary ? 'Offline' : 'Not installed'
  }
}

export function Sidebar(p: Props) {
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)

  const filtered = query ? p.conversations.filter((c) => c.title.toLowerCase().includes(query.toLowerCase())) : p.conversations
  const groups = groupByDate(filtered)

  const commitRename = () => {
    if (editing && draft.trim()) p.onRename(editing, draft.trim())
    setEditing(null)
  }

  return (
    <aside className={`sidebar${p.open ? '' : ' closed'}`}>
      <div className="sidebar-top drag">
        <button className="icon-btn" onClick={p.onToggle} title="Close sidebar" aria-label="Close sidebar">
          <PanelLeft size={20} />
        </button>
        <div className="sidebar-top-actions">
          <button className="icon-btn" onClick={() => setSearching(!searching)} title="Search chats" aria-label="Search chats">
            <Search size={19} />
          </button>
          <button className="icon-btn" onClick={p.onNew} title="New chat (⌘⇧O)" aria-label="New chat">
            <SquarePen size={19} />
          </button>
        </div>
      </div>

      <div className="sidebar-nav">
        {searching ? (
          <input
            autoFocus
            className="field"
            style={{ width: '100%' }}
            placeholder="Search chats"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setQuery('')
                setSearching(false)
              }
            }}
          />
        ) : (
          <button className="nav-item" onClick={p.onNew}>
            <SquarePen size={18} /> New chat
            <kbd>{window.api.platform === 'darwin' ? '⌘⇧O' : 'Ctrl+Shift+O'}</kbd>
          </button>
        )}
      </div>

      <nav className="history">
        {groups.length === 0 && (
          <div className="history-empty">{query ? 'No chats match.' : 'Your chats will show up here. Drop a spreadsheet to start one.'}</div>
        )}
        {groups.map((g) => (
          <div className="history-group" key={g.label}>
            <h3>{g.label}</h3>
            {g.items.map((c) => (
              <div
                key={c.id}
                className={`history-item${c.id === p.activeId ? ' active' : ''}`}
                onClick={() => editing !== c.id && p.onSelect(c.id)}
                onDoubleClick={() => {
                  setEditing(c.id)
                  setDraft(c.title)
                }}
              >
                {editing === c.id ? (
                  <input
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRename()
                      if (e.key === 'Escape') setEditing(null)
                    }}
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <span className="title">{c.title}</span>
                )}
                <button
                  className={`icon-btn sm more${menu?.id === c.id ? ' open' : ''}`}
                  aria-label="Chat options"
                  onClick={(e) => {
                    e.stopPropagation()
                    const r = e.currentTarget.getBoundingClientRect()
                    setMenu({ id: c.id, x: r.left, y: r.bottom + 4 })
                  }}
                >
                  <Ellipsis size={16} />
                </button>
              </div>
            ))}
          </div>
        ))}
      </nav>

      <div className="sidebar-footer">
        <button className="engine-card" onClick={p.onOpenSettings} title="SAPIENT engine & settings">
          <span className={`dot ${p.status?.state ?? ''}`} />
          <span className="meta">
            <div className="name">SAPIENT</div>
            <div className="sub">{statusText(p.status)}</div>
          </span>
        </button>
      </div>

      {menu && (
        <>
          <div className="backdrop" onClick={() => setMenu(null)} />
          <div className="menu" style={{ left: Math.min(menu.x, window.innerWidth - 230), top: menu.y, position: 'fixed' }}>
            <button
              className="menu-item"
              onClick={() => {
                const c = p.conversations.find((x) => x.id === menu.id)
                setEditing(menu.id)
                setDraft(c?.title ?? '')
                setMenu(null)
              }}
            >
              <Pencil size={16} /> Rename
            </button>
            <button
              className="menu-item danger"
              onClick={() => {
                p.onDelete(menu.id)
                setMenu(null)
              }}
            >
              <Trash size={16} /> Delete
            </button>
          </div>
        </>
      )}
    </aside>
  )
}
