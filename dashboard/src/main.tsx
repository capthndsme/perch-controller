import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { installLinkPrefetch, preloadInitialPage } from '@/app/prefetch'
import { AppProviders } from '@/app/providers'
import { router } from '@/app/router'
import { installChunkErrorTracking } from '@/lib/chunk-reload'
import { installServiceWorker } from '@/lib/push'
import { queryClient } from '@/lib/query-client'
import './index.css'

// This module is the entry chunk, so its URL names the running build.
installChunkErrorTracking(import.meta.url)
installLinkPrefetch(router.routes)
preloadInitialPage(router.routes)
// Push notifications and a tapped one opening its alert (secure contexts only; no caching).
installServiceWorker(router, queryClient)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppProviders />
  </StrictMode>,
)
