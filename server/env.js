// Loads the same secrets the browser app uses (.env.local at the project
// root, VITE_-prefixed) so the server doesn't need a second, duplicate set
// of credentials. Falls back to an unprefixed name for production hosts
// (Railway/Render) where you'd rather not prefix server secrets with VITE_.
import { config } from 'dotenv'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.join(here, '..', '.env.local') })
config({ path: path.join(here, '..', '.env') })
config({ path: path.join(here, '.env') })

export function getEnv(name, fallback = null) {
  return process.env[`VITE_${name}`] ?? process.env[name] ?? fallback
}
