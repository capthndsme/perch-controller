import { useState } from 'react'
import { Navigate } from 'react-router-dom'
import { API_URL } from '@/lib/api'
import { AdminStep } from '@/components/setup/admin-step'
import { CollectorStep } from '@/components/setup/collector-step'
import { InstanceStep } from '@/components/setup/instance-step'
import { SetupLayout } from '@/components/setup/setup-layout'
import { SetupSignIn } from '@/components/setup/setup-sign-in'
import { SetupStepper } from '@/components/setup/setup-stepper'
import { PageSpinner } from '@/components/ui/spinner'
import { useSetupStatus } from '@/hooks/use-setup'
import { useAuthStore } from '@/stores/auth-store'

export function SetupPage() {
  const { data, error, isPending } = useSetupStatus()
  // The first adoption completes setup; the collector step asks to stay so its
  // result (and any other waiting collectors) remain visible until the admin
  // chooses to leave, whatever a status refetch says in the meantime.
  const [stayOnCollectorStep, setStayOnCollectorStep] = useState(false)
  // Past step 1 the wizard needs the admin's session. Without one (tab closed,
  // another browser, a 401 from a setup call clears it) the admin signs in again.
  const token = useAuthStore((state) => state.token)

  if (isPending) {
    return (
      <SetupLayout>
        <PageSpinner label="Loading setup" />
      </SetupLayout>
    )
  }

  if (error || !data) {
    return (
      <SetupLayout>
        <p className="text-center text-sm text-destructive">
          Could not reach the backend. Is Perch Network Controller running on{' '}
          {API_URL || window.location.origin}?
        </p>
      </SetupLayout>
    )
  }

  if (data.step === 'complete' && !stayOnCollectorStep) {
    return <Navigate to="/" replace />
  }

  const needsSignIn = !token && (data.step === 'instance' || data.step === 'collector')
  const showCollectorStep =
    !needsSignIn &&
    (data.step === 'collector' || (data.step === 'complete' && stayOnCollectorStep))

  return (
    <SetupLayout>
      <div className="space-y-6">
        <SetupStepper current={data.step} />
        {data.step === 'admin' ? <AdminStep /> : null}
        {needsSignIn ? <SetupSignIn /> : null}
        {data.step === 'instance' && !needsSignIn ? <InstanceStep /> : null}
        {showCollectorStep ? (
          <CollectorStep status={data} onStayChange={setStayOnCollectorStep} />
        ) : null}
      </div>
    </SetupLayout>
  )
}
