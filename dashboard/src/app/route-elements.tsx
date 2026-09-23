import { Suspense, useEffect } from 'react'
import { Navigate } from 'react-router-dom'
import type { LazyPage } from '@/app/lazy-page'
import { pages } from '@/app/pages'
import { prefetchCommonPagesWhenIdle } from '@/app/prefetch'
import { PageSpinner } from '@/components/ui/spinner'
import { useAuthStore } from '@/stores/auth-store'

type PageRouteProps = {
  page: LazyPage
  /** Sign-in and setup have no shell around them: centre the spinner in the viewport. */
  fullScreen?: boolean
}

/**
 * A page's route element: the page's chunk behind its own Suspense boundary.
 * The router gives each route a distinct `key`, so a navigation mounts a new
 * boundary and shows the spinner in the content area. With one shared boundary
 * React would keep the previous page on screen for the whole download, because
 * router navigations are transitions.
 */
export function PageRoute({ page, fullScreen = false }: PageRouteProps) {
  return (
    <Suspense fallback={<PageSpinner fullScreen={fullScreen} />}>
      <page.Component />
      <PageRendered />
    </Suspense>
  )
}

/** Inside the page's boundary: its effect runs once the page itself is on screen. */
function PageRendered() {
  useEffect(() => {
    prefetchCommonPagesWhenIdle()
  }, [])
  return null
}

/** Sign-in, unless there is a session already. */
export function LoginRoute() {
  const token = useAuthStore((state) => state.token)
  if (token) return <Navigate to="/" replace />
  return <PageRoute page={pages.login} fullScreen />
}
