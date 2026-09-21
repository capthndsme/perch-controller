import { useEffect } from 'react'
import { useAppStore } from '@/stores/app-store'

export function useThemeEffect() {
  const theme = useAppStore((state) => state.theme)

  useEffect(() => {
    const root = document.documentElement

    const applyDark = (isDark: boolean) => {
      root.classList.toggle('dark', isDark)
    }

    if (theme === 'system') {
      const media = window.matchMedia('(prefers-color-scheme: dark)')
      applyDark(media.matches)

      const onChange = (event: MediaQueryListEvent) => {
        applyDark(event.matches)
      }

      media.addEventListener('change', onChange)
      return () => media.removeEventListener('change', onChange)
    }

    applyDark(theme === 'dark')
  }, [theme])
}
