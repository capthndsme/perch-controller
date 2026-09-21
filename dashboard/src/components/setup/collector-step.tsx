import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowRight, CaretDown, CaretRight } from '@phosphor-icons/react'
import { CollectorAddressForm } from '@/components/setup/collector-address-form'
import {
  CollectorStepResultCard,
  type CollectorStepResult,
} from '@/components/setup/collector-step-result'
import { DiscoveredCollectors } from '@/components/setup/discovered-collectors'
import { FormError } from '@/components/setup/form-field'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { setupStatusQueryKey, useSetupCandidates, useSetupSkipCollector } from '@/hooks/use-setup'
import { ApiError } from '@/lib/api'
import type { SetupStatusResponse } from '@/types/setup'

const SESSION_EXPIRED =
  'Your setup session expired. Refresh and complete step 1 again, or reset the database.'

type CollectorStepProps = {
  status: SetupStatusResponse
  /**
   * Keeps this step on screen once setup is complete (the first adoption
   * completes it), so the result stays visible until the admin leaves.
   */
  onStayChange: (stay: boolean) => void
}

/**
 * The optional last wizard step. The controller is deployed first; collectors
 * and access points join in any order, so this step offers the collectors that
 * already announced themselves, an add-by-address form, and a way to skip.
 */
export function CollectorStep({ status, onStayChange }: CollectorStepProps) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const candidates = useSetupCandidates()
  const skip = useSetupSkipCollector()
  const [result, setResult] = useState<CollectorStepResult | null>(null)
  const [registered, setRegistered] = useState(0)
  const [showAddressForm, setShowAddressForm] = useState(false)
  const [sessionExpired, setSessionExpired] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const [leaveError, setLeaveError] = useState<string | null>(null)

  useEffect(() => {
    onStayChange(true)
  }, [onStayChange])

  const candidatesError = candidates.error
  const candidatesExpired = candidatesError instanceof ApiError && candidatesError.status === 401
  let loadError: string | null = null
  if (candidatesError && !candidatesExpired) {
    loadError =
      candidatesError instanceof ApiError && candidatesError.status === 403
        ? 'Only admins can see discovered collectors.'
        : `Could not load discovered collectors: ${candidatesError.message}`
  }
  const waiting = candidates.data?.candidates ?? []

  function onRegistered(next: CollectorStepResult) {
    setResult(next)
    setRegistered((count) => count + 1)
    setShowAddressForm(false)
  }

  /** Leaves once the cached status says complete, so the gate at `/` lets the admin in. */
  async function leave() {
    await queryClient.invalidateQueries({ queryKey: setupStatusQueryKey })
    onStayChange(false)
    navigate('/')
  }

  async function onOpenDashboard() {
    setLeaving(true)
    setLeaveError(null)
    try {
      await leave()
    } catch {
      setLeaving(false)
      setLeaveError('Could not reach the backend. Try again.')
    }
  }

  async function onSkip() {
    setLeaving(true)
    setLeaveError(null)
    try {
      await skip.mutateAsync()
      await leave()
    } catch (error) {
      setLeaving(false)
      if (error instanceof ApiError && error.status === 401) {
        setSessionExpired(true)
        return
      }
      setLeaveError(error instanceof ApiError ? error.message : 'Could not skip this step.')
    }
  }

  if (result) {
    return (
      <CollectorStepResultCard
        result={result}
        waiting={waiting.length}
        leaving={leaving}
        onAdoptAnother={() => setResult(null)}
        onOpenDashboard={() => void onOpenDashboard()}
      />
    )
  }

  return (
    <Card className="rounded-xl shadow-sm">
      <CardHeader className="border-b">
        <CardTitle className="text-lg">Add collectors</CardTitle>
        <CardDescription>
          Collectors capture traffic and report to this controller. Collectors and access points
          can be added in any order, now or later.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6 pt-6">
        {sessionExpired || candidatesExpired ? <FormError message={SESSION_EXPIRED} /> : null}

        <DiscoveredCollectors
          candidates={waiting}
          discoveryEnabled={candidates.data?.discoveryEnabled ?? true}
          loading={candidates.isPending}
          loadError={loadError}
          onAdopted={onRegistered}
          onSessionExpired={() => setSessionExpired(true)}
        />

        <section className="space-y-3 border-t pt-4">
          <button
            type="button"
            className="flex items-center gap-1.5 text-sm font-medium"
            aria-expanded={showAddressForm}
            onClick={() => setShowAddressForm((current) => !current)}
          >
            {showAddressForm ? (
              <CaretDown className="size-3.5" />
            ) : (
              <CaretRight className="size-3.5" />
            )}
            Add a collector by address
          </button>
          {showAddressForm ? (
            <CollectorAddressForm
              status={status}
              onAdded={onRegistered}
              onSessionExpired={() => setSessionExpired(true)}
            />
          ) : (
            <p className="text-xs text-muted-foreground">
              For a collector that cannot announce itself to this controller.
            </p>
          )}
        </section>

        {leaveError ? <FormError message={leaveError} /> : null}
      </CardContent>
      <CardFooter className="flex-wrap items-center justify-between gap-3 border-t bg-muted/20">
        {registered > 0 ? (
          <>
            <p className="text-xs text-muted-foreground">
              {registered === 1 ? '1 collector' : `${registered} collectors`} added. Setup is
              complete.
            </p>
            <Button onClick={() => void onOpenDashboard()} disabled={leaving}>
              {leaving ? 'Opening…' : 'Open dashboard'}
              {!leaving ? <ArrowRight className="size-3.5" /> : null}
            </Button>
          </>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              Collectors and access points can also be added later under Settings.
            </p>
            <Button variant="outline" onClick={() => void onSkip()} disabled={leaving}>
              {skip.isPending || leaving ? 'Skipping…' : 'Skip for now'}
            </Button>
          </>
        )}
      </CardFooter>
    </Card>
  )
}
