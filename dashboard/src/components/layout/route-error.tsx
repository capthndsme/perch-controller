import { useEffect, useState } from 'react'
import { isRouteErrorResponse, useRouteError } from 'react-router-dom'
import { ArrowClockwise, WarningCircle } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import { PageSpinner } from '@/components/ui/spinner'
import { canReloadForChunkError, isChunkLoadError, reloadForChunkError } from '@/lib/chunk-reload'
import { cn } from '@/lib/utils'

type RouteErrorProps = {
  /** Sign-in, setup and shell-level errors: centre in the viewport. */
  fullScreen?: boolean
}

function errorDetail(error: unknown): string | null {
  if (isRouteErrorResponse(error)) return `${error.status} ${error.statusText}`.trim()
  if (error instanceof Error) return error.message
  return null
}

/**
 * Route error element. A page whose code will not load (usually a tab opened
 * before a redeploy, asking for chunks the server no longer has) reloads once
 * to pick up the current build; see lib/chunk-reload.ts. If that does not
 * help, or the page failed for another reason, it says so and offers Reload.
 * Inside the app the shell stays around it, so navigation keeps working.
 */
export function RouteError({ fullScreen = false }: RouteErrorProps) {
  const error = useRouteError()
  const chunkError = isChunkLoadError(error)
  // Decided once per error: the guard allows one reload per build.
  const [reloading] = useState(() => chunkError && canReloadForChunkError())

  useEffect(() => {
    if (reloading) reloadForChunkError()
  }, [reloading])

  if (reloading) return <PageSpinner label="Loading the current version" fullScreen={fullScreen} />

  const detail = chunkError ? null : errorDetail(error)

  return (
    <div
      role="alert"
      data-route-error={chunkError ? 'chunk' : 'render'}
      className={cn('flex flex-1 items-center justify-center px-4', fullScreen ? 'min-h-svh' : 'py-24')}
    >
      <div className="flex max-w-md flex-col items-center gap-3 text-center">
        <WarningCircle aria-hidden className="size-6 text-muted-foreground" />
        <h1 className="text-base font-semibold tracking-tight">
          {chunkError ? 'This page could not be loaded' : 'Something went wrong'}
        </h1>
        <p className="text-sm text-muted-foreground">
          {chunkError
            ? 'Perch may have been updated since this tab was opened, or the connection to the controller dropped. Reload to get the current version.'
            : 'This page ran into an unexpected error. Reloading usually fixes it.'}
        </p>
        {detail ? <p className="max-w-full break-words font-mono text-xs text-muted-foreground">{detail}</p> : null}
        <Button type="button" className="mt-1" onClick={() => window.location.reload()}>
          <ArrowClockwise />
          Reload
        </Button>
      </div>
    </div>
  )
}
