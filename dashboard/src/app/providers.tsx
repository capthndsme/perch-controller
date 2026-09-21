import { QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from 'react-router-dom'
import { router } from '@/app/router'
import { useThemeEffect } from '@/hooks/use-theme'
import { queryClient } from '@/lib/query-client'

function ThemeSync() {
  useThemeEffect()
  return null
}

export function AppProviders() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeSync />
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
}
