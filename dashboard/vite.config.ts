import path from 'path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // The API serves the built dashboard from its public/ directory.
  build: {
    outDir: '../public',
    emptyOutDir: true,
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
