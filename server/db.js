import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const schemaPath = path.join(root, 'schema.sql')
const connectionString = process.env.DATABASE_URL || ''

let runQuery
let runExec

if (connectionString) {
  // Production: a real Postgres server (Render, Neon, anything with a DATABASE_URL).
  const pg = (await import('pg')).default
  const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(connectionString)
  const pool = new pg.Pool({
    connectionString,
    ssl: isLocal ? undefined : { rejectUnauthorized: false },
    max: 8,
    idleTimeoutMillis: 30_000,
  })
  pool.on('error', error => console.error('Postgres pool error:', error.message))
  runQuery = async (text, params = []) => (await pool.query(text, params)).rows
  runExec = async text => { await pool.query(text) }
} else {
  // Local development: Postgres compiled to WebAssembly, same SQL, no server to install.
  const { PGlite } = await import('@electric-sql/pglite')
  const dataDir = process.env.PGLITE_DIR || path.join(root, '..', '.data', 'pglite')
  fs.mkdirSync(path.dirname(dataDir), { recursive: true })
  let db
  try {
    db = await PGlite.create(dataDir)
  } catch {
    // The embedded database is not crash-safe: killing the process mid-write can leave the
    // on-disk copy unreadable. Recover rather than refusing to boot. Development only --
    // production runs against DATABASE_URL, where none of this path is reached.
    db = await recoverPglite(PGlite, dataDir)
  }

  runQuery = async (text, params = []) => (await db.query(text, params)).rows
  runExec = async text => { await db.exec(text) }
}

async function recoverPglite(PGlite, dataDir) {
  const aside = `${dataDir}-unreadable-${Date.now()}`
  for (const [label, reset] of [
    ['reset', () => fs.rmSync(dataDir, { recursive: true, force: true })],
    ['moved aside', () => fs.renameSync(dataDir, aside)],
  ]) {
    try {
      reset()
      console.warn(`Local development database was unreadable and has been ${label}.`)
      return await PGlite.create(dataDir)
    } catch { /* try the next strategy */ }
  }
  console.warn('Local development database is unreadable and could not be replaced. Running in memory; data will not persist.')
  return PGlite.create()
}

export const driver = connectionString ? 'postgres' : 'pglite'
export const query = runQuery
export const one = async (text, params) => (await runQuery(text, params))[0] || null
export const newId = () => crypto.randomUUID()
export const migrate = () => runExec(fs.readFileSync(schemaPath, 'utf8'))
