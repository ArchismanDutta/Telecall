import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const dataDirectory = path.join(root, '..', '.data')
const dataFile = path.join(dataDirectory, 'telecall.json')
const distDirectory = path.join(root, '..', 'dist')
const port = Number(process.env.PORT || 8787)

const emptyState = () => ({ agents: {}, devices: {}, pairings: {}, calls: {}, commands: [] })
let state = emptyState()

try {
  state = JSON.parse(fs.readFileSync(dataFile, 'utf8'))
} catch {
  state = emptyState()
}

const persist = () => {
  fs.mkdirSync(dataDirectory, { recursive: true })
  fs.writeFileSync(dataFile, JSON.stringify(state, null, 2))
}

const id = prefix => `${prefix}-${crypto.randomUUID()}`
const normalizeUsername = value => String(value || '').trim().toLowerCase()
const hashPassword = (password, salt = crypto.randomBytes(16).toString('hex')) => {
  const digest = crypto.scryptSync(String(password), salt, 64).toString('hex')
  return `${salt}:${digest}`
}
const passwordMatches = (password, storedHash) => {
  const [salt, expectedHex] = String(storedHash || '').split(':')
  if (!salt || !expectedHex) return false
  const actual = crypto.scryptSync(String(password), salt, 64)
  const expected = Buffer.from(expectedHex, 'hex')
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected)
}
const send = (response, status, payload) => {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  })
  response.end(JSON.stringify(payload))
}

const readBody = request => new Promise((resolve, reject) => {
  let value = ''
  request.on('data', chunk => { value += chunk })
  request.on('end', () => {
    try { resolve(value ? JSON.parse(value) : {}) } catch { reject(new Error('Invalid JSON')) }
  })
  request.on('error', reject)
})

const deviceForAgent = agent => agent?.deviceToken ? state.devices[agent.deviceToken] : null
const isConnected = device => Boolean(device && Date.now() - device.lastSeen < 30_000)
const publicAgent = agent => {
  if (!agent) return null
  const device = deviceForAgent(agent)
  const { passwordHash, ...safeAgent } = agent
  return {
    ...safeAgent,
    bridgeConnected: isConnected(device),
    deviceName: device?.deviceName || '',
    lastSeen: device ? 'Just now' : safeAgent.lastSeen || 'Never',
  }
}
const contentTypes = { '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' }

const serveApp = (response, pathname) => {
  let requestedPath
  try { requestedPath = decodeURIComponent(pathname) } catch { return send(response, 400, { error: 'Invalid path' }) }
  const relativePath = path.normalize(requestedPath === '/' ? '/index.html' : requestedPath).replace(/^[/\\]+/, '')
  const candidate = path.join(distDirectory, relativePath)
  const safeCandidate = candidate.startsWith(distDirectory + path.sep) ? candidate : path.join(distDirectory, 'index.html')
  const filePath = path.extname(safeCandidate) ? safeCandidate : path.join(distDirectory, 'index.html')
  try {
    const data = fs.readFileSync(filePath)
    response.writeHead(200, { 'Content-Type': contentTypes[path.extname(filePath)] || 'application/octet-stream', 'Cache-Control': path.basename(filePath) === 'index.html' ? 'no-cache' : 'public, max-age=31536000, immutable' })
    response.end(data)
  } catch {
    send(response, 404, { error: 'App asset not found. Run npm run build first.' })
  }
}

const server = http.createServer(async (request, response) => {
  if (request.method === 'OPTIONS') return send(response, 204, {})
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`)
  const route = url.pathname

  if (request.method === 'GET' && !route.startsWith('/api/')) return serveApp(response, route)

  if (route === '/api/health' && request.method === 'GET') return send(response, 200, { ok: true })

  try {
    if (route === '/api/agents' && request.method === 'GET') {
      return send(response, 200, Object.values(state.agents).map(publicAgent))
    }

    if (route === '/api/agents' && request.method === 'POST') {
      const body = await readBody(request)
      const username = normalizeUsername(body.username)
      if (!body.name || !username || !body.password) return send(response, 400, { error: 'name, username and password are required' })
      if (Object.values(state.agents).some(agent => normalizeUsername(agent.username) === username)) return send(response, 409, { error: 'That username is already in use' })
      const agentId = body.id || body.agentId || id('agent')
      const names = String(body.name).trim().split(/\s+/)
      const initials = names.map(name => name[0]).join('').slice(0, 2).toUpperCase()
      const agent = {
        id: agentId,
        name: String(body.name).trim(),
        username,
        passwordHash: hashPassword(body.password),
        status: body.status || 'Active',
        presence: 'Offline',
        initials,
        callsToday: 0,
        talkTime: '0s',
        connected: null,
        lastSeen: 'Never',
        bridgeConnected: false,
        color: body.color || 'mint',
        updatedAt: Date.now(),
      }
      state.agents[agentId] = agent
      persist()
      return send(response, 201, publicAgent(agent))
    }

    if (route === '/api/agents/login' && request.method === 'POST') {
      const body = await readBody(request)
      const username = normalizeUsername(body.username)
      const agent = Object.values(state.agents).find(item => normalizeUsername(item.username) === username)
      if (!agent) return send(response, 404, { error: 'No agent account matches that username' })
      if (agent.status !== 'Active') return send(response, 403, { error: 'This agent account is not active' })
      if (!agent.passwordHash) {
        // Accounts created by the first prototype did not store a password.
        // Treat the first successful login as a one-time password migration.
        if (!body.password) return send(response, 401, { error: 'A password is required' })
        agent.passwordHash = hashPassword(body.password)
        persist()
        return send(response, 200, publicAgent(agent))
      }
      if (!passwordMatches(body.password, agent.passwordHash)) return send(response, 401, { error: 'Incorrect username or password' })
      return send(response, 200, publicAgent(agent))
    }

    if (route === '/api/agents/sync' && request.method === 'POST') {
      const body = await readBody(request)
      if (!body.agentId || !body.username) return send(response, 400, { error: 'agentId and username are required' })
      const existing = state.agents[body.agentId] || {}
      state.agents[body.agentId] = {
        ...existing,
        id: body.agentId,
        username: normalizeUsername(body.username),
        name: body.name || existing.name || body.username,
        status: body.status || existing.status || 'Active',
        ...(body.password && !existing.passwordHash ? { passwordHash: hashPassword(body.password) } : {}),
        updatedAt: Date.now(),
      }
      persist()
      return send(response, 200, { ok: true, agent: publicAgent(state.agents[body.agentId]) })
    }

    if (route === '/api/pairing/start' && request.method === 'POST') {
      const body = await readBody(request)
      if (!state.agents[body.agentId]) return send(response, 404, { error: 'Agent account is not synced' })
      const code = String(Math.floor(100000 + Math.random() * 900000))
      state.pairings[code] = { agentId: body.agentId, expiresAt: Date.now() + 10 * 60_000 }
      persist()
      return send(response, 200, { code, expiresAt: state.pairings[code].expiresAt })
    }

    if (route === '/api/pairing/complete' && request.method === 'POST') {
      const body = await readBody(request)
      const pairing = state.pairings[String(body.code || '')]
      if (!pairing || pairing.expiresAt < Date.now()) return send(response, 400, { error: 'Pairing code is invalid or expired' })
      if (!body.deviceId) return send(response, 400, { error: 'deviceId is required' })
      const token = crypto.randomBytes(32).toString('hex')
      const device = { token, agentId: pairing.agentId, deviceId: body.deviceId, deviceName: body.deviceName || 'Android phone', lastSeen: Date.now() }
      state.devices[token] = device
      const agent = state.agents[pairing.agentId]
      if (agent.deviceToken && state.devices[agent.deviceToken]) delete state.devices[agent.deviceToken]
      agent.deviceToken = token
      delete state.pairings[String(body.code)]
      persist()
      return send(response, 200, { token, agentId: pairing.agentId, deviceName: device.deviceName })
    }

    const deviceMatch = route.match(/^\/api\/agents\/([^/]+)\/device$/)
    if (deviceMatch && request.method === 'GET') {
      const agent = state.agents[deviceMatch[1]]
      const device = deviceForAgent(agent)
      return send(response, 200, { connected: isConnected(device), deviceName: device?.deviceName || '', lastSeen: device?.lastSeen || null })
    }

    if (route === '/api/devices/heartbeat' && request.method === 'POST') {
      const body = await readBody(request)
      const device = state.devices[body.token]
      if (!device) return send(response, 401, { error: 'Unknown device token' })
      device.lastSeen = Date.now()
      persist()
      return send(response, 200, { ok: true })
    }

    if (route === '/api/devices/commands' && request.method === 'GET') {
      const token = url.searchParams.get('token')
      const device = state.devices[token]
      if (!device) return send(response, 401, { error: 'Unknown device token' })
      device.lastSeen = Date.now()
      const command = state.commands.find(item => {
        if (item.token !== token || item.deliveredAt) return false
        const status = state.calls[item.callId]?.status
        return item.type === 'PLACE_CALL' ? status === 'Queued' : item.type === 'END_CALL' && ['Calling', 'In progress', 'Ending'].includes(status)
      })
      if (command) command.deliveredAt = Date.now()
      persist()
      return send(response, 200, { command: command ? { id: command.id, type: command.type, callId: command.callId, number: command.number } : null })
    }

    if (route === '/api/calls/dispatch' && request.method === 'POST') {
      const body = await readBody(request)
      const agent = state.agents[body.agentId]
      const device = deviceForAgent(agent)
      if (!agent) return send(response, 404, { error: 'Agent account not found' })
      if (!isConnected(device)) return send(response, 409, { error: 'Android device is not connected' })
      const now = new Date()
      const call = { id: id('call'), callerId: body.agentId, number: body.number, status: 'Queued', seconds: 0, date: now.toISOString().slice(0, 10), time: now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }), createdAt: now.toISOString() }
      state.calls[call.id] = call
      state.commands.push({ id: id('command'), token: device.token, type: 'PLACE_CALL', callId: call.id, number: body.number, deliveredAt: null })
      persist()
      return send(response, 200, { callId: call.id })
    }

    const hangupMatch = route.match(/^\/api\/calls\/([^/]+)\/hangup$/)
    if (hangupMatch && request.method === 'POST') {
      const body = await readBody(request)
      const call = state.calls[hangupMatch[1]]
      if (!call) return send(response, 404, { error: 'Call not found' })
      const device = deviceForAgent(state.agents[call.callerId])
      if (!isConnected(device)) return send(response, 409, { error: 'Android device is not connected' })
      if (body.status === 'Failed') call.pendingStatus = 'Failed'
      if (call.status === 'Queued') {
        call.status = body.status === 'Failed' ? 'Failed' : 'Rejected'
      } else if (!['Answered', 'Missed', 'Rejected', 'Failed'].includes(call.status)) {
        call.status = 'Ending'
        const alreadyQueued = state.commands.some(item => item.callId === call.id && item.type === 'END_CALL' && !item.deliveredAt)
        if (!alreadyQueued) state.commands.push({ id: id('command'), token: device.token, type: 'END_CALL', callId: call.id, number: call.number, deliveredAt: null })
      }
      call.updatedAt = new Date().toISOString()
      persist()
      return send(response, 200, { ok: true, call })
    }

    const callStatusMatch = route.match(/^\/api\/calls\/([^/]+)\/status$/)
    if (callStatusMatch && request.method === 'POST') {
      const body = await readBody(request)
      const call = state.calls[callStatusMatch[1]]
      if (!call) return send(response, 404, { error: 'Call not found' })
      call.status = call.pendingStatus || body.status || call.status
      call.seconds = Number(body.seconds) || 0
      call.updatedAt = new Date().toISOString()
      if (['Answered', 'Missed', 'Rejected', 'Failed'].includes(call.status)) delete call.pendingStatus
      persist()
      return send(response, 200, { ok: true, call })
    }

    const callMatch = route.match(/^\/api\/calls\/([^/]+)$/)
    if (callMatch && request.method === 'GET') {
      const call = state.calls[callMatch[1]]
      return call ? send(response, 200, call) : send(response, 404, { error: 'Call not found' })
    }

    if (route === '/api/calls' && request.method === 'GET') {
      const agentId = url.searchParams.get('agentId')
      return send(response, 200, Object.values(state.calls).filter(call => !agentId || call.callerId === agentId))
    }

    return send(response, 404, { error: 'Not found' })
  } catch (error) {
    return send(response, 500, { error: error.message || 'Server error' })
  }
})

server.listen(port, '0.0.0.0', () => {
  console.log(`Telecall API listening on http://localhost:${port}`)
})
