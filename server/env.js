// Loads .env from the project root before anything reads process.env.
//
// Imported first by index.js so that db.js sees DATABASE_URL at module-evaluation time.
// No dependency: the format here is deliberately plain -- KEY=value, one per line, # for
// comments, optional surrounding quotes. A real environment variable always wins over the
// file, so a .env left on a server can never override what the platform sets.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const file = process.env.ENV_FILE || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env')

let text = ''
try {
  text = fs.readFileSync(file, 'utf8')
} catch {
  // No .env is the normal case in production.
}

for (const line of text.split('\n')) {
  const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
  if (!match) continue
  const [, key] = match
  let value = match[2].trim()
  const quoted = (value.startsWith('"') && value.endsWith('"') && value.length > 1)
    || (value.startsWith("'") && value.endsWith("'") && value.length > 1)
  if (quoted) value = value.slice(1, -1)
  else value = value.replace(/\s+#.*$/, '').trim()
  if (process.env[key] === undefined) process.env[key] = value
}
