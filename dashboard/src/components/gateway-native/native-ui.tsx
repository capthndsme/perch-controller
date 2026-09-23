import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Info, LockSimple, Plus, X } from '@phosphor-icons/react'
import { ToneBadge } from '@/components/gateway-config/bits'
import { PageHeader } from '@/components/layout/page-header'
import { NetworkWriteResult } from '@/components/networks/network-write-result'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { PageSpinner } from '@/components/ui/spinner'
import { useProfile } from '@/hooks/use-auth'
import { useGateway, usePageGatewayId } from '@/hooks/use-gateways'
import { STATUS_META } from '@/lib/gateway-config'
import { configWriteBlock, configWriteHardBlocked } from '@/lib/networks'
import { cn } from '@/lib/utils'
import type { Gateway } from '@/types/gateway-config'
import type { NativeWrite, SyncInfo } from '@/types/gateway-native'

/**
 * Shared pieces of the native-sync pages (DHCP, DNS, Routing, System;
 * metrics-be docs/gateway/native-sync.md): the page frame that picks the
 * gateway, the admin gate, ownership badges, the write result and a small
 * list editor.
 */

export type NativeContext = {
  gateway: Gateway
  isAdmin: boolean
  /** Why writes are off (null = the admin can write). */
  writeBlock: string | null
  /** Writes are refused outright (offline gateways still take drafts). */
  hardBlocked: boolean
}

/**
 * The frame of a native-sync page: the gateway from `?gateway=N` or the
 * default pick, the "no gateway" and "admins only" states, then the page.
 */
export function NativePage({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children: (ctx: NativeContext) => ReactNode
}) {
  const { gatewayId, settled, error } = usePageGatewayId()
  const profile = useProfile()
  const gateway = useGateway(gatewayId)
  const isAdmin = profile.data?.role === 'admin'

  let body: ReactNode
  if (!settled || profile.isPending || (gatewayId !== null && gateway.isPending)) {
    body = <PageSpinner label={`Loading ${title}`} />
  } else if (error) {
    body = <p className="text-sm text-destructive">{error.message}</p>
  } else if (gatewayId === null) {
    body = (
      <EmptyState
        title="No Gateway agent yet"
        description={
          <>
            Install perch-collector on your OpenWrt router and adopt it in{' '}
            <Link to="/settings/collectors" className="text-brand underline-offset-2 hover:underline">
              Settings → Collectors
            </Link>
            .
          </>
        }
        className="py-14"
      />
    )
  } else if (!isAdmin) {
    body = (
      <EmptyState
        icon={<LockSimple className="size-6" />}
        title="Admins only"
        description="The router's configuration is visible to admins. Ask an admin if something here needs a change."
        className="py-14"
      />
    )
  } else if (!gateway.data) {
    body = <p className="text-sm text-destructive">{gateway.error?.message ?? 'Failed to load the gateway.'}</p>
  } else {
    const g = gateway.data
    const block = configWriteBlock(g)
    body = children({ gateway: g, isAdmin, writeBlock: block, hardBlocked: configWriteHardBlocked(g) })
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={title}
        description={gateway.data ? `${description} · ${gateway.data.name}` : description}
      />
      {gateway.data && configWriteBlock(gateway.data) ? (
        <p className="flex items-start gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          <Info className="mt-0.5 size-4 shrink-0" />
          {configWriteBlock(gateway.data)}
        </p>
      ) : null}
      {body}
    </div>
  )
}

/** Perch / Router pill plus the section's sync status when it is not in sync. */
export function SyncBadges({ sync, className }: { sync: SyncInfo | null | undefined; className?: string }) {
  if (!sync) return null
  const meta = STATUS_META[sync.status]
  return (
    <span className={cn('inline-flex flex-wrap items-center gap-1', className)}>
      <ToneBadge tone={sync.owner === 'perch' ? 'info' : 'neutral'} title={sync.owner === 'perch' ? 'Synced two-way by Perch' : 'Router-owned: Perch shows it, never writes it'}>
        {sync.owner === 'perch' ? 'Perch' : 'Router'}
      </ToneBadge>
      {sync.owner === 'perch' && sync.status !== 'in_sync' && meta ? (
        <ToneBadge tone={meta.tone} dot>
          {meta.label}
        </ToneBadge>
      ) : null}
    </span>
  )
}

/** Why a router-owned object cannot be edited here, with the way to change that. */
export function RouterOwnedHint({ gatewayId, what = 'This section' }: { gatewayId: number; what?: string }) {
  return (
    <p className="text-[11px] text-muted-foreground">
      {what} is router-owned: include it in{' '}
      <Link to={`/gateway/config/${gatewayId}?tab=sections`} className="text-primary underline underline-offset-2">
        Configuration → Sections
      </Link>{' '}
      to manage it here.
    </p>
  )
}

/** The apply a write started (or why none did), with the link to the changes. */
export function NativeWriteResult({ result, gatewayId }: { result: NativeWrite<unknown>; gatewayId: number }) {
  return (
    <NetworkWriteResult
      gatewayId={gatewayId}
      result={{ object: null, converted: null, issues: result.issues, apply: result.apply, applyError: result.applyError }}
    />
  )
}

/** A "stage only" choice for dialogs: off = apply now (the default). */
export function StageOnly({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 text-xs text-muted-foreground">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="size-3.5" />
      Save as a draft only (apply later from Configuration → Changes)
    </label>
  )
}

/** Editable list of short strings (servers, domains, tags). */
export function ListEditor({
  values,
  onChange,
  placeholder,
  disabled,
  mono = true,
  addLabel = 'Add',
}: {
  values: string[]
  onChange: (next: string[]) => void
  placeholder?: string
  disabled?: boolean
  mono?: boolean
  addLabel?: string
}) {
  const [draft, setDraft] = useState('')
  const add = () => {
    const v = draft.trim()
    if (!v || values.includes(v)) return
    onChange([...values, v])
    setDraft('')
  }
  return (
    <div className="space-y-1.5">
      {values.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5">
          {values.map((v) => (
            <li
              key={v}
              className={cn(
                'inline-flex max-w-full items-center gap-1 rounded-sm border border-border bg-muted/40 px-1.5 py-0.5 text-[11px]',
                mono && 'font-mono',
              )}
            >
              <span className="truncate">{v}</span>
              {!disabled ? (
                <button
                  type="button"
                  aria-label={`Remove ${v}`}
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() => onChange(values.filter((x) => x !== v))}
                >
                  <X className="size-3" />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {!disabled ? (
        <div className="flex gap-1.5">
          <Input
            value={draft}
            placeholder={placeholder}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                add()
              }
            }}
            className={cn('h-7', mono && 'font-mono')}
          />
          <Button type="button" size="sm" variant="outline" onClick={add} disabled={!draft.trim()}>
            <Plus className="size-3.5" />
            {addLabel}
          </Button>
        </div>
      ) : null}
    </div>
  )
}

/** Label + control row of the native forms. */
export function Field({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="text-xs font-medium">{label}</div>
      {children}
      {hint ? <p className="text-[11px] text-muted-foreground">{hint}</p> : null}
    </div>
  )
}
