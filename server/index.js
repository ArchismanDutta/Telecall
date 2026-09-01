import './env.js' // must come first: db.js reads DATABASE_URL when it is imported
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'
import { query, one, newId, migrate, driver } from './db.js'
import {
  hashPassword, passwordMatches, sessionUser, createSession, destroySession,
  sessionCookie, clearedCookie, readCookie, seedAdmin, SESSION_COOKIE,
} from './auth.js'

const root = path.dirname(fileURLToPath(import.meta.url))
const distDirectory = path.join(root, '..', 'dist')
const port = Number(process.env.PORT || 8787)
const ACTIVE = ['Queued', 'Calling', 'In progress', 'Ending']
const TERMINAL = ['Answered', 'Missed', 'Rejected', 'Failed']
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean)

/* ---------- http helpers ---------- */

const send = (response, status, payload, headers = {}) => {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers })
  response.end(JSON.stringify(payload))
  return true // callers rely on this being truthy to short-circuit their handler
}

const corsHeaders = request => {
  const origin = request.headers.origin
  if (!origin || !allowedOrigins.includes(origin)) return {}
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    Vary: 'Origin',
  }
}

const readBody = request => new Promise((resolve, reject) => {
  let value = ''
  request.on('data', chunk => {
    value += chunk
    if (value.length > 100_000) reject(new Error('Request body is too large'))
  })
  request.on('end', () => {
    try { resolve(value ? JSON.parse(value) : {}) } catch { reject(new Error('Invalid JSON')) }
  })
  request.on('error', reject)
})

const contentTypes = {
  '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json',
}

const serveApp = (response, pathname) => {
  let requestedPath
  try { requestedPath = decodeURIComponent(pathname) } catch { return send(response, 400, { error: 'Invalid path' }) }
  const relativePath = path.normalize(requestedPath === '/' ? '/index.html' : requestedPath).replace(/^[/\\]+/, '')
  const candidate = path.join(distDirectory, relativePath)
  const safeCandidate = candidate.startsWith(distDirectory + path.sep) ? candidate : path.join(distDirectory, 'index.html')
  const filePath = path.extname(safeCandidate) ? safeCandidate : path.join(distDirectory, 'index.html')
  try {
    const data = fs.readFileSync(filePath)
    response.writeHead(200, {
      'Content-Type': contentTypes[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': path.basename(filePath) === 'index.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
    })
    response.end(data)
  } catch {
    send(response, 404, { error: 'App asset not found. Run npm run build first.' })
  }
}

/* ---------- shaping ---------- */

const initialsOf = name => String(name).trim().split(/\s+/).map(part => part[0]).join('').slice(0, 2).toUpperCase()
const COLORS = ['mint', 'blue', 'peach', 'lavender']
const colorFor = id => COLORS[[...String(id)].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % COLORS.length]

const relativeSeen = value => {
  if (!value) return 'Never'
  const seconds = Math.floor((Date.now() - new Date(value).getTime()) / 1000)
  if (seconds < 60) return 'Just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86400)}d ago`
}

const publicUser = row => row && ({
  id: row.id,
  name: row.name,
  username: row.username,
  role: row.role,
  status: row.status,
  createdAt: row.created_at,
  initials: initialsOf(row.name),
  color: colorFor(row.id),
  bridgeConnected: Boolean(row.bridge_connected),
  deviceName: row.device_name || '',
  platform: row.platform || '',
  lastSeen: relativeSeen(row.last_seen),
  presence: row.bridge_connected ? (row.on_call ? 'In a call' : 'Online') : 'Offline',
  callsToday: Number(row.calls_today || 0),
  talkTodaySeconds: Number(row.talk_today || 0),
})

const publicCall = row => row && ({
  id: row.id,
  callerId: row.user_id,
  number: row.phone_number,
  status: row.status,
  seconds: Number(row.duration || 0),
  estimated: Boolean(row.duration_estimated),
  startedAt: row.started_at,
  offhookAt: row.offhook_at,
  answeredAt: row.answered_at,
  endedAt: row.ended_at,
  createdAt: row.created_at,
})

const TELECALLER_COLUMNS = `
  SELECT u.id, u.name, u.username, u.role, u.status, u.created_at,
         d.device_name, d.platform, d.last_seen,
         (d.last_seen > now() - interval '30 seconds') AS bridge_connected,
         COALESCE(t.calls_today, 0) AS calls_today,
         COALESCE(t.talk_today, 0)  AS talk_today,
         EXISTS (SELECT 1 FROM calls c WHERE c.user_id = u.id AND c.status = ANY($1)) AS on_call
    FROM users u
    LEFT JOIN devices d ON d.user_id = u.id
    LEFT JOIN LATERAL (
      SELECT count(*) AS calls_today, COALESCE(sum(duration), 0) AS talk_today
        FROM calls c
       WHERE c.user_id = u.id AND c.created_at >= date_trunc('day', now())
    ) t ON true`

const listTelecallers = () =>
  query(`${TELECALLER_COLUMNS} WHERE u.role = 'telecaller' ORDER BY u.created_at`, [ACTIVE])

const getTelecaller = userId =>
  one(`${TELECALLER_COLUMNS} WHERE u.id = $2`, [ACTIVE, userId])

/* ---------- call-state reconciliation ---------- */

// The phone reports the radio's own call state on every poll. The bridge also posts explicit
// transitions, but those can be missed -- a killed process, a dropped request, a callback the
// OS never delivered. This is the safety net that stops a call being stuck on "Calling"
// forever. The bridge's own report always wins: anything updated in the last few seconds is
// left alone so a precise call-log duration is never overwritten by an estimate.
const reconcileCallState = async (device, callState) => {
  if (!['IDLE', 'OFFHOOK', 'RINGING'].includes(callState || '')) return
  const call = await one(
    `SELECT * FROM calls WHERE user_id = $1 AND status = ANY($2) ORDER BY created_at DESC LIMIT 1`,
    [device.user_id, ACTIVE],
  )
  if (!call) return

  if (callState === 'OFFHOOK') {
    if (['Queued', 'Calling'].includes(call.status)) {
      // Off-hook means the radio is busy -- for an outgoing call that is the moment dialling
      // starts, not the moment anyone picks up. Android gives ordinary apps no answer signal,
      // so answered_at stays null until the call log supplies it once the call ends.
      await query(
        `UPDATE calls SET status = 'In progress', offhook_at = COALESCE(offhook_at, now()), updated_at = now() WHERE id = $1`,
        [call.id],
      )
    }
    return
  }

  if (callState !== 'IDLE') return
  const settled = Date.now() - new Date(call.updated_at).getTime() > 6000
  if (!settled) return

  if (call.offhook_at) {
    // The phone never reported the outcome -- it crashed, lost the network, or has no
    // call-log permission. All we can say is how long the line was busy, which includes
    // the ringing, so it is flagged as an estimate rather than passed off as talk time.
    await query(
      `UPDATE calls SET status = 'Answered', ended_at = now(), updated_at = now(),
              duration = GREATEST(0, EXTRACT(EPOCH FROM (now() - offhook_at))::int),
              duration_estimated = true
        WHERE id = $1`,
      [call.id],
    )
  } else if (Date.now() - new Date(call.started_at).getTime() > 25_000) {
    // The phone never went off-hook: the dialler was cancelled, or the call never placed.
    await query(`UPDATE calls SET status = 'Failed', ended_at = now(), updated_at = now() WHERE id = $1`, [call.id])
  }
}

/* ---------- routing ---------- */

const server = http.createServer(async (request, response) => {
  const cors = corsHeaders(request)
  if (request.method === 'OPTIONS') return send(response, 204, {}, cors)

  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`)
  const route = url.pathname
  const method = request.method
  const reply = (status, payload, headers = {}) => send(response, status, payload, { ...cors, ...headers })

  if (method === 'GET' && !route.startsWith('/api/')) return serveApp(response, route)
  if (route === '/api/health') return reply(200, { ok: true, driver })

  try {
    const body = ['POST', 'PATCH', 'DELETE'].includes(method) ? await readBody(request) : {}
    const match = pattern => route.match(pattern)

    /* ----- authentication ----- */

    if (route === '/api/auth/login' && method === 'POST') {
      const username = String(body.username || '').trim().toLowerCase()
      const user = await one('SELECT * FROM users WHERE lower(username) = $1', [username])
      if (!user || !passwordMatches(body.password, user.password_hash)) {
        return reply(401, { error: 'Incorrect username or password' })
      }
      if (user.status !== 'Active') return reply(403, { error: 'This account is not active. Contact the administrator.' })
      const token = await createSession(user.id)
      const shaped = user.role === 'telecaller' ? publicUser(await getTelecaller(user.id)) : publicUser(user)
      return reply(200, shaped, { 'Set-Cookie': sessionCookie(token) })
    }

    if (route === '/api/auth/logout' && method === 'POST') {
      const token = readCookie(request, SESSION_COOKIE)
      if (token) await destroySession(token)
      return reply(200, { ok: true }, { 'Set-Cookie': clearedCookie() })
    }

    /* ----- device endpoints: authenticated by pairing code or device token ----- */

    if (route === '/api/pairing/complete' && method === 'POST') {
      const pairing = await one('SELECT * FROM pairings WHERE code = $1 AND expires_at > now()', [String(body.code || '')])
      if (!pairing) return reply(400, { error: 'Pairing code is invalid or expired' })
      if (!body.deviceId) return reply(400, { error: 'deviceId is required' })
      const token = crypto.randomBytes(32).toString('hex')
      await query('DELETE FROM devices WHERE user_id = $1', [pairing.user_id])
      await query(
        `INSERT INTO devices (id, user_id, device_id, device_name, platform, token, status, last_seen)
         VALUES ($1, $2, $3, $4, $5, $6, 'Online', now())`,
        [newId(), pairing.user_id, String(body.deviceId), body.deviceName || 'Android phone', body.platform || 'android', token],
      )
      await query('DELETE FROM pairings WHERE code = $1', [String(body.code)])
      return reply(200, { token, deviceName: body.deviceName || 'Android phone' })
    }

    const deviceFor = async token => token ? one('SELECT * FROM devices WHERE token = $1', [String(token)]) : null

    if (route === '/api/devices/heartbeat' && method === 'POST') {
      const device = await deviceFor(body.token)
      if (!device) return reply(401, { error: 'Unknown device token' })
      await query("UPDATE devices SET last_seen = now(), status = 'Online' WHERE id = $1", [device.id])
      return reply(200, { ok: true })
    }

    if (route === '/api/devices/commands' && method === 'GET') {
      const device = await deviceFor(url.searchParams.get('token'))
      if (!device) return reply(401, { error: 'Unknown device token' })
      await query("UPDATE devices SET last_seen = now(), status = 'Online' WHERE id = $1", [device.id])
      await reconcileCallState(device, url.searchParams.get('callState'))
      const command = await one(
        `SELECT cmd.* FROM commands cmd JOIN calls c ON c.id = cmd.call_id
          WHERE cmd.device_token = $1 AND cmd.delivered_at IS NULL
            AND ((cmd.type = 'PLACE_CALL' AND c.status = 'Queued')
              OR (cmd.type = 'END_CALL'   AND c.status = ANY($2)))
          ORDER BY cmd.created_at LIMIT 1`,
        [device.token, ['Calling', 'In progress', 'Ending']],
      )
      if (command) await query('UPDATE commands SET delivered_at = now() WHERE id = $1', [command.id])
      return reply(200, {
        command: command ? { id: command.id, type: command.type, callId: command.call_id, number: command.number } : null,
      })
    }

    const statusMatch = match(/^\/api\/calls\/([^/]+)\/status$/)
    if (statusMatch && method === 'POST') {
      const device = await deviceFor(body.token)
      if (!device) return reply(401, { error: 'Unknown device token' })
      const call = await one('SELECT * FROM calls WHERE id = $1 AND user_id = $2', [statusMatch[1], device.user_id])
      if (!call) return reply(404, { error: 'Call not found for this device' })
      const status = String(body.status || '')
      if (![...ACTIVE, ...TERMINAL].includes(status)) return reply(400, { error: 'Unrecognised call status' })
      const seconds = Math.max(0, Number(body.seconds) || 0)
      const at = value => {
        const ms = Number(value)
        return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null
      }
      if (status === 'In progress') {
        await query(
          `UPDATE calls SET status = $2, offhook_at = COALESCE($3::timestamptz, offhook_at, now()), updated_at = now() WHERE id = $1`,
          [call.id, status, at(body.offhookAtMs)],
        )
      } else if (TERMINAL.includes(status)) {
        // The phone reads the connected duration out of the call log, so `seconds` here is
        // real talk time and answeredAtMs is the moment the other end actually picked up.
        await query(
          `UPDATE calls SET status = $2, duration = $3, duration_estimated = $4,
                  offhook_at  = COALESCE($5::timestamptz, offhook_at),
                  answered_at = COALESCE($6::timestamptz, answered_at),
                  ended_at    = COALESCE($7::timestamptz, now()),
                  updated_at  = now()
            WHERE id = $1`,
          [call.id, status, seconds, Boolean(body.estimated),
           at(body.offhookAtMs), at(body.answeredAtMs), at(body.endedAtMs)],
        )
      } else {
        await query('UPDATE calls SET status = $2, updated_at = now() WHERE id = $1', [call.id, status])
      }
      return reply(200, publicCall(await one('SELECT * FROM calls WHERE id = $1', [call.id])))
    }

    /* ----- everything below requires a signed-in user ----- */

    const user = await sessionUser(request)
    if (route === '/api/auth/me' && method === 'GET') {
      if (!user) return reply(401, { error: 'Not signed in' })
      const shaped = user.role === 'telecaller' ? publicUser(await getTelecaller(user.id)) : publicUser(user)
      return reply(200, shaped)
    }
    if (!user) return reply(401, { error: 'Sign in to continue' })
    const isAdmin = user.role === 'admin'
    const denyUnlessAdmin = () => isAdmin ? null : reply(403, { error: 'Administrator access is required' })

    /* ----- telecaller accounts (admin only) ----- */

    if (route === '/api/telecallers' && method === 'GET') {
      if (denyUnlessAdmin()) return
      return reply(200, (await listTelecallers()).map(publicUser))
    }

    if (route === '/api/telecallers' && method === 'POST') {
      if (denyUnlessAdmin()) return
      const username = String(body.username || '').trim().toLowerCase()
      const name = String(body.name || '').trim()
      if (!name || !username || !body.password) return reply(400, { error: 'Name, username and password are all required' })
      if (String(body.password).length < 6) return reply(400, { error: 'Password must be at least 6 characters' })
      if (await one('SELECT id FROM users WHERE lower(username) = $1', [username])) {
        return reply(409, { error: 'That username is already in use' })
      }
      const id = newId()
      await query(
        `INSERT INTO users (id, name, username, password_hash, role, status)
         VALUES ($1, $2, $3, $4, 'telecaller', $5)`,
        [id, name, username, hashPassword(body.password), body.status === 'Paused' ? 'Paused' : 'Active'],
      )
      return reply(201, publicUser(await getTelecaller(id)))
    }

    const telecallerMatch = match(/^\/api\/telecallers\/([^/]+)$/)
    if (telecallerMatch && (method === 'PATCH' || method === 'DELETE')) {
      if (denyUnlessAdmin()) return
      const target = await one("SELECT * FROM users WHERE id = $1 AND role = 'telecaller'", [telecallerMatch[1]])
      if (!target) return reply(404, { error: 'Telecaller not found' })
      if (method === 'DELETE') {
        await query('DELETE FROM users WHERE id = $1', [target.id])
        return reply(200, { ok: true })
      }
      const name = body.name === undefined ? target.name : String(body.name).trim()
      const username = body.username === undefined ? target.username : String(body.username).trim().toLowerCase()
      const status = body.status === undefined ? target.status : (body.status === 'Paused' ? 'Paused' : 'Active')
      if (!name || !username) return reply(400, { error: 'Name and username cannot be empty' })
      const clash = await one('SELECT id FROM users WHERE lower(username) = $1 AND id <> $2', [username, target.id])
      if (clash) return reply(409, { error: 'That username is already in use' })
      await query('UPDATE users SET name = $2, username = $3, status = $4 WHERE id = $1', [target.id, name, username, status])
      if (status !== 'Active') await query('DELETE FROM sessions WHERE user_id = $1', [target.id])
      return reply(200, publicUser(await getTelecaller(target.id)))
    }

    const passwordMatch = match(/^\/api\/telecallers\/([^/]+)\/password$/)
    if (passwordMatch && method === 'POST') {
      if (denyUnlessAdmin()) return
      if (!body.password || String(body.password).length < 6) return reply(400, { error: 'Password must be at least 6 characters' })
      const target = await one("SELECT id FROM users WHERE id = $1 AND role = 'telecaller'", [passwordMatch[1]])
      if (!target) return reply(404, { error: 'Telecaller not found' })
      await query('UPDATE users SET password_hash = $2 WHERE id = $1', [target.id, hashPassword(body.password)])
      await query('DELETE FROM sessions WHERE user_id = $1', [target.id])
      return reply(200, { ok: true })
    }

    const pairingMatch = match(/^\/api\/telecallers\/([^/]+)\/pairing$/)
    if (pairingMatch && method === 'POST') {
      if (denyUnlessAdmin()) return
      const target = await one("SELECT id FROM users WHERE id = $1 AND role = 'telecaller'", [pairingMatch[1]])
      if (!target) return reply(404, { error: 'Telecaller not found' })
      const code = String(crypto.randomInt(100000, 1000000))
      await query('DELETE FROM pairings WHERE user_id = $1 OR expires_at < now()', [target.id])
      await query("INSERT INTO pairings (code, user_id, expires_at) VALUES ($1, $2, now() + interval '10 minutes')", [code, target.id])
      return reply(200, { code, expiresAt: Date.now() + 10 * 60_000 })
    }

    const deviceMatch = match(/^\/api\/telecallers\/([^/]+)\/device$/)
    if (deviceMatch && (method === 'GET' || method === 'DELETE')) {
      if (!isAdmin && user.id !== deviceMatch[1]) return reply(403, { error: 'You can only view your own device' })
      if (method === 'DELETE') {
        if (denyUnlessAdmin()) return
        await query('DELETE FROM devices WHERE user_id = $1', [deviceMatch[1]])
        return reply(200, { ok: true })
      }
      const device = await one('SELECT * FROM devices WHERE user_id = $1', [deviceMatch[1]])
      const connected = Boolean(device && Date.now() - new Date(device.last_seen).getTime() < 30_000)
      return reply(200, {
        connected,
        deviceName: device?.device_name || '',
        platform: device?.platform || '',
        lastSeen: relativeSeen(device?.last_seen),
      })
    }

    /* ----- calls ----- */

    if (route === '/api/calls' && method === 'GET') {
      const requested = url.searchParams.get('userId')
      const scopeId = isAdmin ? requested : user.id
      const from = url.searchParams.get('from')
      const to = url.searchParams.get('to')
      const clauses = []
      const params = []
      if (scopeId) { params.push(scopeId); clauses.push(`user_id = $${params.length}`) }
      if (from) { params.push(from); clauses.push(`created_at >= $${params.length}::date`) }
      if (to) { params.push(to); clauses.push(`created_at < ($${params.length}::date + interval '1 day')`) }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
      const rows = await query(`SELECT * FROM calls ${where} ORDER BY created_at DESC LIMIT 2000`, params)
      return reply(200, rows.map(publicCall))
    }

    if (route === '/api/calls/dispatch' && method === 'POST') {
      if (isAdmin) return reply(403, { error: 'Administrators do not place calls' })
      const digits = String(body.number || '').replace(/[^0-9+]/g, '')
      if (digits.replace(/\D/g, '').length < 7) return reply(400, { error: 'Enter a valid phone number' })
      const device = await one('SELECT * FROM devices WHERE user_id = $1', [user.id])
      if (!device || Date.now() - new Date(device.last_seen).getTime() > 30_000) {
        return reply(409, { error: 'Your Android phone is not connected. Ask the administrator to pair it.' })
      }
      const inFlight = await one('SELECT id FROM calls WHERE user_id = $1 AND status = ANY($2)', [user.id, ACTIVE])
      if (inFlight) return reply(409, { error: 'Finish the call in progress before starting another' })
      const callId = newId()
      await query(
        `INSERT INTO calls (id, user_id, phone_number, status, started_at) VALUES ($1, $2, $3, 'Queued', now())`,
        [callId, user.id, digits],
      )
      await query(
        `INSERT INTO commands (id, device_token, type, call_id, number) VALUES ($1, $2, 'PLACE_CALL', $3, $4)`,
        [newId(), device.token, callId, digits],
      )
      return reply(200, { callId })
    }

    const callMatch = match(/^\/api\/calls\/([^/]+)$/)
    if (callMatch && method === 'GET') {
      const call = await one('SELECT * FROM calls WHERE id = $1', [callMatch[1]])
      if (!call) return reply(404, { error: 'Call not found' })
      if (!isAdmin && call.user_id !== user.id) return reply(403, { error: 'That call belongs to another telecaller' })
      return reply(200, publicCall(call))
    }

    const hangupMatch = match(/^\/api\/calls\/([^/]+)\/hangup$/)
    if (hangupMatch && method === 'POST') {
      const call = await one('SELECT * FROM calls WHERE id = $1', [hangupMatch[1]])
      if (!call) return reply(404, { error: 'Call not found' })
      if (!isAdmin && call.user_id !== user.id) return reply(403, { error: 'That call belongs to another telecaller' })
      if (TERMINAL.includes(call.status)) return reply(200, publicCall(call))
      if (call.status === 'Queued') {
        // The phone never picked the command up, so nothing needs to be hung up.
        await query('UPDATE calls SET status = $2, ended_at = now(), updated_at = now() WHERE id = $1', [call.id, 'Failed'])
        return reply(200, publicCall(await one('SELECT * FROM calls WHERE id = $1', [call.id])))
      }
      const device = await one('SELECT * FROM devices WHERE user_id = $1', [call.user_id])
      if (!device) return reply(409, { error: 'The Android phone is no longer paired' })
      await query("UPDATE calls SET status = 'Ending', updated_at = now() WHERE id = $1", [call.id])
      const queued = await one("SELECT id FROM commands WHERE call_id = $1 AND type = 'END_CALL' AND delivered_at IS NULL", [call.id])
      if (!queued) {
        await query(
          `INSERT INTO commands (id, device_token, type, call_id, number) VALUES ($1, $2, 'END_CALL', $3, $4)`,
          [newId(), device.token, call.id, call.phone_number],
        )
      }
      return reply(200, publicCall(await one('SELECT * FROM calls WHERE id = $1', [call.id])))
    }

    return reply(404, { error: 'Not found' })
  } catch (error) {
    console.error(`${method} ${route} failed:`, error.message)
    return send(response, 500, { error: 'Something went wrong on the server' }, cors)
  }
})

await migrate()
const seeded = await seedAdmin()

server.listen(port, '0.0.0.0', () => {
  console.log(`Telecall API listening on http://localhost:${port} (storage: ${driver})`)
  if (seeded?.generated) {
    console.log(`\n  Admin account created\n    username: ${seeded.username}\n    password: ${seeded.password}\n`)
    console.log('  Save this password now — it is not shown again. Set ADMIN_PASSWORD to choose your own.\n')
  } else if (seeded) {
    console.log(`\n  Admin account created with username "${seeded.username}" and your ADMIN_PASSWORD.\n`)
  }
})
