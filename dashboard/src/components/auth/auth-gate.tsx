import { useEffect, type ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { PageSpinner } from '@/components/ui/spinner'
import { useProfile } from '@/hooks/use-auth'
import { ApiError } from '@/lib/api'
import { isVendor } from '@/lib/roles'
import { useAuthStore } from '@/stores/auth-store'
import { ForcedPasswordChangeForm } from './forced-password-change-form'

type AuthGateProps = {
  children: ReactNode
  /**
   * Wi-Fi vendors may see this route (Sell Mode). Everywhere else a vendor is
   * sent to `/sell`: the API refuses them everything but selling (portal.md §15.2).
   */
  allowVendor?: boolean
}

export function AuthGate({ children, allowVendor = false }: AuthGateProps) {
  const location = useLocation()
  const token = useAuthStore((state) => state.token)
  const clearSession = useAuthStore((state) => state.clearSession)
  const { isError, error, isLoading, data: profile } = useProfile()

  useEffect(() => {
    if (isError && error instanceof ApiError && error.status === 401) {
      clearSession()
    }
  }, [isError, error, clearSession])

  if (!token) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />
  }

  if (isLoading) {
    return <PageSpinner fullScreen label="Checking session" />
  }

  if (isError) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />
  }

  if (profile?.mustChangePassword) {
    return <ForcedPasswordChangeForm />
  }

  if (!allowVendor && isVendor(profile)) {
    return <Navigate to="/sell" replace />
  }

  return children
}
