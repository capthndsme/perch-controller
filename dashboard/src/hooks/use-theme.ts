import { useEffect, useRef } from 'react'
import { prefersReducedMotion } from '@/lib/motion'
import { useAppStore } from '@/stores/app-store'

/**
 * The page background of each theme (index.css --background), for the phone
 * browser's bar colour. index.html's first-paint script repeats these values.
 */
const THEME_COLOR = { light: '#f7f7f5', dark: '#0d0d0d' } as const

/**
 * Puts `.dark` on <html> in one step: transitions are off for that style
 * pass (index.css `.theme-swap`), so no control fades behind the rest of the
 * page. With `animate` and motion allowed, the page crossfades through a View
 * Transition (index.css `::view-transition-*`).
 */
function applyTheme(isDark: boolean, animate: boolean) {
  const root = document.documentElement
  const swap = () => {
    root.classList.add('theme-swap')
    root.classList.toggle('dark', isDark)
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', isDark ? THEME_COLOR.dark : THEME_COLOR.light)
    // Apply the new colours now, with transitions off; turn them back on after.
    void window.getComputedStyle(document.body).backgroundColor
    window.setTimeout(() => root.classList.remove('theme-swap'), 1)
  }
  const changes = root.classList.contains('dark') !== isDark
  if (animate && changes && !prefersReducedMotion() && typeof document.startViewTransition === 'function') {
    document.startViewTransition(swap)
  } else {
    swap()
  }
}

export function useThemeEffect() {
  const theme = useAppStore((state) => state.theme)
  // The first run paints the stored theme as the page loads: no crossfade.
  const painted = useRef(false)

  useEffect(() => {
    const animate = painted.current
    painted.current = true

    if (theme === 'system') {
      const media = window.matchMedia('(prefers-color-scheme: dark)')
      applyTheme(media.matches, animate)

      const onChange = (event: MediaQueryListEvent) => {
        applyTheme(event.matches, true)
      }

      media.addEventListener('change', onChange)
      return () => media.removeEventListener('change', onChange)
    }

    applyTheme(theme === 'dark', animate)
  }, [theme])
}
