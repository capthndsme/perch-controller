import type { ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { PageSpinner } from '@/components/ui/spinner'
import { useSetupStatus } from '@/hooks/use-setup'

type SetupGateProps = {
  children: ReactNode
}

export function SetupGate({ children }: SetupGateProps) {
  const location = useLocation()
  const { data, isPending } = useSetupStatus()

  if (isPending) {
    return <PageSpinner fullScreen />
  }

  if (data?.step !== 'complete' && location.pathname !== '/setup') {
    return <Navigate to="/setup" replace state={{ from: location.pathname }} />
  }

  return children
}
