import path from 'path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/** Matches modules of the named packages (a trailing `/*` matches a whole npm scope). */
function packages(...names: string[]) {
  const alternatives = names.map((name) =>
    name.endsWith('/*') ? `${name.slice(0, -2)}[\\\\/][^\\\\/]+` : name.replace(/[.]/g, '\\.'),
  )
  return new RegExp(`[\\\\/]node_modules[\\\\/](?:${alternatives.join('|')})[\\\\/]`)
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // The API serves the built dashboard from its public/ directory.
  build: {
    outDir: '../public',
    emptyOutDir: true,
    rolldownOptions: {
      output: {
        // Every page is its own chunk (src/app/pages.ts). Vendor code that changes
        // only with dependency upgrades gets chunks of its own, so their hashes, and
        // the browser's cached copies, survive app deploys.
        //
        // A group also takes the dependencies of what it matches, unless a group
        // with a higher priority owns them. So every package Recharts shares with
        // the shell (clsx) or with the infrastructure page's @xyflow/react
        // (use-sync-external-store, d3-interpolate, d3-color) has an owner above
        // `recharts`; otherwise the entry or the map would import the Recharts
        // chunk just for them. @xyflow/react and dagre have no group: only the
        // infrastructure page imports them, so they stay in its chunk.
        codeSplitting: {
          groups: [
            {
              name: 'react',
              test: packages(
                'react',
                'react-dom',
                'scheduler',
                'use-sync-external-store',
                'react-router',
                'react-router-dom',
                'cookie',
                'set-cookie-parser',
              ),
              priority: 50,
            },
            {
              name: 'query',
              test: packages('@tanstack/*'),
              priority: 40,
            },
            {
              name: 'radix',
              test: packages(
                'radix-ui',
                '@radix-ui/*',
                '@floating-ui/*',
                'react-remove-scroll',
                'react-remove-scroll-bar',
                'react-style-singleton',
                'use-callback-ref',
                'use-sidecar',
                'aria-hidden',
                'get-nonce',
                'tslib',
                'detect-node-es',
              ),
              priority: 30,
            },
            {
              // Class-name helpers behind cn() and the component variants.
              name: 'ui-utils',
              test: packages('clsx', 'class-variance-authority', 'tailwind-merge'),
              priority: 25,
            },
            {
              // The d3 modules Recharts and @xyflow/react both use.
              name: 'd3-shared',
              test: packages('d3-interpolate', 'd3-color'),
              priority: 20,
            },
            {
              // Only pages that draw charts import it.
              name: 'recharts',
              test: packages(
                'recharts',
                'victory-vendor',
                'd3-array',
                'd3-format',
                'd3-path',
                'd3-scale',
                'd3-shape',
                'd3-time',
                'd3-time-format',
                'internmap',
                '@reduxjs/toolkit',
                'redux',
                'redux-thunk',
                'reselect',
                'immer',
                'react-redux',
                'react-is',
                'es-toolkit',
                'decimal.js-light',
                'eventemitter3',
                'tiny-invariant',
                '@standard-schema/*',
              ),
              priority: 10,
            },
          ],
        },
      },
    },
  },
  // `npm run dev` proxies API calls to a locally running metrics-be so the
  // dashboard can stay same-origin (VITE_API_URL empty) in development too.
  server: {
    proxy: {
      '/api': process.env.VITE_DEV_API_PROXY ?? 'http://localhost:3333',
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
