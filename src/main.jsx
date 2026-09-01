import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'

/* ------------------------------------------------------------------ api */

const api = async (path, options = {}) => {
  const response = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(payload.error || 'Something went wrong')
    error.status = response.status
    throw error
  }
  return payload
}

const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body || {}) })
const patch = (path, body) => api(path, { method: 'PATCH', body: JSON.stringify(body || {}) })
const remove = path => api(path, { method: 'DELETE', body: '{}' })

/* ----------------------------------------------------------- formatting */

// Local calendar day, not UTC: a 9pm call in Asia/Kolkata belongs to today, not tomorrow.
const dateKey = date =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
const todayKey = () => dateKey(new Date())
const formatDate = date => new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(date)
const clock = total => `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`

const formatDuration = seconds => {
  const total = Math.max(0, Number(seconds) || 0)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const remainingSeconds = total % 60
  if (hours) return `${hours}h ${minutes}m`
  if (minutes) return `${minutes}m ${remainingSeconds}s`
  return `${remainingSeconds}s`
}

const decorateCall = call => {
  const created = new Date(call.createdAt)
  // How long it rang before the other end picked up. Known only once the call has ended,
  // because the phone works the answer time out backwards from the call log.
  const ringSeconds = call.answeredAt && call.offhookAt
    ? Math.max(0, Math.round((new Date(call.answeredAt) - new Date(call.offhookAt)) / 1000))
    : null
  return {
    ...call,
    date: dateKey(created),
    time: created.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
    answeredTime: call.answeredAt ? new Date(call.answeredAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '',
    ringSeconds,
    duration: clock(Number(call.seconds) || 0),
  }
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
    averageSeconds: answered ? Math.round(talkSeconds / answered) : 0,
  }
}

const COUNTRY_CODES = [
  { code: '+91', label: 'India' },
  { code: '+1', label: 'USA / Canada' },
  { code: '+44', label: 'United Kingdom' },
  { code: '+61', label: 'Australia' },
  { code: '+971', label: 'UAE' },
  { code: '+65', label: 'Singapore' },
]

const downloadCsv = (filename, rows) => {
  const escape = value => `"${String(value ?? '').replace(/"/g, '""')}"`
  const body = rows.map(row => row.map(escape).join(',')).join('\r\n')
  const url = URL.createObjectURL(new Blob([`﻿${body}`], { type: 'text/csv;charset=utf-8' }))
  const link = Object.assign(document.createElement('a'), { href: url, download: filename })
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

const iso = value => (value ? new Date(value).toISOString() : '')

const callsToCsv = (calls, callers, filename) => downloadCsv(filename, [
  ['Date', 'Dialled', 'Agent', 'Phone number', 'Outcome',
   'Answered at', 'Ended at', 'Ring (s)', 'Talk time (s)', 'Talk time', 'Measured'],
  ...calls.map(call => [
    call.date, call.time,
    callers.find(caller => caller.id === call.callerId)?.name || '',
    call.number, call.status,
    iso(call.answeredAt), iso(call.endedAt),
    call.ringSeconds ?? '', call.seconds, call.duration,
    call.estimated ? 'estimated' : 'measured',
  ]),
])

/* --------------------------------------------------------------- routing */

const routeFor = pathname => {
  if (pathname === '/admin/login') return 'admin-login'
  if (pathname === '/login') return 'caller-login'
  if (pathname.startsWith('/caller/history')) return 'caller-history'
  if (pathname.startsWith('/caller')) return 'caller'
  if (pathname.startsWith('/admin/call-history')) return 'history'
  if (/^\/admin\/telecallers\/[^/]+\/performance/.test(pathname)) return 'performance'
  if (pathname === '/admin/telecallers/new') return 'new-caller'
  if (pathname.startsWith('/admin/telecallers')) return 'telecallers'
  return 'dashboard'
}

const idFromPath = pathname => pathname.match(/^\/admin\/telecallers\/([^/]+)\/performance/)?.[1] || ''

const pathFor = (page, id = '') => ({
  dashboard: '/admin/dashboard',
  telecallers: '/admin/telecallers',
  'new-caller': '/admin/telecallers/new',
  performance: `/admin/telecallers/${id}/performance`,
  history: '/admin/call-history',
  caller: '/caller',
  'caller-history': '/caller/history',
  'admin-login': '/admin/login',
  'caller-login': '/login',
}[page] || '/admin/dashboard')

/* ------------------------------------------------------------ primitives */

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
    logout: <><path d="M10 17l5-5-5-5" /><path d="M15 12H3" /><path d="M21 19V5a2 2 0 0 0-2-2h-6" /></>,
    search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></>,
    download: <><path d="M12 3v12M7 10l5 5 5-5" /><path d="M5 21h14" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    chevron: <path d="m6 9 6 6 6-6" />,
    close: <><path d="M6 6l12 12M18 6 6 18" /></>,
    menu: <><path d="M4 6h16M4 12h16M4 18h16" /></>,
    device: <><rect x="5" y="2" width="14" height="20" rx="2" /><path d="M12 18h.01" /></>,
    calendar: <><rect x="3" y="4" width="18" height="17" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" /></>,
    trend: <><path d="m4 14 5-5 4 4 7-7" /><path d="M15 6h5v5" /></>,
    edit: <><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" /></>,
    trash: <><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M10 11v6M14 11v6" /></>,
    key: <><circle cx="8" cy="15" r="4" /><path d="m10.85 12.15 8.15-8.15" /><path d="m18 6 2 2M15 9l2 2" /></>,
    unlink: <><path d="m9 15 6-6" /><path d="M11 6.5 12.5 5a4.6 4.6 0 0 1 6.5 6.5L17.5 13" /><path d="M6.5 11 5 12.5A4.6 4.6 0 0 0 11.5 19l1.5-1.5" /><path d="m2 2 20 20" /></>,
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
  const key = String(status || 'Offline').toLowerCase().replace(/\s+/g, '-')
  return <span className={`status status-${key}`}><span className="status-dot"></span>{status}</span>
}

function OutcomeBadge({ status }) {
  return <span className={`outcome outcome-${String(status).toLowerCase().replace(/\s+/g, '-')}`}>{status}</span>
}

function StatCard({ label, value, detail, tone = 'default', icon }) {
  return <div className={`stat-card stat-${tone}`}>
    <div className="stat-top"><span className="stat-label">{label}</span><span className="stat-icon"><Icon name={icon} size={17} /></span></div>
    <div className="stat-value">{value}</div>
    {detail && <div className="stat-detail">{detail}</div>}
  </div>
}

function Banner({ message, onDismiss }) {
  if (!message) return null
  return <div className="app-banner" role="alert"><span>{message}</span><button className="icon-button" onClick={onDismiss} aria-label="Dismiss"><Icon name="close" size={15} /></button></div>
}

function Topbar({ title, subtitle, action, onMenu }) {
  return <header className="topbar">
    <button className="mobile-menu" onClick={onMenu} aria-label="Open navigation"><Icon name="menu" size={21} /></button>
    <div><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div>
    <div className="topbar-actions">{action}</div>
  </header>
}

const navGroups = [
  { label: 'Workspace', items: [{ key: 'dashboard', label: 'Overview', icon: 'grid' }, { key: 'telecallers', label: 'Agents', icon: 'users' }] },
  { label: 'Manage', items: [{ key: 'performance', label: 'Performance', icon: 'chart' }, { key: 'history', label: 'Call history', icon: 'clock' }] },
]

function Sidebar({ page, onNavigate, admin, agentCount, connectedDeviceCount, onLogout, collapsed, setCollapsed }) {
  return <aside className={`sidebar ${collapsed ? 'sidebar-collapsed' : ''}`}>
    <div className="sidebar-head"><Logo compact={collapsed} /><button className="collapse-button" onClick={() => setCollapsed(!collapsed)} aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}><Icon name={collapsed ? 'arrow' : 'arrowLeft'} size={16} /></button></div>
    <div className="workspace-switch"><Avatar caller={{ initials: 'A', color: 'blue' }} small /><div className="workspace-details"><strong>Admin workspace</strong><span>Account management</span></div></div>
    <nav className="main-nav">
      {navGroups.map(group => <div className="nav-group" key={group.label}><span className="nav-group-label">{group.label}</span>{group.items.map(item => <button key={item.key} className={`nav-item ${page === item.key ? 'active' : ''}`} onClick={() => onNavigate(item.key)}><Icon name={item.icon} size={18} /><span>{item.label}</span>{item.key === 'telecallers' && !collapsed && agentCount > 0 && <em>{agentCount}</em>}</button>)}</div>)}
    </nav>
    <div className="sidebar-bottom">
      <div className="device-status"><span className="device-icon"><Icon name="device" size={17} /></span><div><strong>Android bridge</strong><span>{connectedDeviceCount ? `${connectedDeviceCount} device${connectedDeviceCount === 1 ? '' : 's'} connected` : 'No device connected'}</span></div></div>
      <div className="profile-chip"><Avatar caller={{ initials: admin?.initials || 'A', color: 'peach' }} small /><div><strong>{admin?.name || 'Administrator'}</strong><span>@{admin?.username || 'admin'}</span></div><button onClick={onLogout} aria-label="Log out"><Icon name="logout" size={16} /></button></div>
    </div>
  </aside>
}

/* ------------------------------------------------------------- charting */

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
  const width = compact ? 290 : 600
  const points = values.map((value, i) => `${(i / (values.length - 1)) * width},${75 - (value / max) * 62}`).join(' ')
  return <svg className={`mini-line-chart ${compact ? 'chart-compact' : ''}`} viewBox={`0 0 ${width} 90`} preserveAspectRatio="none"><defs><linearGradient id="area" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="#4faea0" stopOpacity=".25" /><stop offset="100%" stopColor="#4faea0" stopOpacity="0" /></linearGradient></defs><path d={`M ${points.replace(/ /g, ' L ')} L ${width},90 L 0,90 Z`} fill="url(#area)" /><polyline points={points} fill="none" stroke="#3d9b90" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
}

function ActivityChart({ calls = [], days = 30 }) {
  const values = dailyValues(calls, days)
  if (!values.some(Boolean)) return <div className="activity-empty"><Icon name="chart" size={21} /><strong>No call activity yet</strong><span>Daily activity appears here once an agent completes a call.</span></div>
  const max = Math.max(...values, 1)
  const points = values.map((value, i) => `${(i / Math.max(1, values.length - 1)) * 700},${105 - (value / max) * 92}`).join(' ')
  const area = `M ${points.replace(/ /g, ' L ')} L 700,120 L 0,120 Z`
  const end = new Date()
  const offsets = days <= 1 ? [0] : [days - 1, Math.round((days - 1) * 0.75), Math.round((days - 1) * 0.5), Math.round((days - 1) * 0.25), 0]
  const labels = offsets.map(offset => { const date = new Date(end); date.setDate(end.getDate() - offset); return new Intl.DateTimeFormat(undefined, { month: 'short', day: '2-digit' }).format(date) })
  return <div className="activity-chart"><div className="chart-y"><span>{max}</span><span>{Math.ceil(max * .75)}</span><span>{Math.ceil(max * .5)}</span><span>{Math.ceil(max * .25)}</span><span>0</span></div><svg viewBox="0 0 700 120" preserveAspectRatio="none"><defs><linearGradient id="bigArea" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="#3d9b90" stopOpacity=".26" /><stop offset="100%" stopColor="#3d9b90" stopOpacity=".015" /></linearGradient></defs><path d={area} fill="url(#bigArea)" /><polyline points={points} fill="none" stroke="#328d82" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" /></svg><div className="chart-x">{labels.map((label, i) => <span key={`${label}-${i}`}>{label}</span>)}</div></div>
}

function OutcomeChart({ calls = [] }) {
  const stats = callStats(calls)
  const total = stats.total || 1
  const data = [
    { label: 'Answered', value: stats.answered, color: 'teal' },
    { label: 'Missed', value: stats.missed, color: 'coral' },
    { label: 'Rejected', value: stats.rejected, color: 'amber' },
    { label: 'Failed', value: stats.failed, color: 'slate' },
  ].map(item => ({ ...item, pct: item.value ? Math.max(2, Math.round((item.value / total) * 100)) : 0 }))
  if (!stats.total) return <div className="activity-empty outcome-empty"><Icon name="chart" size={21} /><strong>No call outcomes yet</strong><span>The breakdown appears here once calls are recorded.</span></div>
  return <div className="outcome-chart"><div className="outcome-bars">{data.map(item => <div className="outcome-row" key={item.label}><span className="outcome-label"><i className={`bar-dot ${item.color}`}></i>{item.label}</span><div className="bar-track"><div className={`bar-fill ${item.color}`} style={{ width: `${item.pct}%` }}></div></div><strong>{item.value}</strong></div>)}</div></div>
}

/* ---------------------------------------------------------------- tables */

function CallsTable({ calls, callers, showCaller = true, limit, emptyText = 'No calls found' }) {
  const rows = limit ? calls.slice(0, limit) : calls
  return <div className="table-wrap"><table><thead><tr><th>Date &amp; time</th>{showCaller && <th>Agent</th>}<th>Phone number</th><th>Outcome</th><th>Talk time</th></tr></thead><tbody>
    {rows.length ? rows.map(call => {
      const caller = callers.find(item => item.id === call.callerId)
      const dateLabel = call.date === todayKey() ? 'Today' : formatDate(new Date(`${call.date}T00:00:00`))
      return <tr key={call.id}>
        <td><strong className="table-date">{call.time}</strong><span className="table-sub">{dateLabel}</span></td>
        {showCaller && <td><div className="person-cell"><Avatar caller={caller} small /><span>{caller?.name || 'Removed agent'}</span></div></td>}
        <td className="number-cell">{call.number}</td>
        <td><OutcomeBadge status={call.status} /></td>
        <td className="duration-cell">
          <strong className="table-date" title={call.estimated ? 'Estimated: the phone could not read its call log, so this includes ringing.' : 'Talk time, measured from the call log'}>{call.estimated ? `~${call.duration}` : call.duration}</strong>
          <span className="table-sub">{call.ringSeconds !== null
            ? `rang ${call.ringSeconds}s`
            : call.estimated ? 'estimated'
            : call.status === 'Answered' && !call.seconds ? 'not recorded' : ''}</span>
        </td>
      </tr>
    }) : <tr><td colSpan={showCaller ? 5 : 4} className="empty-cell">{emptyText}</td></tr>}
  </tbody></table></div>
}

function EmptyState({ icon = 'users', title, description, action }) {
  return <div className="empty-state"><span className="empty-state-icon"><Icon name={icon} size={20} /></span><strong>{title}</strong><p>{description}</p>{action}</div>
}

/* ---------------------------------------------------------------- modals */

function PairingModal({ pairing, onClose }) {
  return <div className="modal-backdrop" role="presentation" onClick={onClose}>
    <section className="pairing-modal panel" role="dialog" aria-modal="true" aria-labelledby="pairing-title" onClick={event => event.stopPropagation()}>
      <button className="modal-close icon-button" onClick={onClose} aria-label="Close"><Icon name="close" size={17} /></button>
      <span className="eyebrow">ANDROID DEVICE</span>
      <h2 id="pairing-title">Pair {pairing.name}</h2>
      {pairing.error ? <div className="form-error">{pairing.error}</div>
        : pairing.code ? <><p>Open Telecall Bridge on the agent's Android phone and enter this one-time code.</p><div className="pairing-code">{pairing.code}</div><small>The code expires in 10 minutes. Waiting for the phone to connect…</small></>
        : <><p>Preparing a secure pairing code for this agent.</p><div className="pairing-loading">Generating code…</div></>}
    </section>
  </div>
}

function ManageAgentModal({ agent, onClose, onSave, onResetPassword, onUnpair, onDelete }) {
  const [form, setForm] = useState({ name: agent.name, username: agent.username, status: agent.status })
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const update = key => event => setForm({ ...form, [key]: event.target.value })

  const run = async (action, success) => {
    setError(''); setNotice(''); setBusy(true)
    try { await action(); if (success) setNotice(success); else onClose() }
    catch (actionError) { setError(actionError.message) }
    finally { setBusy(false) }
  }

  return <div className="modal-backdrop" role="presentation" onClick={onClose}>
    <section className="pairing-modal manage-modal panel" role="dialog" aria-modal="true" aria-labelledby="manage-title" onClick={event => event.stopPropagation()}>
      <button className="modal-close icon-button" onClick={onClose} aria-label="Close"><Icon name="close" size={17} /></button>
      <span className="eyebrow">AGENT ACCOUNT</span>
      <h2 id="manage-title">Manage {agent.name}</h2>

      <form className="manage-form" onSubmit={event => { event.preventDefault(); run(() => onSave(agent.id, form)) }}>
        <label>Full name<input value={form.name} onChange={update('name')} /></label>
        <label>Username<div className="input-prefix"><span>@</span><input value={form.username} onChange={update('username')} /></div></label>
        <label>Status<select value={form.status} onChange={update('status')}><option>Active</option><option>Paused</option></select>
          <small>A paused agent is signed out immediately and cannot sign back in.</small></label>
        {error && <div className="form-error">{error}</div>}
        {notice && <div className="form-notice">{notice}</div>}
        <div className="form-actions">
          <button type="button" className="secondary-button" onClick={onClose}>Cancel</button>
          <button className="primary-button" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</button>
        </div>
      </form>

      <div className="manage-divider"></div>

      <div className="manage-row">
        <div><strong>Reset password</strong><p>The agent is signed out and must use the new password.</p></div>
        <div className="manage-row-action">
          <input type="password" value={password} placeholder="New password" onChange={event => setPassword(event.target.value)} />
          <button className="secondary-button" disabled={busy || password.length < 6}
            onClick={() => run(() => onResetPassword(agent.id, password), 'Password updated.').then(() => setPassword(''))}>
            <Icon name="key" size={15} />Reset
          </button>
        </div>
      </div>

      {agent.bridgeConnected || agent.deviceName ? <div className="manage-row">
        <div><strong>Paired phone</strong><p>{agent.deviceName || 'Android phone'} · {agent.bridgeConnected ? 'online' : `last seen ${agent.lastSeen}`}</p></div>
        <button className="secondary-button" disabled={busy} onClick={() => run(() => onUnpair(agent.id), 'Phone unpaired.')}><Icon name="unlink" size={15} />Unpair</button>
      </div> : null}

      <div className="manage-row">
        <div><strong>Delete account</strong><p>Removes the agent and every call they recorded. This cannot be undone.</p></div>
        {confirmingDelete
          ? <div className="manage-row-action"><button className="secondary-button" onClick={() => setConfirmingDelete(false)}>Keep</button><button className="danger-button" disabled={busy} onClick={() => run(() => onDelete(agent.id))}>Delete for good</button></div>
          : <button className="danger-button" onClick={() => setConfirmingDelete(true)}><Icon name="trash" size={15} />Delete</button>}
      </div>
    </section>
  </div>
}

/* ----------------------------------------------------------- admin pages */

const RANGES = [{ key: 30, label: '30 days' }, { key: 7, label: '7 days' }, { key: 1, label: 'Today' }]

function Dashboard({ callers, calls, navigate, onMenu }) {
  const [days, setDays] = useState(30)
  const cutoff = useMemo(() => { const date = new Date(); date.setHours(0, 0, 0, 0); date.setDate(date.getDate() - (days - 1)); return dateKey(date) }, [days])
  const scoped = useMemo(() => calls.filter(call => call.date >= cutoff), [calls, cutoff])
  const stats = useMemo(() => callStats(scoped), [scoped])
  const activeAgents = callers.filter(caller => caller.status === 'Active').length
  const connectedAgents = callers.filter(caller => caller.presence !== 'Offline').length
  return <>
    <Topbar title="Admin overview" subtitle="Manage agent accounts and monitor call activity." onMenu={onMenu}
      action={<button className="secondary-button" disabled={!scoped.length} onClick={() => callsToCsv(scoped, callers, `telecall-overview-${todayKey()}.csv`)}><Icon name="download" size={16} />Export report</button>} />
    <main className="page-content">
      <div className="hero-row">
        <div><span className="eyebrow">{new Intl.DateTimeFormat(undefined, { dateStyle: 'long' }).format(new Date())}</span><h2>Call activity</h2></div>
        <div className="live-indicator"><i></i> Live data <span>Refreshes every 5s</span></div>
      </div>
      <section className="stats-grid">
        <StatCard label="Total calls" value={String(stats.total)} detail={stats.total ? `${stats.answerRate}% answer rate` : 'No calls in this range'} icon="phone" tone="mint" />
        <StatCard label="Answered calls" value={String(stats.answered)} detail={stats.total ? `${stats.missed} missed · ${stats.failed} failed` : 'Waiting for the first call'} icon="check" />
        <StatCard label="Total talk time" value={formatDuration(stats.talkSeconds)} detail={stats.answered ? `Avg. ${formatDuration(stats.averageSeconds)} per answered call` : 'No talk time recorded'} icon="clock" />
        <StatCard label="Active agents" value={`${activeAgents} / ${callers.length}`} detail={callers.length ? `${connectedAgents} currently connected` : 'Create your first agent account'} icon="users" tone="peach" />
      </section>
      <section className="dashboard-grid">
        <div className="panel activity-panel">
          <div className="panel-head">
            <div><h3>Calling activity</h3><p>Daily call volume from all agents</p></div>
            <div className="segmented">{RANGES.map(range => <button key={range.key} className={days === range.key ? 'selected' : ''} onClick={() => setDays(range.key)}>{range.label}</button>)}</div>
          </div>
          <div className="big-chart"><ActivityChart calls={scoped} days={days} /></div>
        </div>
        <div className="panel agents-panel">
          <div className="panel-head"><div><h3>Agents</h3><p>Current account status</p></div><button className="text-button" onClick={() => navigate('telecallers')}>View all <Icon name="arrow" size={14} /></button></div>
          <div className="agent-list">{callers.length ? callers.slice(0, 4).map(caller => <div className="agent-row" key={caller.id}>
            <Avatar caller={caller} />
            <div className="agent-info"><strong>{caller.name}</strong><span>@{caller.username}</span></div>
            <div className="agent-calls"><strong>{caller.callsToday}</strong><span>today</span></div>
            <StatusPill status={caller.presence === 'In a call' ? 'In call' : caller.presence} />
          </div>) : <EmptyState icon="users" title="No agents yet" description="Create an agent account to start managing access." action={<button className="primary-button" onClick={() => navigate('new-caller')}><Icon name="plus" size={15} />Add agent</button>} />}</div>
        </div>
      </section>
      <section className="panel recent-panel">
        <div className="panel-head"><div><h3>Recent calls</h3><p>The latest activity from your agents</p></div><button className="text-button" onClick={() => navigate('history')}>See full history <Icon name="arrow" size={14} /></button></div>
        <CallsTable calls={scoped} callers={callers} limit={5} emptyText="No calls recorded yet" />
      </section>
    </main>
  </>
}

function Telecallers({ callers, navigate, onMenu, onPair, onManage }) {
  const [query, setQuery] = useState('')
  const filtered = callers.filter(caller => `${caller.name} ${caller.username}`.toLowerCase().includes(query.toLowerCase()))
  const connectedDevices = callers.filter(caller => caller.bridgeConnected).length
  return <>
    <Topbar title="Agents" subtitle="Manage agent accounts and access." onMenu={onMenu}
      action={<button className="primary-button" onClick={() => navigate('new-caller')}><Icon name="plus" size={17} />Add agent</button>} />
    <main className="page-content">
      <div className="metric-strip">
        <div><span className="eyebrow">AGENT ACCOUNTS</span><strong>{callers.length}</strong><small>registered agents</small></div>
        <div><span className="eyebrow">ACTIVE AGENTS</span><strong>{callers.filter(caller => caller.status === 'Active').length}</strong><small>enabled accounts</small></div>
        <div><span className="eyebrow">CONNECTED DEVICES</span><strong>{connectedDevices}</strong><small>{connectedDevices ? 'phones online' : 'no phones paired'}</small></div>
        <div className="strip-illustration"><span></span><span></span><span></span><span></span><span></span></div>
      </div>
      <div className="list-toolbar"><div className="search-field"><Icon name="search" size={17} /><input placeholder="Search agents" value={query} onChange={event => setQuery(event.target.value)} /></div></div>
      <section className="panel caller-list-panel">
        <div className="panel-head"><div><h3>All agents <span className="count-badge">{filtered.length}</span></h3><p>Account access and current status</p></div></div>
        <div className="table-wrap"><table className="caller-table">
          <thead><tr><th>Agent</th><th>Status</th><th>Today&rsquo;s calls</th><th>Talk time</th><th>Device</th><th>Last active</th><th></th></tr></thead>
          <tbody>{filtered.length ? filtered.map(caller => <tr key={caller.id}>
            <td><div className="person-cell"><Avatar caller={caller} /><div><strong>{caller.name}</strong><span>@{caller.username}</span></div></div></td>
            <td><StatusPill status={caller.status} /></td>
            <td><strong>{caller.callsToday}</strong><span className="table-sub">calls</span></td>
            <td>{formatDuration(caller.talkTodaySeconds)}</td>
            <td>{caller.bridgeConnected
              ? <><span className="connection device-connected"><span style={{ width: '100%' }}></span></span><strong className="connection-text">Online</strong></>
              : <span className="muted-cell">{caller.deviceName ? 'Offline' : 'Not paired'}</span>}</td>
            <td className="muted-cell">{caller.lastSeen}</td>
            <td><div className="row-actions">
              <button className="view-button" onClick={() => onPair(caller)}>{caller.bridgeConnected ? 'Re-pair' : 'Pair device'}</button>
              <button className="icon-button" onClick={() => onManage(caller)} aria-label={`Manage ${caller.name}`}><Icon name="edit" size={16} /></button>
              <button className="icon-button" onClick={() => navigate('performance', caller.id)} aria-label={`View ${caller.name}'s performance`}><Icon name="chart" size={16} /></button>
            </div></td>
          </tr>) : <tr><td colSpan="7" className="empty-cell">{query ? 'No agents match that search.' : 'No agent accounts yet. Add an agent to get started.'}</td></tr>}</tbody>
        </table></div>
      </section>
      <p className="table-note"><Icon name="device" size={14} /> Pair each agent&rsquo;s Android phone to place calls through its physical SIM.</p>
    </main>
  </>
}

function AddCaller({ navigate, onMenu, onCreate }) {
  const [form, setForm] = useState({ name: '', username: '', password: '', status: 'Active' })
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const update = key => event => setForm({ ...form, [key]: event.target.value })
  const submit = async event => {
    event.preventDefault()
    if (!form.name || !form.username || !form.password) { setError('Complete all three fields to create the account.'); return }
    if (form.password.length < 6) { setError('Choose a password of at least 6 characters.'); return }
    setError(''); setSaving(true)
    try { await onCreate(form); navigate('telecallers') }
    catch (createError) { setError(createError.message) }
    finally { setSaving(false) }
  }
  return <>
    <Topbar title="Add agent" subtitle="Create an account for a calling agent." onMenu={onMenu}
      action={<button className="secondary-button" onClick={() => navigate('telecallers')}><Icon name="arrowLeft" size={16} />Back to agents</button>} />
    <main className="page-content form-page"><div className="form-layout">
      <div className="form-intro"><span className="eyebrow">NEW ACCOUNT</span><h2>Set up an agent</h2><p>Give the agent access to the calling screen and their own activity history.</p></div>
      <form className="panel caller-form" onSubmit={submit}>
        <div className="form-section">
          <div className="form-section-title"><span className="step-number">1</span><div><h3>Account details</h3><p>Basic information for this agent</p></div></div>
          <label>Full name<input value={form.name} onChange={update('name')} placeholder="e.g. Priya Sharma" /></label>
          <label>Username<div className="input-prefix"><span>@</span><input value={form.username} onChange={update('username')} placeholder="Enter username" /></div><small>The agent signs in with this username.</small></label>
          <label>Password<input type="password" value={form.password} onChange={update('password')} placeholder="At least 6 characters" /><small>Share it with the agent directly. You can reset it at any time.</small></label>
        </div>
        <div className="form-divider"></div>
        <div className="form-section">
          <div className="form-section-title"><span className="step-number">2</span><div><h3>Account status</h3><p>Choose whether the agent can start calling right away</p></div></div>
          <label>Status<select value={form.status} onChange={update('status')}><option>Active</option><option>Paused</option></select></label>
        </div>
        {error && <div className="form-error">{error}</div>}
        <div className="form-actions">
          <button type="button" className="secondary-button" onClick={() => navigate('telecallers')}>Cancel</button>
          <button className="primary-button" type="submit" disabled={saving}>{saving ? 'Creating…' : <>Create account <Icon name="arrow" size={15} /></>}</button>
        </div>
      </form>
    </div></main>
  </>
}

function Performance({ callers, calls, selectedId, setSelectedId, navigate, onMenu }) {
  const selected = callers.find(caller => caller.id === selectedId) || callers[0]
  const [from, setFrom] = useState(() => { const date = new Date(); date.setDate(1); return dateKey(date) })
  const [to, setTo] = useState(() => todayKey())
  const scoped = useMemo(
    () => calls.filter(call => call.callerId === selected?.id && call.date >= from && call.date <= to),
    [calls, selected?.id, from, to],
  )
  const stats = useMemo(() => callStats(scoped), [scoped])
  if (!selected) return <>
    <Topbar title="Performance" subtitle="Review call activity by agent." onMenu={onMenu} />
    <main className="page-content"><EmptyState icon="users" title="No agents available" description="Create an agent account before reviewing performance." action={<button className="primary-button" onClick={() => navigate('new-caller')}><Icon name="plus" size={15} />Add agent</button>} /></main>
  </>
  return <>
    <Topbar title="Performance" subtitle="Review call activity by agent." onMenu={onMenu}
      action={<button className="secondary-button" disabled={!scoped.length} onClick={() => callsToCsv(scoped, callers, `telecall-${selected.username}-${from}-to-${to}.csv`)}><Icon name="download" size={16} />Export performance</button>} />
    <main className="page-content">
      <div className="performance-filter panel">
        <div className="caller-select"><Avatar caller={selected} /><div><span className="eyebrow">AGENT</span>
          <select value={selected.id} onChange={event => setSelectedId(event.target.value)}>{callers.map(caller => <option value={caller.id} key={caller.id}>{caller.name}</option>)}</select></div></div>
        <div className="date-fields">
          <label>From<input type="date" value={from} max={to} onChange={event => setFrom(event.target.value)} /></label>
          <span className="date-dash">—</span>
          <label>To<input type="date" value={to} min={from} onChange={event => setTo(event.target.value)} /></label>
        </div>
      </div>
      <div className="performance-heading">
        <div><h2>{selected.name}<span className="heading-status"><StatusPill status={selected.status} /></span></h2><p>{scoped.length} call{scoped.length === 1 ? '' : 's'} from {formatDate(new Date(`${from}T00:00:00`))} to {formatDate(new Date(`${to}T00:00:00`))}</p></div>
      </div>
      <section className="stats-grid performance-stats">
        <StatCard label="Total calls" value={String(stats.total)} detail={stats.total ? `${stats.answerRate}% answer rate` : 'No calls in this range'} icon="phone" tone="mint" />
        <StatCard label="Answered calls" value={String(stats.answered)} detail={`${stats.missed} missed · ${stats.rejected} rejected · ${stats.failed} failed`} icon="check" />
        <StatCard label="Total talk time" value={formatDuration(stats.talkSeconds)} detail={stats.answered ? 'Across answered calls' : 'No talk time recorded'} icon="clock" />
        <StatCard label="Avg. call duration" value={formatDuration(stats.averageSeconds)} detail={stats.answered ? 'Per answered call' : 'No answered calls yet'} icon="trend" tone="peach" />
      </section>
      <section className="charts-grid">
        <div className="panel chart-panel"><div className="panel-head"><div><h3>Calls per day</h3><p>Call volume over the last 30 days</p></div><span className="chart-legend"><i></i> Calls</span></div><ActivityChart calls={scoped} /></div>
        <div className="panel chart-panel outcome-panel"><div className="panel-head"><div><h3>Call outcomes</h3><p>Results in the selected range</p></div></div><OutcomeChart calls={scoped} /></div>
      </section>
      <section className="panel recent-panel">
        <div className="panel-head"><div><h3>Recent calls</h3><p>Latest calls made by {selected.name.split(' ')[0]}</p></div><button className="text-button" onClick={() => navigate('history')}>All agents <Icon name="arrow" size={14} /></button></div>
        <CallsTable calls={scoped} callers={callers} showCaller={false} limit={6} emptyText="No calls recorded in this range" />
      </section>
    </main>
  </>
}

function AdminHistory({ callers, calls, onMenu }) {
  const [query, setQuery] = useState('')
  const [agentId, setAgentId] = useState('')
  const filtered = useMemo(() => calls.filter(call => {
    if (agentId && call.callerId !== agentId) return false
    if (!query) return true
    const caller = callers.find(item => item.id === call.callerId)
    return `${call.number} ${caller?.name || ''}`.toLowerCase().includes(query.toLowerCase())
  }), [calls, callers, query, agentId])
  const stats = callStats(filtered)
  return <>
    <Topbar title="Call history" subtitle="A complete record of every call from your agents." onMenu={onMenu}
      action={<button className="secondary-button" disabled={!filtered.length} onClick={() => callsToCsv(filtered, callers, `telecall-history-${todayKey()}.csv`)}><Icon name="download" size={16} />Export history</button>} />
    <main className="page-content">
      <div className="history-summary">
        <div><span className="eyebrow">CALLS SHOWN</span><strong>{filtered.length}</strong><span>of {calls.length} recorded</span></div>
        <div><span className="eyebrow">ANSWER RATE</span><strong>{stats.answerRate}%</strong><span>{stats.answered} answered</span></div>
        <div className="history-summary-graphic"><MiniLineChart calls={filtered} /></div>
      </div>
      <div className="list-toolbar">
        <div className="search-field"><Icon name="search" size={17} /><input placeholder="Search by number or agent" value={query} onChange={event => setQuery(event.target.value)} /></div>
        <select className="inline-select" value={agentId} onChange={event => setAgentId(event.target.value)}>
          <option value="">All agents</option>
          {callers.map(caller => <option key={caller.id} value={caller.id}>{caller.name}</option>)}
        </select>
      </div>
      <section className="panel recent-panel">
        <div className="panel-head"><div><h3>All calls</h3><p>Call records from every agent</p></div></div>
        <CallsTable calls={filtered} callers={callers} emptyText={calls.length ? 'No calls match those filters' : 'No calls recorded yet'} />
      </section>
    </main>
  </>
}

/* ---------------------------------------------------------- agent pages */

const TERMINAL = ['Answered', 'Missed', 'Rejected', 'Failed']

function CallerHeader({ me, onLogout }) {
  return <header className="caller-topbar"><Logo /><div className="caller-top-actions">
    <div className={`bridge-pill ${me.bridgeConnected ? '' : 'bridge-offline'}`}><i></i><Icon name="device" size={15} /> {me.bridgeConnected ? `${me.deviceName || 'Android phone'} online` : 'Android bridge required'}</div>
    <div className="caller-user"><Avatar caller={me} small /><span>{me.name}</span><button onClick={onLogout} aria-label="Log out"><Icon name="logout" size={16} /></button></div>
  </div></header>
}

function CallerNav({ page, navigate }) {
  return <nav className="caller-nav">
    <button className={page === 'caller' ? 'active' : ''} onClick={() => navigate('caller')}><Icon name="phone" size={17} />Calling screen</button>
    <button className={page === 'caller-history' ? 'active' : ''} onClick={() => navigate('caller-history')}><Icon name="clock" size={17} />My call history</button>
  </nav>
}

function CallerDashboard({ me, calls, refresh, navigate, onLogout }) {
  const [countryCode, setCountryCode] = useState('+91')
  const [number, setNumber] = useState('')
  const [active, setActive] = useState(null)
  const [seconds, setSeconds] = useState(0)
  const [error, setError] = useState('')
  const [outcome, setOutcome] = useState('')

  useEffect(() => {
    if (!active?.id) return undefined
    let live = true
    const tick = async () => {
      try {
        const call = await api(`/calls/${active.id}`)
        if (!live) return
        if (TERMINAL.includes(call.status)) {
          setActive(null)
          setNumber('')
          setOutcome(call.status === 'Answered'
            ? `Answered · ${clock(call.seconds)} talk time${call.estimated ? ' (estimated)' : ''}`
            : call.status)
          refresh()
        } else {
          setActive(current => current && { ...current, status: call.status, offhookAt: call.offhookAt })
        }
      } catch { /* transient: the next tick retries */ }
    }
    tick()
    const timer = setInterval(tick, 1000)
    return () => { live = false; clearInterval(timer) }
  }, [active?.id, refresh])

  useEffect(() => {
    if (!active?.offhookAt) { setSeconds(0); return undefined }
    const offhook = new Date(active.offhookAt).getTime()
    const timer = setInterval(() => setSeconds(Math.max(0, Math.floor((Date.now() - offhook) / 1000))), 250)
    return () => clearInterval(timer)
  }, [active?.offhookAt])

  const digits = number.replace(/\D/g, '')
  const todayCalls = calls.filter(call => call.date === todayKey())
  const todayStats = callStats(todayCalls)

  const startCall = async () => {
    setError(''); setOutcome('')
    try {
      const { callId } = await post('/calls/dispatch', { number: `${countryCode}${digits}` })
      setActive({ id: callId, number: `${countryCode} ${number}`, status: 'Queued' })
    } catch (dispatchError) { setError(dispatchError.message) }
  }

  const endCall = async () => {
    try { await post(`/calls/${active.id}/hangup`) }
    catch (hangupError) { setError(hangupError.message) }
  }

  const connected = active?.status === 'In progress'
  const label = connected ? 'ON THE LINE' : active?.status === 'Calling' ? 'DIALLING' : active?.status === 'Ending' ? 'HANGING UP' : 'SENDING TO PHONE'

  return <div className="caller-app">
    <CallerHeader me={me} onLogout={onLogout} />
    <CallerNav page="caller" navigate={navigate} />
    <main className="caller-content">
      <div className="caller-welcome">
        <div><span className="eyebrow">CALLING SCREEN</span><h1>Ready when you are, {me.name.split(' ')[0]}.</h1><p>Calls are placed through the SIM in your paired Android phone.</p></div>
        <div className="caller-date"><Icon name="calendar" size={15} /> {new Intl.DateTimeFormat(undefined, { dateStyle: 'long' }).format(new Date())}</div>
      </div>
      <div className="caller-grid">
        <section className={`call-card ${active ? 'is-calling' : ''}`}>
          <div className="call-card-glow"></div>
          {active ? <>
            <div className="calling-state">
              <div className="pulse-ring"><Icon name="phone" size={25} /></div>
              <span className="eyebrow">{label}</span>
              <h2>{active.number}</h2>
              <strong className="call-timer">{connected ? clock(seconds) : active.status === 'Calling' ? 'Ringing…' : 'Connecting…'}</strong>
              <p>{connected
                ? 'Time since dialling, including the ringing. Exact talk time is recorded when the call ends.'
                : 'Waiting for the Android phone to place the call.'}</p>
            </div>
            <div className="call-controls">
              <button className="end-call" onClick={endCall} disabled={active.status === 'Ending'}><Icon name="phone" size={19} />{active.status === 'Ending' ? 'Ending…' : connected ? 'End call' : 'Cancel'}</button>
            </div>
            {error && <div className="form-error">{error}</div>}
          </> : <>
            <div className="call-card-icon"><Icon name="phone" size={24} /></div>
            <span className="eyebrow">OUTBOUND CALL</span>
            <h2>Who would you like to call?</h2>
            <p>Enter a number and it is dialled on your paired phone.</p>
            <div className="number-input">
              <select className="country-code" value={countryCode} onChange={event => setCountryCode(event.target.value)} aria-label="Country code">
                {COUNTRY_CODES.map(item => <option key={item.code} value={item.code}>{item.code}</option>)}
              </select>
              <input type="tel" value={number} placeholder="Phone number" onChange={event => setNumber(event.target.value.replace(/[^0-9 -]/g, ''))} onKeyDown={event => event.key === 'Enter' && digits.length >= 7 && me.bridgeConnected && startCall()} />
            </div>
            <button className="call-button" onClick={startCall} disabled={!me.bridgeConnected || digits.length < 7}><Icon name="phone" size={18} />Call now</button>
            {error && <div className="form-error">{error}</div>}
            {outcome && !error && <div className="form-notice">Last call: {outcome}</div>}
            <small className={me.bridgeConnected ? '' : 'bridge-required'}><i></i> {me.bridgeConnected ? 'Android bridge ready' : 'Ask your administrator to pair your phone'}</small>
          </>}
        </section>
        <aside className="caller-side">
          <div className="panel today-card">
            <div className="panel-head"><div><h3>Today&rsquo;s activity</h3><p>Your calling snapshot</p></div><span className="today-icon"><Icon name="trend" size={17} /></span></div>
            <div className="today-number"><strong>{todayCalls.length}</strong><span>calls · {formatDuration(todayStats.talkSeconds)} talk time</span></div>
            <MiniLineChart calls={calls} />
            <div className="today-footer"><span><i className="teal-dot"></i> Answered <strong>{todayStats.answered}</strong></span><span><i className="coral-dot"></i> Missed <strong>{todayStats.missed}</strong></span></div>
          </div>
          <div className="panel bridge-card">
            <div className="bridge-icon"><Icon name="device" size={19} /></div>
            <div><strong>Android bridge</strong><p>{me.bridgeConnected ? me.deviceName || 'Android phone' : 'No device connected'}</p>
              <span className={me.bridgeConnected ? '' : 'bridge-required'}><i></i> {me.bridgeConnected ? 'Device online' : 'Setup required'}</span></div>
          </div>
        </aside>
      </div>
      <section className="panel caller-recent">
        <div className="panel-head"><div><h3>Recent calls</h3><p>Your latest calls</p></div><button className="text-button" onClick={() => navigate('caller-history')}>View history <Icon name="arrow" size={14} /></button></div>
        <CallsTable calls={calls} callers={[me]} showCaller={false} limit={4} emptyText="No calls recorded yet" />
      </section>
    </main>
  </div>
}

function CallerHistory({ me, calls, navigate, onLogout }) {
  const [query, setQuery] = useState('')
  const filtered = calls.filter(call => call.number.toLowerCase().includes(query.toLowerCase()))
  return <div className="caller-app">
    <CallerHeader me={me} onLogout={onLogout} />
    <CallerNav page="caller-history" navigate={navigate} />
    <main className="caller-content history-content">
      <div className="caller-welcome">
        <div><span className="eyebrow">YOUR ACTIVITY</span><h1>Call history</h1><p>Every call you have made, all in one place.</p></div>
        <div className="history-total"><strong>{calls.length}</strong><span>calls recorded</span></div>
      </div>
      <div className="list-toolbar caller-toolbar">
        <div className="search-field"><Icon name="search" size={17} /><input placeholder="Search phone numbers" value={query} onChange={event => setQuery(event.target.value)} /></div>
      </div>
      <section className="panel caller-recent history-table">
        <div className="panel-head"><div><h3>All calls</h3><p>Your complete calling activity</p></div>
          <button className="secondary-button" disabled={!filtered.length} onClick={() => callsToCsv(filtered, [me], `my-calls-${todayKey()}.csv`)}><Icon name="download" size={15} />Export</button></div>
        <CallsTable calls={filtered} callers={[me]} showCaller={false} emptyText={calls.length ? 'No calls match that search' : 'No calls recorded yet'} />
      </section>
    </main>
  </div>
}

/* ----------------------------------------------------------------- login */

function Login({ portal, onLogin, onSwitch }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const isAdmin = portal === 'admin'
  const submit = async event => {
    event.preventDefault()
    if (!username || !password) { setError('Enter your username and password to continue.'); return }
    setError(''); setBusy(true)
    try { await onLogin(username.trim(), password) }
    catch (loginError) { setError(loginError.message) }
    finally { setBusy(false) }
  }
  return <div className="login-page">
    <div className="login-art"><Logo /><div className="login-art-copy"><span className="eyebrow">CALL OPERATIONS</span><h1>Keep calling work organized.</h1><p>One workspace for the admin account and every agent.</p></div></div>
    <div className="login-form-side"><div className="login-form-wrap">
      <div className="mobile-login-logo"><Logo /></div>
      <div className="login-heading"><span className="eyebrow">{isAdmin ? 'ADMIN PORTAL' : 'AGENT PORTAL'}</span><h2>Welcome back</h2>
        <p>{isAdmin ? 'Sign in to manage agent accounts and call activity.' : 'Sign in to reach your calling screen.'}</p></div>
      <form onSubmit={submit}>
        <label>Username<div className="input-prefix"><span>@</span><input value={username} autoComplete="username" onChange={event => setUsername(event.target.value)} placeholder={isAdmin ? 'Enter admin username' : 'Enter assigned username'} /></div></label>
        <label>Password<input type="password" value={password} autoComplete="current-password" onChange={event => setPassword(event.target.value)} placeholder="Enter password" /></label>
        {error && <div className="form-error">{error}</div>}
        <button className="primary-button login-button" disabled={busy}>{busy ? 'Signing in…' : <>Sign in <Icon name="arrow" size={16} /></>}</button>
      </form>
      <p className="login-help">Forgotten your password? Ask your administrator to reset it.</p>
      <p className="login-switch">{isAdmin ? 'Are you an agent?' : 'Are you the administrator?'} <button type="button" onClick={onSwitch}>{isAdmin ? 'Agent sign in' : 'Admin sign in'}</button></p>
    </div><span className="login-legal">Telecall v1.0 <span>·</span> Secure workspace</span></div>
  </div>
}

/* ------------------------------------------------------------------- app */

function App() {
  const [session, setSession] = useState(undefined)
  const [telecallers, setTelecallers] = useState([])
  const [calls, setCalls] = useState([])
  const [page, setPage] = useState(() => routeFor(window.location.pathname))
  const [selectedId, setSelectedId] = useState(() => idFromPath(window.location.pathname))
  const [collapsed, setCollapsed] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [pairing, setPairing] = useState(null)
  const [managing, setManaging] = useState(null)
  const [banner, setBanner] = useState('')
  const roleRef = useRef(null)
  roleRef.current = session?.role || null

  const refresh = useCallback(async () => {
    if (!roleRef.current) return
    try {
      const [me, records, people] = await Promise.all([
        api('/auth/me'),
        api('/calls'),
        roleRef.current === 'admin' ? api('/telecallers') : Promise.resolve(null),
      ])
      setSession(me)
      setCalls(records.map(decorateCall))
      if (people) setTelecallers(people)
    } catch (error) {
      if (error.status === 401) { setSession(null); setCalls([]); setTelecallers([]) }
    }
  }, [])

  useEffect(() => { api('/auth/me').then(setSession).catch(() => setSession(null)) }, [])
  useEffect(() => { if (session?.id) refresh() }, [session?.id, refresh])
  useEffect(() => {
    if (!session?.id) return undefined
    const timer = setInterval(refresh, 5000)
    return () => clearInterval(timer)
  }, [session?.id, refresh])

  useEffect(() => {
    const onPop = () => { setPage(routeFor(window.location.pathname)); setSelectedId(idFromPath(window.location.pathname)) }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  const navigate = useCallback((next, id) => {
    setPage(next)
    if (id) setSelectedId(id)
    setMobileOpen(false)
    window.history.pushState({}, '', pathFor(next, id || selectedId))
  }, [selectedId])

  const login = async (username, password) => {
    const user = await post('/auth/login', { username, password })
    const target = user.role === 'admin' ? 'dashboard' : 'caller'
    setSession(user)
    setPage(target)
    window.history.replaceState({}, '', pathFor(target))
  }

  const logout = async () => {
    const portal = roleRef.current === 'admin' ? 'admin-login' : 'caller-login'
    await post('/auth/logout').catch(() => {})
    setSession(null); setCalls([]); setTelecallers([]); setPairing(null); setManaging(null)
    setPage(portal)
    window.history.pushState({}, '', pathFor(portal))
  }

  const startPairing = async agent => {
    setPairing({ agentId: agent.id, name: agent.name })
    try {
      const result = await post(`/telecallers/${agent.id}/pairing`)
      setPairing({ agentId: agent.id, name: agent.name, code: result.code })
    } catch (error) { setPairing({ agentId: agent.id, name: agent.name, error: error.message }) }
  }

  useEffect(() => {
    if (!pairing?.code) return undefined
    let live = true
    const check = async () => {
      try {
        const device = await api(`/telecallers/${pairing.agentId}/device`)
        if (live && device.connected) { setPairing(null); setBanner('Phone paired successfully.'); refresh() }
      } catch { /* keep waiting */ }
    }
    const timer = setInterval(check, 2000)
    return () => { live = false; clearInterval(timer) }
  }, [pairing?.code, pairing?.agentId, refresh])

  const createAgent = async form => { await post('/telecallers', form); await refresh(); setBanner(`${form.name} can now sign in.`) }
  const saveAgent = async (id, form) => { await patch(`/telecallers/${id}`, form); await refresh(); setManaging(null); setBanner('Agent updated.') }
  const resetAgentPassword = async (id, password) => { await post(`/telecallers/${id}/password`, { password }); await refresh() }
  const unpairAgent = async id => { await remove(`/telecallers/${id}/device`); await refresh() }
  const deleteAgent = async id => { await remove(`/telecallers/${id}`); await refresh(); setManaging(null); setBanner('Agent deleted.') }

  if (session === undefined) return <div className="boot-screen"><Logo /><span>Loading your workspace…</span></div>

  if (!session) {
    const portal = page === 'caller-login' || page === 'caller' || page === 'caller-history' ? 'caller' : 'admin'
    const switchTo = portal === 'admin' ? 'caller-login' : 'admin-login'
    return <Login portal={portal} onLogin={login} onSwitch={() => { setPage(switchTo); window.history.pushState({}, '', pathFor(switchTo)) }} />
  }

  if (session.role === 'telecaller') {
    const view = page === 'caller-history' ? 'caller-history' : 'caller'
    return view === 'caller'
      ? <CallerDashboard me={session} calls={calls} refresh={refresh} navigate={navigate} onLogout={logout} />
      : <CallerHistory me={session} calls={calls} navigate={navigate} onLogout={logout} />
  }

  const adminPage = ['caller', 'caller-history', 'admin-login', 'caller-login'].includes(page) ? 'dashboard' : page
  const connectedDevices = telecallers.filter(agent => agent.bridgeConnected).length
  const sidebar = collapsedState => <Sidebar page={adminPage} onNavigate={navigate} admin={session} agentCount={telecallers.length}
    connectedDeviceCount={connectedDevices} onLogout={logout} collapsed={collapsedState} setCollapsed={collapsedState === false && mobileOpen ? () => setMobileOpen(false) : setCollapsed} />

  return <div className="app-shell">
    <div className={`sidebar-mobile-overlay ${mobileOpen ? 'open' : ''}`} onClick={() => setMobileOpen(false)}></div>
    <div className={`sidebar-mobile ${mobileOpen ? 'open' : ''}`}>{sidebar(false)}</div>
    {sidebar(collapsed)}
    <div className="main-area">
      <Banner message={banner} onDismiss={() => setBanner('')} />
      {adminPage === 'dashboard' && <Dashboard callers={telecallers} calls={calls} navigate={navigate} onMenu={() => setMobileOpen(true)} />}
      {adminPage === 'telecallers' && <Telecallers callers={telecallers} navigate={navigate} onMenu={() => setMobileOpen(true)} onPair={startPairing} onManage={setManaging} />}
      {adminPage === 'new-caller' && <AddCaller navigate={navigate} onMenu={() => setMobileOpen(true)} onCreate={createAgent} />}
      {adminPage === 'performance' && <Performance callers={telecallers} calls={calls} selectedId={selectedId} setSelectedId={id => navigate('performance', id)} navigate={navigate} onMenu={() => setMobileOpen(true)} />}
      {adminPage === 'history' && <AdminHistory callers={telecallers} calls={calls} onMenu={() => setMobileOpen(true)} />}
    </div>
    {pairing && <PairingModal pairing={pairing} onClose={() => setPairing(null)} />}
    {managing && <ManageAgentModal agent={telecallers.find(agent => agent.id === managing.id) || managing} onClose={() => setManaging(null)}
      onSave={saveAgent} onResetPassword={resetAgentPassword} onUnpair={unpairAgent} onDelete={deleteAgent} />}
  </div>
}

createRoot(document.getElementById('root')).render(<App />)

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}) })
}
