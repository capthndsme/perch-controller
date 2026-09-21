import { defineConfig } from '@adonisjs/static'

/**
 * Serves the built dashboard (public/, produced by `npm run build:dashboard`)
 * ahead of the router. Vite hashes everything under assets/, so those files
 * can be cached forever; index.html and the other top-level files must be
 * revalidated so a new release shows up on the next load.
 */
const staticServerConfig = defineConfig({
  enabled: true,
  etag: true,
  lastModified: true,
  dotFiles: 'ignore',
  headers: (path) => ({
    'Cache-Control': path.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
  }),
})

export default staticServerConfig
