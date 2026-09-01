import crypto from 'node:crypto'
import { query, one, newId } from './db.js'

export const SESSION_COOKIE = 'tc_session'
const SESSION_TTL_MS = 12 * 60 * 60 * 1000
const secureCookies = process.env.NODE_ENV === 'production'

export const hashPassword = (password, salt = crypto.randomBytes(16).toString('hex')) =>
  `${salt}:${crypto.scryptSync(String(password), salt, 64).toString('hex')}`

export const passwordMatches = (password, stored) => {
  const [salt, expectedHex] = String(stored || '').split(':')
  if (!salt || !expectedHex) return false
  const actual = crypto.scryptSync(String(password), salt, 64)
  const expected = Buffer.from(expectedHex, 'hex')
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected)
}

export const readCookie = (request, name) => {
  const header = request.headers.cookie || ''
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return decodeURIComponent(rest.join('='))
  }
  return ''
}

export const sessionCookie = token =>
  `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}` +
  (secureCookies ? '; Secure' : '')

export const clearedCookie = () =>
  `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` + (secureCookies ? '; Secure' : '')

export const createSession = async userId => {
  const token = crypto.randomBytes(32).toString('hex')
  await query('INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval \'12 hours\')', [token, userId])
  await query('DELETE FROM sessions WHERE expires_at < now()')
  return token
}

export const destroySession = token => query('DELETE FROM sessions WHERE id = $1', [token])

export const sessionUser = async request => {
  const token = readCookie(request, SESSION_COOKIE)
  if (!token) return null
  return one(
    `SELECT u.id, u.name, u.username, u.role, u.status
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = $1 AND s.expires_at > now() AND u.status = 'Active'`,
    [token],
  )
}

export const seedAdmin = async () => {
  const username = (process.env.ADMIN_USERNAME || 'admin').trim().toLowerCase()
  const existing = await one("SELECT id FROM users WHERE role = 'admin' LIMIT 1")
  if (existing) return null
  const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url')
  await query(
    `INSERT INTO users (id, name, username, password_hash, role, status)
     VALUES ($1, $2, $3, $4, 'admin', 'Active')`,
    [newId(), process.env.ADMIN_NAME || 'Administrator', username, hashPassword(password)],
  )
  return { username, password, generated: !process.env.ADMIN_PASSWORD }
}
