import app from '@adonisjs/core/services/app'
import { defineConfig } from '@adonisjs/cors'
import env from '#start/env'

/**
 * Resolve the production CORS allowlist from `CORS_ORIGIN`. The env var
 * is comma-separated (matches the format documented in `.env.example`)
 * and entries are trimmed; an empty string is treated as "no allowlist
 * configured" and falls back to an empty array — which makes
 * cross-origin browser access fail closed.
 */
function productionAllowlist(): string[] {
  const raw = env.get('CORS_ORIGIN')
  if (!raw) return []
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/**
 * Configuration options to tweak the CORS policy. The following
 * options are documented on the official documentation website.
 *
 * https://docs.adonisjs.com/guides/security/cors
 *
 * Development behaviour: allow every origin so the Vite dev server
 * (typically http://localhost:5173) can talk to this API without
 * per-laptop allowlist tweaks. Production: hard-allowlist via
 * `CORS_ORIGIN` env var.
 */
const corsConfig = defineConfig({
  enabled: true,
  origin: app.inDev ? true : productionAllowlist(),
  methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
  headers: true,
  exposeHeaders: [],
  credentials: true,
  maxAge: 90,
})

export default corsConfig
