import { useState } from 'react'
import { Navigate } from 'react-router-dom'
import { API_URL } from '@/lib/api'
import { AdminStep } from '@/components/setup/admin-step'
import { CollectorStep } from '@/components/setup/collector-step'
import { InstanceStep } from '@/components/setup/instance-step'
import { SetupLayout } from '@/components/setup/setup-layout'
import { SetupStepper } from '@/components/setup/setup-stepper'
import { useSetupStatus } from '@/hooks/use-setup'

export function SetupPage() {
  const { data, error, isPending } = useSetupStatus()
  // The first adoption completes setup; the collector step asks to stay so its
  // result (and any other waiting collectors) remain visible until the admin
  // chooses to leave, whatever a status refetch says in the meantime.
  const [stayOnCollectorStep, setStayOnCollectorStep] = useState(false)

  if (isPending) {
    return (
      <SetupLayout>
        <p className="text-center text-sm text-muted-foreground">Loading setup…</p>
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

  const showCollectorStep =
    data.step === 'collector' || (data.step === 'complete' && stayOnCollectorStep)

  return (
    <SetupLayout>
      <div className="space-y-6">
        <SetupStepper current={data.step} />
        {data.step === 'admin' ? <AdminStep /> : null}
        {data.step === 'instance' ? <InstanceStep /> : null}
        {showCollectorStep ? (
          <CollectorStep status={data} onStayChange={setStayOnCollectorStep} />
        ) : null}
      </div>
    </SetupLayout>
  )
}
