import type { ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { useSetupStatus } from '@/hooks/use-setup'

type SetupGateProps = {
  children: ReactNode
}

export function SetupGate({ children }: SetupGateProps) {
  const location = useLocation()
  const { data, isPending } = useSetupStatus()

  if (isPending) {
    return (
      <div className="flex min-h-svh items-center justify-center text-sm text-muted-foreground">
        Loading…
      </div>
    )
  }

  if (data?.step !== 'complete' && location.pathname !== '/setup') {
    return <Navigate to="/setup" replace state={{ from: location.pathname }} />
  }

  return children
}
