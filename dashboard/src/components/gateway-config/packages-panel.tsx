import { useState } from 'react'
import { DownloadSimple, Package } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import { Panel } from '@/components/ui/panel'
import { Spinner } from '@/components/ui/spinner'
import { ConfirmDialog, ToneBadge } from '@/components/gateway-config/bits'
import { useDialog } from '@/hooks/use-dialog'
import { useInstallPackages, usePackageDryRun } from '@/hooks/use-gateways'
import { formatBytes } from '@/lib/format-bytes'
import { refusalMessage } from '@/lib/gateway-config'
import type { Gateway, PackageDryRun } from '@/types/gateway-config'

/**
 * "Install on gateway" (README 7.7): packages on the router's install
 * allowlist, with a dry run first (flash check, opkg or apk), then a package
 * job that confirms or rolls back like any apply.
 */
export function PackagesPanel({ gateway, isAdmin }: { gateway: Gateway; isAdmin: boolean }) {
  const caps = gateway.capabilities ?? null
  const allowlist = caps?.installAllowlist ?? []
  const installed = caps?.packages ?? {}
  const dryRun = usePackageDryRun(gateway.id)
  const install = useInstallPackages(gateway.id)
  const dialog = useDialog()
  const [target, setTarget] = useState<string | null>(null)
  const [plan, setPlan] = useState<PackageDryRun | null>(null)
  const managed = gateway.mode === 'managed'

  async function check(name: string) {
    setTarget(name)
    setPlan(null)
    install.reset()
    dryRun.reset()
    dialog.show()
    try {
      setPlan(await dryRun.mutateAsync([name]))
    } catch {
      // shown in the dialog
    }
  }

  if (!caps) {
    return (
      <Panel title="Packages" description="Optional OpenWrt packages Perch can install on the router.">
        <p className="text-xs text-muted-foreground">The router has not reported its packages yet.</p>
      </Panel>
    )
  }

  const flashFree = caps.flash?.freeBytes

  return (
    <Panel
      title="Packages"
      description="Optional OpenWrt packages Perch can install on the router."
      actions={
        <span className="text-[11px] text-muted-foreground">
          {caps.packageManager ?? 'package manager unknown'}
          {typeof flashFree === 'number' ? ` · ${formatBytes(flashFree)} free` : ''}
        </span>
      }
    >
      {allowlist.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          The router’s install allowlist is empty: nothing can be installed from here.
        </p>
      ) : (
        <ul className="divide-y divide-border/70 text-xs">
          {allowlist.map((name) => {
            const version = installed[name]
            return (
              <li key={name} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="flex items-center gap-2">
                  <Package className="size-4 text-muted-foreground" />
                  <span className="font-mono">{name}</span>
                  {version ? <ToneBadge tone="good">{version}</ToneBadge> : <ToneBadge tone="neutral">Not installed</ToneBadge>}
                </span>
                {!version && isAdmin ? (
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => check(name)}
                    disabled={!managed || !gateway.writable || gateway.pendingApply !== null}
                    title={!managed ? 'Needs managed mode' : undefined}
                  >
                    <DownloadSimple />
                    Install on gateway
                  </Button>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
      {!managed && isAdmin && allowlist.length > 0 ? (
        <p className="mt-2 text-[11px] text-muted-foreground">Installing needs managed mode.</p>
      ) : null}

      <ConfirmDialog
        open={dialog.open}
        onOpenChange={dialog.setOpen}
        title={`Install ${target ?? ''} on ${gateway.name}`}
        description="The install confirms like any change: if the router loses Perch afterwards, it removes the package again."
        confirmLabel="Install"
        pending={install.isPending}
        error={(dryRun.error ?? install.error) ? refusalMessage(dryRun.error ?? install.error) : null}
        onConfirm={async () => {
          if (!target) return
          try {
            await install.mutateAsync({ packages: [target] })
            dialog.setOpen(false)
          } catch {
            // shown
          }
        }}
      >
        {dryRun.isPending ? (
          <p className="flex items-center gap-2 text-muted-foreground">
            <Spinner className="size-3.5" /> Checking with the router…
          </p>
        ) : plan ? (
          <ul className="space-y-1">
            <li>
              Installs: <span className="font-mono">{(plan.install ?? [target]).join(', ') || '—'}</span>
            </li>
            {plan.alreadyInstalled && plan.alreadyInstalled.length > 0 ? (
              <li>Already there: {plan.alreadyInstalled.join(', ')}</li>
            ) : null}
            {typeof plan.needBytes === 'number' ? (
              <li>
                Needs {formatBytes(plan.needBytes)}
                {typeof plan.freeBytes === 'number' ? ` of ${formatBytes(plan.freeBytes)} free flash` : ''}
              </li>
            ) : null}
            {plan.manager ? <li>With {plan.manager}</li> : null}
          </ul>
        ) : null}
      </ConfirmDialog>
    </Panel>
  )
}
