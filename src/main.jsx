import { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'

const AGENTS_STORAGE_KEY = 'telecall-agent-accounts-v2'
const CALLS_STORAGE_KEY = 'telecall-call-records-v2'
const API_BASE = '/api'

const apiRequest = async (path, options = {}) => {
  const response = await fetch(`${API_BASE}${path}`, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(payload.error || 'Request failed')
    error.status = response.status
    throw error
  }
  return payload
}

const readStored = key => {
  try {
    const value = JSON.parse(localStorage.getItem(key))
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}

const dateKey = date => date.toISOString().slice(0, 10)
const todayKey = () => dateKey(new Date())
const formatDate = date => new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(date)
const formatDuration = seconds => {
  const total = Math.max(0, Number(seconds) || 0)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const remainingSeconds = total % 60
  if (hours) return `${hours}h ${minutes}m`
  if (minutes) return `${minutes}m ${remainingSeconds}s`
  return `${remainingSeconds}s`
}
const callStats = calls => {
  const answered = calls.filter(call => call.status === 'Answered').length
  const talkSeconds = calls.reduce((total, call) => total + (Number(call.seconds) || 0), 0)
  return {
    total: calls.length,
    answered,
    missed: calls.filter(call => call.status === 'Missed').length,
    rejected: calls.filter(call => call.status === 'Rejected').length,
    failed: calls.filter(call => call.status === 'Failed').length,
    talkSeconds,
    answerRate: calls.length ? Math.round((answered / calls.length) * 100) : 0,
    averageSeconds: calls.length ? Math.round(talkSeconds / calls.length) : 0,
  }
}

const navGroups = [
  { label: 'Workspace', items: [{ key: 'dashboard', label: 'Overview', icon: 'grid' }, { key: 'telecallers', label: 'Agents', icon: 'users' }] },
  { label: 'Manage', items: [{ key: 'performance', label: 'Performance', icon: 'chart' }, { key: 'history', label: 'Call history', icon: 'clock' }] },
]

function Icon({ name, size = 18, stroke = 1.8 }) {
  const common = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: stroke, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' }
  const paths = {
    grid: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>,
    users: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></>,
    chart: <><path d="M3 3v18h18" /><path d="m7 16 3-4 3 2 5-7" /><circle cx="18" cy="7" r="1" /></>,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    plus: <><path d="M12 5v14M5 12h14" /></>,
    arrow: <><path d="M5 12h14M13 6l6 6-6 6" /></>,
    arrowLeft: <><path d="M19 12H5M11 18l-6-6 6-6" /></>,
    phone: <><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.79 19.79 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.12.9.33 1.78.62 2.63a2 2 0 0 1-.45 2.11L8 9.73a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.85.29 1.73.5 2.63.62A2 2 0 0 1 22 16.92z" /></>,
    phoneOff: <><path d="M10.68 13.31a16 16 0 0 0 3.6 2.42l1.27-1.27a2 2 0 0 1 2.11-.45c.85.29 1.73.5 2.63.62A2 2 0 0 1 22 16.63v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.12 3.93a2 2 0 0 1 2-1.8h3a2 2 0 0 1 2 1.72c.12.9.33 1.78.62 2.63a2 2 0 0 1-.45 2.11L8 7.86" /><path d="m2 2 20 20" /></>,
    logout: <><path d="M10 17l5-5-5-5" /><path d="M15 12H3" /><path d="M21 19V5a2 2 0 0 0-2-2h-6" /></>,
    search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></>,
    filter: <><path d="M4 5h16M7 12h10M10 19h4" /></>,
    download: <><path d="M12 3v12M7 10l5 5 5-5" /><path d="M5 21h14" /></>,
    settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-1.41 1.41-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V21h-2v-.09a1.7 1.7 0 0 0-1.03-1.56 1.7 1.7 0 0 0-1.88.34l-.06.06-1.41-1.41.06-.06A1.7 1.7 0 0 0 9.4 15a1.7 1.7 0 0 0-1.56-1.03H7v-2h.84A1.7 1.7 0 0 0 9.4 11a1.7 1.7 0 0 0-.34-1.88L9 9.06l1.41-1.41.06.06a1.7 1.7 0 0 0 1.88.34A1.7 1.7 0 0 0 13.38 6.5V6h2v.5a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.88-.34l.06-.06 1.41 1.41-.06.06a1.7 1.7 0 0 0-.34 1.88A1.7 1.7 0 0 0 20.91 12H21v2h-.09A1.7 1.7 0 0 0 19.4 15z" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    chevron: <path d="m6 9 6 6 6-6" />,
    close: <><path d="M6 6l12 12M18 6 6 18" /></>,
    menu: <><path d="M4 6h16M4 12h16M4 18h16" /></>,
    more: <><circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" /></>,
    device: <><rect x="5" y="2" width="14" height="20" rx="2" /><path d="M12 18h.01" /></>,
    calendar: <><rect x="3" y="4" width="18" height="17" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" /></>,
    trend: <><path d="m4 14 5-5 4 4 7-7" /><path d="M15 6h5v5" /></>,
    spark: <><path d="m12 3-1.2 5.8L5 10l5.8 1.2L12 17l1.2-5.8L19 10l-5.8-1.2L12 3z" /><path d="m19 16-.5 2.5L16 19l2.5.5L19 22l.5-2.5L22 19l-2.5-.5L19 16z" /></>,
  }
  return <svg {...common}>{paths[name] || paths.grid}</svg>
}

function Logo({ compact = false }) {
  return <div className={`brand ${compact ? 'brand-compact' : ''}`}><span className="brand-mark"><span></span><span></span><span></span></span>{!compact && <span>telecall</span>}</div>
}

function Avatar({ caller, small = false }) {
  return <div className={`avatar avatar-${caller?.color || 'mint'} ${small ? 'avatar-small' : ''}`}>{caller?.initials || 'AG'}</div>
}

function StatusPill({ status }) {
  const key = status.toLowerCase().replace(' ', '-')
  return <span className={`status status-${key}`}><span className="status-dot"></span>{status}</span>
}

function OutcomeBadge({ status }) {
  return <span className={`outcome outcome-${status.toLowerCase()}`}>{status}</span>
}

function StatCard({ label, value, detail, tone = 'default', icon, trend }) {
  return <div className={`stat-card stat-${tone}`}>
    <div className="stat-top"><span className="stat-label">{label}</span><span className="stat-icon"><Icon name={icon} size={17} /></span></div>
    <div className="stat-value">{value}</div>
    {detail && <div className="stat-detail">{trend && <span className="trend-up"><Icon name="trend" size={13} />{trend}</span>} {detail}</div>}
  </div>
}

function Topbar({ title, subtitle, action, onMenu }) {
  return <header className="topbar">
    <button className="mobile-menu" onClick={onMenu} aria-label="Open navigation"><Icon name="menu" size={21} /></button>
    <div><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div>
    <div className="topbar-actions">{action}</div>
  </header>
}

function Sidebar({ page, onNavigate, caller, agentCount, connectedDeviceCount, onLogout, collapsed, setCollapsed }) {
  return <aside className={`sidebar ${collapsed ? 'sidebar-collapsed' : ''}`}>
    <div className="sidebar-head"><Logo compact={collapsed} /><button className="collapse-button" onClick={() => setCollapsed(!collapsed)}><Icon name={collapsed ? 'arrow' : 'arrowLeft'} size={16} /></button></div>
    <div className="workspace-switch"><Avatar caller={{ initials: 'A', color: 'blue' }} small /><div className="workspace-details"><strong>Admin workspace</strong><span>Account management</span></div><Icon name="chevron" size={14} /></div>
    <nav className="main-nav">
      {navGroups.map(group => <div className="nav-group" key={group.label}><span className="nav-group-label">{group.label}</span>{group.items.map(item => <button key={item.key} className={`nav-item ${page === item.key ? 'active' : ''}`} onClick={() => onNavigate(item.key)}><Icon name={item.icon} size={18} /><span>{item.label}</span>{item.key === 'telecallers' && !collapsed && agentCount > 0 && <em>{agentCount}</em>}</button>)}</div>)}
    </nav>
    <div className="sidebar-bottom">
      <div className="device-status"><span className="device-icon"><Icon name="device" size={17} /></span><div><strong>Android bridge</strong><span>{connectedDeviceCount ? `${connectedDeviceCount} device${connectedDeviceCount === 1 ? '' : 's'} connected` : 'No device connected'}</span></div></div>
      <button className="nav-item"><Icon name="settings" size={18} /><span>Settings</span></button>
      <div className="profile-chip"><Avatar caller={{ initials: 'A', color: 'peach' }} small /><div><strong>Administrator</strong><span>Admin account</span></div><button onClick={onLogout} aria-label="Log out"><Icon name="logout" size={16} /></button></div>
    </div>
  </aside>
}

function dailyValues(calls, days = 30) {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(today)
    date.setDate(today.getDate() - (days - 1 - index))
    const key = dateKey(date)
    return calls.filter(call => call.date === key).length
  })
}

function MiniLineChart({ compact = false, calls = [] }) {
  const values = dailyValues(calls, compact ? 10 : 30)
  if (!values.some(Boolean)) return <div className={`mini-chart-empty ${compact ? 'chart-compact' : ''}`}>No activity</div>
  const max = Math.max(...values, 1)
  const points = values.map((value, i) => `${(i / (values.length - 1)) * (compact ? 290 : 600)},${75 - (value / max) * 62}`).join(' ')
  return <svg className={`mini-line-chart ${compact ? 'chart-compact' : ''}`} viewBox={`0 0 ${compact ? 290 : 600} 90`} preserveAspectRatio="none"><defs><linearGradient id="area" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="#4faea0" stopOpacity=".25" /><stop offset="100%" stopColor="#4faea0" stopOpacity="0" /></linearGradient></defs><path d={`M ${points.replace(/ /g, ' L ')},90 L 0,90 Z`} fill="url(#area)" /><polyline points={points} fill="none" stroke="#3d9b90" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
}

function ActivityChart({ calls = [] }) {
  const values = dailyValues(calls)
  if (!values.some(Boolean)) return <div className="activity-empty"><Icon name="chart" size={21} /><strong>No call activity yet</strong><span>Daily activity will appear after an agent completes a call.</span></div>
  const max = Math.max(...values, 1)
  const points = values.map((value, i) => `${(i / (values.length - 1)) * 700},${105 - (value / max) * 92}`).join(' ')
  const area = `M ${points.replace(/ /g, ' L ')} L 700,120 L 0,120 Z`
  const end = new Date()
  const labels = [29, 22, 15, 8, 0].map(offset => { const date = new Date(end); date.setDate(end.getDate() - offset); return new Intl.DateTimeFormat(undefined, { month: 'short', day: '2-digit' }).format(date) })
  return <div className="activity-chart"><div className="chart-y"><span>{max}</span><span>{Math.ceil(max * .75)}</span><span>{Math.ceil(max * .5)}</span><span>{Math.ceil(max * .25)}</span><span>0</span></div><svg viewBox="0 0 700 120" preserveAspectRatio="none"><defs><linearGradient id="bigArea" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="#3d9b90" stopOpacity=".26" /><stop offset="100%" stopColor="#3d9b90" stopOpacity=".015" /></linearGradient></defs><path d={area} fill="url(#bigArea)" /><polyline points={points} fill="none" stroke="#328d82" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" /></svg><div className="chart-x">{labels.map(label => <span key={label}>{label}</span>)}</div></div>
}

function OutcomeChart({ calls = [] }) {
  const stats = callStats(calls)
  const total = stats.total || 1
  const data = [{ label: 'Answered', value: stats.answered, color: 'teal' }, { label: 'Missed', value: stats.missed, color: 'coral' }, { label: 'Rejected', value: stats.rejected, color: 'amber' }, { label: 'Failed', value: stats.failed, color: 'slate' }].map(item => ({ ...item, pct: item.value ? Math.max(2, Math.round((item.value / total) * 100)) : 0 }))
  if (!stats.total) return <div className="activity-empty outcome-empty"><Icon name="chart" size={21} /><strong>No call outcomes yet</strong><span>Outcome breakdown will appear after calls are recorded.</span></div>
  return <div className="outcome-chart"><div className="outcome-bars">{data.map(item => <div className="outcome-row" key={item.label}><span className="outcome-label"><i className={`bar-dot ${item.color}`}></i>{item.label}</span><div className="bar-track"><div className={`bar-fill ${item.color}`} style={{ width: `${item.pct}%` }}></div></div><strong>{item.value}</strong></div>)}</div></div>
}

function CallsTable({ calls, callers, showCaller = true, limit, emptyText = 'No calls found' }) {
  const rows = limit ? calls.slice(0, limit) : calls
  return <div className="table-wrap"><table><thead><tr><th>Date & time</th>{showCaller && <th>Agent</th>}<th>Phone number</th><th>Outcome</th><th>Duration</th><th></th></tr></thead><tbody>{rows.length ? rows.map(call => { const caller = callers.find(c => c.id === call.callerId); const callDate = new Date(`${call.date}T00:00:00`); const dateLabel = call.date === todayKey() ? 'Today' : formatDate(callDate); return <tr key={call.id}><td><strong className="table-date">{call.time}</strong><span className="table-sub">{dateLabel}</span></td>{showCaller && <td><div className="person-cell"><Avatar caller={caller} small /><span>{caller?.name || 'Unknown'}</span></div></td>}<td className="number-cell">{call.number}</td><td><OutcomeBadge status={call.status} /></td><td className="duration-cell">{call.duration}</td><td><button className="icon-button"><Icon name="more" size={17} /></button></td></tr>}) : <tr><td colSpan={showCaller ? 6 : 5} className="empty-cell">{emptyText}</td></tr>}</tbody></table></div>
}

function EmptyState({ icon = 'users', title, description, action }) {
  return <div className="empty-state"><span className="empty-state-icon"><Icon name={icon} size={20} /></span><strong>{title}</strong><p>{description}</p>{action}</div>
}

function PairingModal({ pairing, onClose }) {
  return <div className="modal-backdrop" role="presentation" onClick={onClose}><section className="pairing-modal panel" role="dialog" aria-modal="true" aria-labelledby="pairing-title" onClick={event => event.stopPropagation()}><button className="modal-close icon-button" onClick={onClose} aria-label="Close pairing dialog"><Icon name="close" size={17} /></button><span className="eyebrow">ANDROID DEVICE</span><h2 id="pairing-title">Pair {pairing.name}</h2>{pairing.error ? <div className="form-error">{pairing.error}</div> : pairing.code ? <><p>Open Telecall Bridge on the agent’s Android phone and enter this one-time code.</p><div className="pairing-code">{pairing.code}</div><small>Code expires in 10 minutes. Waiting for the phone to connect…</small></> : <><p>Preparing a secure pairing code for this agent.</p><div className="pairing-loading">Generating code…</div></>}</section></div>
}

function Dashboard({ callers, calls, navigate, onMenu }) {
  const stats = useMemo(() => callStats(calls), [calls])
  const activeAgents = callers.filter(caller => caller.status === 'Active').length
  const connectedAgents = callers.filter(caller => caller.presence === 'Online' || caller.presence === 'In a call').length
  const connectionValues = callers.map(caller => Number.parseInt(caller.connected, 10)).filter(Number.isFinite)
  const averageConnection = connectionValues.length ? `${Math.round(connectionValues.reduce((sum, value) => sum + value, 0) / connectionValues.length)}%` : '—'
  return <>
    <Topbar title="Admin overview" subtitle="Manage agent accounts and monitor call activity." onMenu={onMenu} action={<><button className="secondary-button"><Icon name="download" size={16} />Export report</button><button className="avatar-button"><span>A</span></button></>} />
    <main className="page-content">
      <div className="hero-row"><div><span className="eyebrow">{new Intl.DateTimeFormat(undefined, { dateStyle: 'long' }).format(new Date())}</span><h2>Call activity</h2></div><div className="live-indicator"><i></i> Live data <span>Updated just now</span></div></div>
      <section className="stats-grid"><StatCard label="Total calls" value={String(stats.total)} detail={stats.total ? `${stats.answerRate}% answer rate` : 'No calls recorded yet'} icon="phone" tone="mint" /><StatCard label="Answered calls" value={String(stats.answered)} detail={stats.total ? `${stats.answerRate}% of all calls` : 'Waiting for first call'} icon="check" /><StatCard label="Total talk time" value={formatDuration(stats.talkSeconds)} detail={stats.total ? `Avg. ${formatDuration(stats.averageSeconds)} per call` : 'No talk time recorded'} icon="clock" /><StatCard label="Active agents" value={`${activeAgents} / ${callers.length}`} detail={callers.length ? `${connectedAgents} currently connected` : 'Create your first agent account'} icon="users" tone="peach" /></section>
      <section className="dashboard-grid">
        <div className="panel activity-panel"><div className="panel-head"><div><h3>Calling activity</h3><p>Daily call volume from all agents</p></div><div className="segmented"><button className="selected">30 days</button><button>7 days</button><button>Today</button></div></div><div className="big-chart"><ActivityChart calls={calls} /></div></div>
        <div className="panel agents-panel"><div className="panel-head"><div><h3>Agents</h3><p>Current account status</p></div><button className="text-button" onClick={() => navigate('telecallers')}>View all <Icon name="arrow" size={14} /></button></div><div className="agent-list">{callers.length ? callers.slice(0, 4).map(caller => <div className="agent-row" key={caller.id}><Avatar caller={caller} /><div className="agent-info"><strong>{caller.name}</strong><span>{caller.presence || 'Offline'}</span></div><div className="agent-calls"><strong>{caller.callsToday || 0}</strong><span>calls</span></div><StatusPill status={caller.presence === 'In a call' ? 'In call' : caller.presence === 'Online' ? 'Online' : 'Offline'} /></div>) : <EmptyState icon="users" title="No agents yet" description="Create an agent account to start managing access." action={<button className="primary-button" onClick={() => navigate('new-caller')}><Icon name="plus" size={15} />Add agent</button>} />}</div></div>
      </section>
      <section className="panel recent-panel"><div className="panel-head"><div><h3>Recent calls</h3><p>The latest activity from your agents</p></div><button className="text-button" onClick={() => navigate('history')}>See full history <Icon name="arrow" size={14} /></button></div><CallsTable calls={calls} callers={callers} limit={5} emptyText="No calls recorded yet" /></section>
    </main>
  </>
}

function Telecallers({ callers, setCallers, navigate, onMenu, onPair }) {
  const [query, setQuery] = useState('')
  const filtered = callers.filter(c => `${c.name} ${c.username}`.toLowerCase().includes(query.toLowerCase()))
  const connectedDevices = callers.filter(caller => caller.bridgeConnected).length
  const toggleStatus = id => setCallers(current => current.map(c => c.id === id ? { ...c, status: c.status === 'Active' ? 'Paused' : 'Active' } : c))
  return <><Topbar title="Agents" subtitle="Manage agent accounts and access." onMenu={onMenu} action={<button className="primary-button" onClick={() => navigate('new-caller')}><Icon name="plus" size={17} />Add agent</button>} /><main className="page-content"><div className="metric-strip"><div><span className="eyebrow">AGENT ACCOUNTS</span><strong>{callers.length}</strong><small>registered agents</small></div><div><span className="eyebrow">ACTIVE AGENTS</span><strong>{callers.filter(c => c.status === 'Active').length}</strong><small>enabled accounts</small></div><div><span className="eyebrow">CONNECTED DEVICES</span><strong>{connectedDevices}</strong><small>{connectedDevices ? 'phones online' : 'No phones paired'}</small></div><div className="strip-illustration"><span></span><span></span><span></span><span></span><span></span></div></div><div className="list-toolbar"><div className="search-field"><Icon name="search" size={17} /><input placeholder="Search agents" value={query} onChange={e => setQuery(e.target.value)} /></div><button className="secondary-button"><Icon name="filter" size={16} />Filter</button></div><section className="panel caller-list-panel"><div className="panel-head"><div><h3>All agents <span className="count-badge">{filtered.length}</span></h3><p>Account access and current status</p></div><button className="icon-button"><Icon name="more" size={18} /></button></div><div className="table-wrap"><table className="caller-table"><thead><tr><th>Agent</th><th>Status</th><th>Today’s calls</th><th>Talk time</th><th>Device</th><th>Last active</th><th></th></tr></thead><tbody>{filtered.length ? filtered.map(caller => <tr key={caller.id}><td><div className="person-cell"><Avatar caller={caller} /><div><strong>{caller.name}</strong><span>{caller.username}</span></div></div></td><td><button className="status-button" onClick={() => toggleStatus(caller.id)}><StatusPill status={caller.status} /><Icon name="chevron" size={12} /></button></td><td><strong>{caller.callsToday || 0}</strong><span className="table-sub">calls</span></td><td>{caller.talkTime || '0s'}</td><td>{caller.bridgeConnected ? <><span className="connection device-connected"><span style={{ width: '100%' }}></span></span><strong className="connection-text">Online</strong></> : <span className="muted-cell">Not paired</span>}</td><td className="muted-cell">{caller.lastSeen || 'Never'}</td><td><button className="view-button" onClick={() => onPair(caller)}>{caller.bridgeConnected ? 'Manage' : 'Pair device'} <Icon name="arrow" size={14} /></button></td></tr>) : <tr><td colSpan="7" className="empty-cell">{query ? 'No agents match that search.' : 'No agent accounts yet. Add an agent to get started.'}</td></tr>}</tbody></table></div></section><p className="table-note"><Icon name="device" size={14} /> Pair each agent’s Android phone to place calls through its physical SIM.</p></main></>
}

function AddCaller({ setCallers, navigate, onMenu, onCreate }) {
  const [form, setForm] = useState({ name: '', username: '', password: '', status: 'Active' })
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const update = key => e => setForm({ ...form, [key]: e.target.value })
  const submit = async e => {
    e.preventDefault()
    if (!form.name || !form.username || !form.password) { setError('Please complete all fields to create the account.'); return }
    setError('')
    setSaving(true)
    try {
      const agent = await onCreate(form)
      setCallers(current => [...current, agent])
      navigate('telecallers')
    } catch (createError) {
      setError(createError.message || 'Unable to create the agent account.')
    } finally {
      setSaving(false)
    }
  }
  return <><Topbar title="Add agent" subtitle="Create an account for a calling agent." onMenu={onMenu} action={<button className="secondary-button" onClick={() => navigate('telecallers')}><Icon name="arrowLeft" size={16} />Back to agents</button>} /><main className="page-content form-page"><div className="form-layout"><div className="form-intro"><span className="eyebrow">NEW ACCOUNT</span><h2>Set up an agent</h2><p>Give the agent secure access to the calling screen and their own activity history.</p></div><form className="panel caller-form" onSubmit={submit}><div className="form-section"><div className="form-section-title"><span className="step-number">1</span><div><h3>Account details</h3><p>Basic information for this agent</p></div></div><label>Full name<input value={form.name} onChange={update('name')} placeholder="e.g. Agent name" /></label><label>Username<div className="input-prefix"><span>@</span><input value={form.username} onChange={update('username')} placeholder="Enter username" /></div><small>The agent will use this username to sign in.</small></label><label>Password<input type="password" value={form.password} onChange={update('password')} placeholder="Create a temporary password" /><small>The agent can change this after signing in.</small></label></div><div className="form-divider"></div><div className="form-section"><div className="form-section-title"><span className="step-number">2</span><div><h3>Account status</h3><p>Choose whether the agent can start calling right away</p></div></div><label>Status<select value={form.status} onChange={update('status')}><option>Active</option><option>Paused</option></select></label></div>{error && <div className="form-error">{error}</div>}<div className="form-actions"><button type="button" className="secondary-button" onClick={() => navigate('telecallers')}>Cancel</button><button className="primary-button" type="submit" disabled={saving}>{saving ? 'Creating…' : <>Create account <Icon name="arrow" size={15} /></>}</button></div></form></div></main></>
}

function Performance({ callers, calls, selectedId, setSelectedId, navigate, onMenu }) {
  const selected = callers.find(c => c.id === selectedId) || callers[0]
  const [from, setFrom] = useState(() => { const date = new Date(); date.setDate(1); return dateKey(date) })
  const [to, setTo] = useState(() => todayKey())
  const callerCalls = calls.filter(c => c.callerId === selected?.id && c.date >= from && c.date <= to)
  const stats = useMemo(() => callStats(callerCalls), [callerCalls])
  if (!selected) return <><Topbar title="Performance" subtitle="Review call activity by agent." onMenu={onMenu} action={null} /><main className="page-content"><EmptyState icon="users" title="No agents available" description="Create an agent account before viewing performance." action={<button className="primary-button" onClick={() => navigate('new-caller')}><Icon name="plus" size={15} />Add agent</button>} /></main></>
  return <><Topbar title="Performance" subtitle="Review call activity by agent." onMenu={onMenu} action={<button className="secondary-button"><Icon name="download" size={16} />Export performance</button>} /><main className="page-content"><div className="performance-filter panel"><div className="caller-select"><Avatar caller={selected} /><div><span className="eyebrow">AGENT</span><select value={selected?.id} onChange={e => setSelectedId(e.target.value)}>{callers.map(c => <option value={c.id} key={c.id}>{c.name}</option>)}</select></div></div><div className="date-fields"><label>From<input type="date" value={from} onChange={e => setFrom(e.target.value)} /></label><span className="date-dash">—</span><label>To<input type="date" value={to} onChange={e => setTo(e.target.value)} /></label><button className="primary-button">Apply</button></div></div><div className="performance-heading"><div><h2>{selected?.name}<span className="heading-status"><StatusPill status={selected?.status} /></span></h2><p>Performance from {from} to {to}</p></div><button className="text-button" onClick={() => navigate('history', selected?.id)}>View call history <Icon name="arrow" size={14} /></button></div><section className="stats-grid performance-stats"><StatCard label="Total calls" value={String(stats.total)} detail={stats.total ? 'In selected date range' : 'No calls recorded yet'} icon="phone" tone="mint" /><StatCard label="Answered calls" value={String(stats.answered)} detail={stats.total ? `${stats.answerRate}% answer rate` : 'No answered calls yet'} icon="check" /><StatCard label="Total talk time" value={formatDuration(stats.talkSeconds)} detail={stats.total ? `Avg. ${formatDuration(stats.averageSeconds)} per call` : 'No talk time recorded'} icon="clock" /><StatCard label="Avg. call duration" value={formatDuration(stats.averageSeconds)} detail={stats.total ? 'Calculated from call records' : 'No duration recorded'} icon="trend" tone="peach" /></section><section className="charts-grid"><div className="panel chart-panel"><div className="panel-head"><div><h3>Calls per day</h3><p>Call volume in the selected date range</p></div><span className="chart-legend"><i></i> Calls</span></div><ActivityChart calls={callerCalls} /></div><div className="panel chart-panel outcome-panel"><div className="panel-head"><div><h3>Call outcomes</h3><p>Results from recorded calls</p></div></div><OutcomeChart calls={callerCalls} /></div></section><section className="panel recent-panel"><div className="panel-head"><div><h3>Recent calls</h3><p>Latest calls made by {selected?.name.split(' ')[0]}</p></div><button className="text-button" onClick={() => navigate('history', selected?.id)}>View all <Icon name="arrow" size={14} /></button></div><CallsTable calls={callerCalls} callers={callers} showCaller={false} limit={4} emptyText="No calls recorded for this agent" /></section></main></>
}

function CallerHeader({ caller, onLogout }) {
  const connected = Boolean(caller.bridgeConnected)
  return <header className="caller-topbar"><Logo /><div className="caller-top-actions"><div className={`bridge-pill ${connected ? '' : 'bridge-offline'}`}><i></i><Icon name="device" size={15} /> {connected ? 'Android bridge online' : 'Android bridge required'}</div><div className="caller-user"><Avatar caller={caller} small /><span>{caller.name}</span><button onClick={onLogout} aria-label="Log out"><Icon name="logout" size={16} /></button></div></div></header>
}

function CallerNav({ page, navigate }) {
  return <nav className="caller-nav"><button className={page === 'caller' ? 'active' : ''} onClick={() => navigate('caller')}><Icon name="phone" size={17} />Calling screen</button><button className={page === 'caller-history' ? 'active' : ''} onClick={() => navigate('caller-history')}><Icon name="clock" size={17} />My call history</button></nav>
}

function CallerDashboard({ caller, calls, addCall, requestCall, getRemoteCall, updateRemoteCall, navigate, onLogout }) {
  const [number, setNumber] = useState('')
  const [calling, setCalling] = useState(false)
  const [callConnected, setCallConnected] = useState(false)
  const [remoteStatus, setRemoteStatus] = useState('')
  const [seconds, setSeconds] = useState(0)
  const [callStartedAt, setCallStartedAt] = useState(null)
  const [activeCallId, setActiveCallId] = useState('')
  const [activeNumber, setActiveNumber] = useState('')
  const [callError, setCallError] = useState('')
  useEffect(() => { if (!calling || !callConnected || !callStartedAt) return undefined; const timer = setInterval(() => setSeconds(Math.max(0, Math.floor((Date.now() - callStartedAt) / 1000))), 1000); return () => clearInterval(timer) }, [calling, callConnected, callStartedAt])
  const callerCalls = calls.filter(c => c.callerId === caller.id)
  const todayCalls = callerCalls.filter(call => call.date === todayKey())
  const todayStats = callStats(todayCalls)
  useEffect(() => { if (!activeCallId) return undefined; let active = true; const check = async () => { try { const remote = await getRemoteCall(activeCallId); if (!active) return; if (remote.status === 'Calling' || remote.status === 'In progress') { setRemoteStatus(remote.status); if (remote.status === 'In progress') { setCallConnected(true); setCallStartedAt(startedAt => startedAt || Date.now()) } } if (['Answered', 'Missed', 'Rejected', 'Failed'].includes(remote.status)) { addCall({ callerId: caller.id, number: activeNumber, status: remote.status, seconds: remote.seconds || 0 }); setCalling(false); setCallConnected(false); setRemoteStatus(''); setCallStartedAt(null); setActiveCallId(''); setActiveNumber(''); setNumber('') } } catch {} }; check(); const timer = setInterval(check, 1000); return () => { active = false; clearInterval(timer) } }, [activeCallId, activeNumber, caller.id])
  const startCall = async () => { if (!caller.bridgeConnected || number.replace(/\D/g, '').length < 7) return; setCallError(''); const formattedNumber = `+91 ${number}`; const result = await requestCall({ agentId: caller.id, number: formattedNumber }); if (!result?.callId) { setCallError('The Android phone is not ready. Ask the administrator to pair it first.'); return } setActiveCallId(result.callId); setActiveNumber(formattedNumber); setCalling(true); setCallConnected(false); setRemoteStatus('Queued'); setCallStartedAt(null); setSeconds(0) }
  const endCall = async status => { if (activeCallId) await updateRemoteCall(activeCallId, status, status === 'Answered' ? seconds : 0); addCall({ callerId: caller.id, number: activeNumber || `+91 ${number}`, status, seconds: status === 'Answered' ? seconds : 0 }); setCalling(false); setCallConnected(false); setRemoteStatus(''); setCallStartedAt(null); setActiveCallId(''); setActiveNumber(''); setNumber('') }
  const format = total => `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
  return <div className="caller-app"><CallerHeader caller={caller} onLogout={onLogout} /><CallerNav page="caller" navigate={navigate} /><main className="caller-content"><div className="caller-welcome"><div><span className="eyebrow">CALLING SCREEN</span><h1>Ready when you are, {caller.name.split(' ')[0]}.</h1><p>Place calls from your connected Android device.</p></div><div className="caller-date"><Icon name="calendar" size={15} /> {new Intl.DateTimeFormat(undefined, { dateStyle: 'long' }).format(new Date())}</div></div><div className="caller-grid"><section className={`call-card ${calling ? 'is-calling' : ''}`}><div className="call-card-glow"></div>{calling ? <><div className="calling-state"><div className="pulse-ring"><Icon name="phone" size={25} /></div><span className="eyebrow">{callConnected ? 'CALL IN PROGRESS' : remoteStatus === 'Calling' ? 'CALLING PHONE' : 'CONNECTING TO PHONE'}</span><h2>{activeNumber || number}</h2><strong className="call-timer">{callConnected ? format(seconds) : remoteStatus === 'Calling' ? 'Dialing…' : 'Waiting…'}</strong><p>{callConnected ? 'The Android phone is connected through its SIM.' : 'Waiting for the Android phone to place the SIM call.'}</p></div><div className="call-controls">{callConnected && <button className="end-call" onClick={() => endCall('Answered')}><Icon name="phone" size={19} />End call</button>}<button className="fail-call" onClick={() => endCall('Failed')}>{callConnected ? 'Mark failed' : 'Cancel request'}</button></div></> : <><div className="call-card-icon"><Icon name="phone" size={24} /></div><span className="eyebrow">OUTBOUND CALL</span><h2>Who would you like to call?</h2><p>Enter a phone number to send a call request to your connected Android device.</p><div className="number-input"><span>+91</span><input type="tel" value={number} onChange={e => setNumber(e.target.value.replace(/[^0-9 -]/g, ''))} placeholder="Enter phone number" onKeyDown={e => e.key === 'Enter' && startCall()} /></div><button className="call-button" onClick={startCall} disabled={!caller.bridgeConnected}><Icon name="phone" size={18} />Call now</button>{callError && <div className="form-error">{callError}</div>}<small className={caller.bridgeConnected ? '' : 'bridge-required'}><i></i> {caller.bridgeConnected ? 'Android bridge ready' : 'Connect an Android bridge to call'}</small></>}</section><aside className="caller-side"><div className="panel today-card"><div className="panel-head"><div><h3>Today's activity</h3><p>Your calling snapshot</p></div><span className="today-icon"><Icon name="trend" size={17} /></span></div><div className="today-number"><strong>{todayCalls.length}</strong><span>calls made today</span></div><MiniLineChart calls={callerCalls} /><div className="today-footer"><span><i className="teal-dot"></i> Answered <strong>{todayStats.answered}</strong></span><span><i className="coral-dot"></i> Missed <strong>{todayStats.missed}</strong></span></div></div><div className="panel bridge-card"><div className="bridge-icon"><Icon name="device" size={19} /></div><div><strong>Android bridge</strong><p>{caller.bridgeConnected ? 'Connected device is ready' : 'No device connected'}</p><span className={caller.bridgeConnected ? '' : 'bridge-required'}><i></i> {caller.bridgeConnected ? 'Device online' : 'Setup required'}</span></div><button><Icon name="more" size={16} /></button></div></aside></div><section className="panel caller-recent"><div className="panel-head"><div><h3>Recent calls</h3><p>Your latest calls</p></div><button className="text-button" onClick={() => navigate('caller-history')}>View history <Icon name="arrow" size={14} /></button></div><CallsTable calls={callerCalls} callers={[caller]} showCaller={false} limit={4} emptyText="No calls recorded yet" /></section></main></div>
}

function CallerHistory({ caller, calls, navigate, onLogout }) {
  const [query, setQuery] = useState('')
  const callerCalls = calls.filter(c => c.callerId === caller.id && c.number.toLowerCase().includes(query.toLowerCase()))
  return <div className="caller-app"><CallerHeader caller={caller} onLogout={onLogout} /><CallerNav page="caller-history" navigate={navigate} /><main className="caller-content history-content"><div className="caller-welcome"><div><span className="eyebrow">YOUR ACTIVITY</span><h1>Call history</h1><p>Every call you’ve made, all in one place.</p></div><div className="history-total"><strong>{callerCalls.length}</strong><span>calls recorded</span></div></div><div className="list-toolbar caller-toolbar"><div className="search-field"><Icon name="search" size={17} /><input placeholder="Search phone numbers" value={query} onChange={e => setQuery(e.target.value)} /></div><button className="secondary-button"><Icon name="filter" size={16} />Filter</button></div><section className="panel caller-recent history-table"><div className="panel-head"><div><h3>All calls</h3><p>Showing your complete calling activity</p></div><button className="secondary-button"><Icon name="download" size={15} />Export</button></div><CallsTable calls={callerCalls} callers={[caller]} showCaller={false} emptyText="No calls match that search" /></section></main></div>
}

function Login({ type, onLogin, onSwitch }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const submit = async e => {
    e.preventDefault()
    if (!username || !password) { setError('Enter your username and password to continue.'); return }
    setError('')
    const result = await onLogin(type, username.trim(), password)
    if (result === 'agent-portal') setError('This is an agent account. Use Agent sign in below.')
    if (result === 'not-found') setError('No agent account matches that username.')
    if (result === 'inactive') setError('This agent account is not active. Contact the administrator.')
    if (result === 'invalid-credentials') setError('Incorrect username or password.')
    if (result === 'server-error') setError('Unable to reach the Telecall server. Try again in a moment.')
  }
  return <div className="login-page"><div className="login-art"><Logo /><div className="login-art-copy"><span className="eyebrow">CALL OPERATIONS</span><h1>Keep calling work organized.</h1><p>A simple workspace for the admin account and its agents.</p></div></div><div className="login-form-side"><div className="login-form-wrap"><div className="mobile-login-logo"><Logo /></div><div className="login-heading"><span className="eyebrow">{type === 'admin' ? 'ADMIN PORTAL' : 'AGENT PORTAL'}</span><h2>Welcome back</h2><p>{type === 'admin' ? 'Sign in to manage agent accounts and call activity.' : 'Sign in to access your calling screen.'}</p></div><form onSubmit={submit}><label>Username<div className="input-prefix"><span>@</span><input value={username} onChange={e => setUsername(e.target.value)} placeholder={type === 'admin' ? 'Enter admin username' : 'Enter assigned username'} /></div></label><label>Password<input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Enter password" /></label><div className="login-options"><label className="checkbox-label"><input type="checkbox" defaultChecked /> Remember me</label><button type="button">Forgot password?</button></div>{error && <div className="form-error">{error}</div>}<button className="primary-button login-button">Sign in <Icon name="arrow" size={16} /></button></form><p className="login-help">Need help? <a href="mailto:support@telecall.app">Contact your administrator</a></p><p className="login-switch">{type === 'admin' ? 'Are you an agent?' : 'Are you the administrator?'} <button type="button" onClick={onSwitch}>{type === 'admin' ? 'Agent sign in' : 'Admin sign in'}</button></p></div><span className="login-legal">Telecall v1.0 <span>·</span> Secure workspace</span></div></div>
}

function App() {
  const [callers, setCallers] = useState(() => readStored(AGENTS_STORAGE_KEY))
  const [calls, setCalls] = useState(() => readStored(CALLS_STORAGE_KEY))
  const [page, setPage] = useState(() => { const path = window.location.pathname; if (path === '/login') return 'caller-login'; if (path === '/admin/login') return 'admin-login'; if (path.includes('/caller/history')) return 'caller-history'; if (path === '/caller') return 'caller'; if (path.includes('/performance')) return 'performance'; if (path.includes('/telecallers/new')) return 'new-caller'; if (path.includes('/telecallers')) return 'telecallers'; return 'dashboard' })
  const [selectedId, setSelectedId] = useState('')
  const [collapsed, setCollapsed] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [callerUser, setCallerUser] = useState('')
  const [role, setRole] = useState(() => window.location.pathname.startsWith('/caller') ? 'caller' : 'admin')
  const [pairing, setPairing] = useState(null)
  useEffect(() => localStorage.setItem(AGENTS_STORAGE_KEY, JSON.stringify(callers)), [callers])
  useEffect(() => localStorage.setItem(CALLS_STORAGE_KEY, JSON.stringify(calls)), [calls])
  useEffect(() => { localStorage.removeItem('telecall-callers'); localStorage.removeItem('telecall-calls') }, [])
  useEffect(() => {
    let active = true
    apiRequest('/agents').then(remoteAgents => {
      if (!active || !Array.isArray(remoteAgents) || !remoteAgents.length) return
      setCallers(current => remoteAgents.map(remote => ({ ...current.find(agent => agent.id === remote.id), ...remote })))
    }).catch(() => {})
    return () => { active = false }
  }, [])
  useEffect(() => { callers.forEach(agent => apiRequest('/agents/sync', { method: 'POST', body: JSON.stringify({ agentId: agent.id, username: agent.username, name: agent.name, status: agent.status }) }).catch(() => {})) }, [callers])
  const navigate = (next, id) => { setPage(next); if (id) { setSelectedId(id); if (next === 'caller-history') setCallerUser(id) } setMobileOpen(false); const path = next === 'dashboard' ? '/admin/dashboard' : next === 'telecallers' ? '/admin/telecallers' : next === 'new-caller' ? '/admin/telecallers/new' : next === 'performance' ? `/admin/telecallers/${id || selectedId}/performance` : next === 'history' ? '/admin/call-history' : next === 'caller' ? '/caller' : '/caller/history'; window.history.pushState({}, '', path) }
  const switchLogin = type => { setRole(type); setCallerUser(''); const nextPage = type === 'caller' ? 'caller-login' : 'admin-login'; const path = type === 'caller' ? '/login' : '/admin/login'; setPage(nextPage); window.history.pushState({}, '', path) }
  const startPairing = async agent => { setPairing({ agentId: agent.id, name: agent.name }); try { await apiRequest('/agents/sync', { method: 'POST', body: JSON.stringify({ agentId: agent.id, username: agent.username, name: agent.name, status: agent.status }) }); const result = await apiRequest('/pairing/start', { method: 'POST', body: JSON.stringify({ agentId: agent.id }) }); setPairing({ agentId: agent.id, name: agent.name, code: result.code, expiresAt: result.expiresAt }) } catch (error) { setPairing({ agentId: agent.id, name: agent.name, error: error.message }) } }
  useEffect(() => { if (!pairing?.code) return undefined; let active = true; const check = async () => { try { const device = await apiRequest(`/agents/${pairing.agentId}/device`); if (active && device.connected) { setCallers(current => current.map(agent => agent.id === pairing.agentId ? { ...agent, bridgeConnected: true, deviceName: device.deviceName, lastSeen: 'Just now' } : agent)); setPairing(null) } } catch {} }; check(); const timer = setInterval(check, 2000); return () => { active = false; clearInterval(timer) } }, [pairing])
  useEffect(() => { if (!callerUser) return undefined; let active = true; const refresh = async () => { try { const device = await apiRequest(`/agents/${callerUser}/device`); if (active) setCallers(current => current.map(agent => agent.id === callerUser ? { ...agent, bridgeConnected: Boolean(device.connected), deviceName: device.deviceName || '', lastSeen: device.connected ? 'Just now' : agent.lastSeen } : agent)) } catch {} }; refresh(); const timer = setInterval(refresh, 5000); return () => { active = false; clearInterval(timer) } }, [callerUser])
  const login = async (type, username, password) => {
    setRole(type)
    if (type === 'admin') {
      if (callers.some(c => c.username === username)) return 'agent-portal'
      navigate('dashboard')
      return true
    }
    try {
      const remote = await apiRequest('/agents/login', { method: 'POST', body: JSON.stringify({ username, password }) })
      setCallers(current => {
        const existing = current.find(agent => agent.id === remote.id)
        return existing ? current.map(agent => agent.id === remote.id ? { ...agent, ...remote } : agent) : [...current, remote]
      })
      setCallerUser(remote.id)
      navigate('caller')
      return true
    } catch (error) {
      if (error.status === 404) return 'not-found'
      if (error.status === 403) return 'inactive'
      if (error.status === 401) return 'invalid-credentials'
      return 'server-error'
    }
  }
  const logout = () => switchLogin(role)
  const requestCall = async ({ agentId, number }) => { try { return await apiRequest('/calls/dispatch', { method: 'POST', body: JSON.stringify({ agentId, number }) }) } catch { return null } }
  const getRemoteCall = callId => apiRequest(`/calls/${callId}`)
  const updateRemoteCall = (callId, status, seconds) => apiRequest(`/calls/${callId}/status`, { method: 'POST', body: JSON.stringify({ status, seconds }) }).catch(() => null)
  const addCall = call => { const duration = call.seconds || 0; const now = new Date(); const durationText = `${String(Math.floor(duration / 60)).padStart(2, '0')}:${String(duration % 60).padStart(2, '0')}`; setCalls(current => [{ ...call, id: `c-${Date.now()}`, date: dateKey(now), time: now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }), duration: durationText }, ...current]); setCallers(current => current.map(c => c.id === call.callerId ? { ...c, callsToday: (c.callsToday || 0) + 1 } : c)) }
  const createAgent = async form => {
    const names = form.name.trim().split(/\s+/)
    const colors = ['mint', 'blue', 'peach', 'lavender']
    const draft = { id: `agent-${Date.now()}`, name: form.name.trim(), username: form.username.trim().toLowerCase(), status: form.status, initials: names.map(name => name[0]).join('').slice(0, 2).toUpperCase(), callsToday: 0, talkTime: '0s', connected: null, lastSeen: 'Never', bridgeConnected: false, color: colors[callers.length % colors.length] }
    const remote = await apiRequest('/agents', { method: 'POST', body: JSON.stringify({ ...draft, password: form.password }) })
    return { ...draft, ...remote }
  }
  const caller = callers.find(c => c.id === callerUser)
  if (page === 'admin-login') return <Login type="admin" onLogin={login} onSwitch={() => switchLogin('caller')} />
  if (page === 'caller-login') return <Login type="caller" onLogin={login} onSwitch={() => switchLogin('admin')} />
  if (page === 'caller' || page === 'caller-history') return caller ? (page === 'caller' ? <CallerDashboard caller={caller} calls={calls} addCall={addCall} requestCall={requestCall} getRemoteCall={getRemoteCall} updateRemoteCall={updateRemoteCall} navigate={navigate} onLogout={logout} /> : <CallerHistory caller={caller} calls={calls} navigate={navigate} onLogout={logout} />) : <Login type="caller" onLogin={login} onSwitch={() => switchLogin('admin')} />
  return <div className="app-shell"><div className={`sidebar-mobile-overlay ${mobileOpen ? 'open' : ''}`} onClick={() => setMobileOpen(false)}></div><div className={`sidebar-mobile ${mobileOpen ? 'open' : ''}`}><Sidebar page={page} onNavigate={navigate} caller={caller} agentCount={callers.length} connectedDeviceCount={callers.filter(agent => agent.bridgeConnected).length} onLogout={logout} collapsed={false} setCollapsed={() => setMobileOpen(false)} /></div><Sidebar page={page} onNavigate={navigate} caller={caller} agentCount={callers.length} connectedDeviceCount={callers.filter(agent => agent.bridgeConnected).length} onLogout={logout} collapsed={collapsed} setCollapsed={setCollapsed} /><div className="main-area">{page === 'dashboard' && <Dashboard callers={callers} calls={calls} navigate={navigate} onMenu={() => setMobileOpen(true)} />}{page === 'telecallers' && <Telecallers callers={callers} setCallers={setCallers} navigate={navigate} onMenu={() => setMobileOpen(true)} onPair={startPairing} />}{page === 'new-caller' && <AddCaller setCallers={setCallers} navigate={navigate} onMenu={() => setMobileOpen(true)} onCreate={createAgent} />}{page === 'performance' && <Performance callers={callers} calls={calls} selectedId={selectedId} setSelectedId={setSelectedId} navigate={navigate} onMenu={() => setMobileOpen(true)} />}{page === 'history' && <><Topbar title="Call history" subtitle="A complete record of every call from your agents." onMenu={() => setMobileOpen(true)} action={<button className="secondary-button"><Icon name="download" size={16} />Export history</button>} /><main className="page-content"><div className="history-summary"><div><span className="eyebrow">ALL CALLS</span><strong>{calls.length}</strong><span>calls recorded</span></div><div><span className="eyebrow">ANSWER RATE</span><strong>{callStats(calls).answerRate}%</strong><span>from recorded calls</span></div><div className="history-summary-graphic"><MiniLineChart calls={calls} /></div></div><div className="list-toolbar"><div className="search-field"><Icon name="search" size={17} /><input placeholder="Search by number or agent" /></div><button className="secondary-button"><Icon name="calendar" size={16} />Date range <Icon name="chevron" size={13} /></button></div><section className="panel recent-panel"><div className="panel-head"><div><h3>All calls</h3><p>Call records from all agents</p></div><button className="icon-button"><Icon name="filter" size={17} /></button></div><CallsTable calls={calls} callers={callers} emptyText="No calls recorded yet" /></section></main></>}{page !== 'history' && page !== 'performance' && null}</div>{pairing && <PairingModal pairing={pairing} onClose={() => setPairing(null)} />}</div>
}

createRoot(document.getElementById('root')).render(<App />)

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {})
  })
}
