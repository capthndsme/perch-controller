import { lazy, useState, type ComponentType } from 'react'

export type LazyPage = {
  /** The page. Render it inside a Suspense boundary: it suspends while its chunk loads. */
  Component: ComponentType
  /** Starts the chunk download, or joins the one in flight. Safe to call any number of times. */
  preload: () => Promise<unknown>
}

/**
 * A route's page as its own chunk. `preload` (hover, idle and startup
 * prefetch) and the page share one import. A page whose chunk has already
 * arrived renders straight away: React.lazy would suspend on its first render
 * even for a resolved import and flash the fallback for a frame. A failed
 * import is forgotten, so the next attempt fetches again.
 */
export function lazyPage(load: () => Promise<ComponentType>): LazyPage {
  let loaded: ComponentType | undefined
  let pending: Promise<{ default: ComponentType }> | undefined

  const preload = () => {
    if (!pending) {
      const attempt = load().then((Component) => {
        loaded = Component
        return { default: Component }
      })
      pending = attempt
      attempt.catch(() => {
        if (pending === attempt) pending = undefined
      })
    }
    return pending
  }

  const Lazy = lazy(preload)

  function Page() {
    // Chosen once per mount: an instance never swaps what it renders, which
    // would remount the page and lose its state.
    const [Ready] = useState(() => loaded)
    return Ready ? <Ready /> : <Lazy />
  }

  return { Component: Page, preload }
}
