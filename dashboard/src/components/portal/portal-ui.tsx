import type { ReactNode } from 'react'
import { NavLink } from 'react-router-dom'
import { ClockCountdown, Warning } from '@phosphor-icons/react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useIsPortalAdmin } from '@/hooks/use-portal'
import {
  GRANT_END_REASONS,
  GRANT_STATE_LABELS,
  VOUCHER_STATUS_LABELS,
  grantStateClass,
  portalErrorMessage,
  selectClassName,
  voucherStatusClass,
  type DurationUnit,
  type QuotaUnit,
} from '@/lib/portal'
import { cn } from '@/lib/utils'
import type { PortalDelivery, PortalGrant, VoucherStatus } from '@/types/api'

// ── Section navigation ───────────────────────────────────────────────────

const SECTIONS = [
  { to: '/portal', label: 'Portals', end: true, admin: false },
  { to: '/portal/vouchers', label: 'Vouchers', end: false, admin: true },
  { to: '/portal/users', label: 'Portal users', end: false, admin: true },
  { to: '/portal/api-clients', label: 'API clients', end: false, admin: true },
  { to: '/portal/templates', label: 'Templates', end: false, admin: true },
] as const

/** Tabs of the Guest portal section; the admin catalogs are hidden for other roles. */
export function PortalSectionNav() {
  const { isAdmin } = useIsPortalAdmin()
  const sections = SECTIONS.filter((s) => isAdmin || !s.admin)
  if (sections.length < 2) return null
  return (
    <nav
      aria-label="Guest portal"
      className="-mx-4 flex gap-1 overflow-x-auto border-b border-border px-4 [scrollbar-width:none]"
    >
      {sections.map((section) => (
        <NavLink
          key={section.to}
          to={section.to}
          end={section.end}
          className={({ isActive }) =>
            cn(
              '-mb-px shrink-0 border-b-2 px-3 py-2 text-xs font-medium whitespace-nowrap transition-colors',
              isActive
                ? 'border-foreground text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )
          }
        >
          {section.label}
        </NavLink>
      ))}
    </nav>
  )
}

/** Full-page notice for a page a non-admin opened by URL. */
export function AdminOnlyNotice({ what }: { what: string }) {
  return (
    <div className="flex flex-1 items-center justify-center py-16">
      <p className="text-sm text-muted-foreground">Only admins can see {what}.</p>
    </div>
  )
}

// ── Badges ───────────────────────────────────────────────────────────────

/**
 * "Pending" = queued for the router: changes are delivered when the gateway is
 * (back) online, never refused because it is offline (portal.md §11.1).
 */
export function DeliveryBadge({ delivery, className }: { delivery: PortalDelivery; className?: string }) {
  if (delivery !== 'pending') return null
  return (
    <Badge
      variant="outline"
      title="Waiting for the gateway: the router picks this change up when it is online."
      className={cn('rounded-sm border-status-warning/40 bg-status-warning/10 text-foreground', className)}
    >
      <ClockCountdown weight="bold" />
      Pending
    </Badge>
  )
}

export function GrantStateBadge({ grant }: { grant: PortalGrant }) {
  const label =
    grant.state === 'ended' && grant.endReason ? GRANT_END_REASONS[grant.endReason] : GRANT_STATE_LABELS[grant.state]
  return (
    <Badge variant="outline" className={cn('rounded-sm', grantStateClass(grant.state))}>
      {label}
    </Badge>
  )
}

export function VoucherStatusBadge({ status }: { status: VoucherStatus }) {
  return (
    <Badge variant="outline" className={cn('rounded-sm', voucherStatusClass(status))}>
      {VOUCHER_STATUS_LABELS[status]}
    </Badge>
  )
}

// ── Forms ────────────────────────────────────────────────────────────────

type FormFieldProps = {
  label: string
  htmlFor: string
  hint?: ReactNode
  error?: string
  children: ReactNode
  className?: string
}

export function FormField({ label, htmlFor, hint, error, children, className }: FormFieldProps) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <Label htmlFor={htmlFor} className="text-xs font-medium">
        {label}
      </Label>
      {children}
      {error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : hint ? (
        <p className="text-[11px] text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  )
}

export function Checkbox({
  id,
  checked,
  onChange,
  label,
  disabled,
  description,
}: {
  id: string
  checked: boolean
  onChange: (next: boolean) => void
  label: ReactNode
  disabled?: boolean
  description?: ReactNode
}) {
  return (
    <label htmlFor={id} className={cn('flex cursor-pointer items-start gap-2 text-xs', disabled && 'opacity-50')}>
      <input
        id={id}
        type="checkbox"
        className="mt-0.5 size-3.5 accent-primary"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="space-y-0.5">
        <span className="block font-medium">{label}</span>
        {description ? <span className="block text-[11px] text-muted-foreground">{description}</span> : null}
      </span>
    </label>
  )
}

/** A failed call as one line, in the portal's own wording. */
export function ErrorNote({ error, className }: { error: unknown; className?: string }) {
  if (!error) return null
  return (
    <div
      role="alert"
      className={cn(
        'flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive',
        className,
      )}
    >
      <Warning className="mt-0.5 size-3.5 shrink-0" />
      <span>{portalErrorMessage(error)}</span>
    </div>
  )
}

// ── Confirmation ─────────────────────────────────────────────────────────

type ConfirmDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: ReactNode
  confirmLabel: string
  destructive?: boolean
  pending?: boolean
  error?: unknown
  onConfirm: () => void
  children?: ReactNode
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  destructive = false,
  pending = false,
  error,
  onConfirm,
  children,
}: ConfirmDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        {children || error ? (
          <DialogBody>
            {children}
            <ErrorNote error={error} />
          </DialogBody>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button variant={destructive ? 'destructive' : 'default'} onClick={onConfirm} disabled={pending}>
            {pending ? 'Working…' : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Small layout pieces ──────────────────────────────────────────────────

export function Fact({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn('min-w-0', className)}>
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className="truncate text-xs font-medium">{children}</dd>
    </div>
  )
}

/** A thin bar of how much of a limit is used (0–1). */
export function UsageBar({ fraction, className }: { fraction: number; className?: string }) {
  const pct = Math.round(fraction * 100)
  return (
    <div
      className={cn('h-1 w-full overflow-hidden rounded-full bg-muted', className)}
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-label="Used"
    >
      <div
        className={cn('h-full rounded-full', fraction >= 0.9 ? 'bg-status-critical' : fraction >= 0.7 ? 'bg-status-warning' : 'bg-status-good')}
        style={{ width: `${pct}%` }}
      />
    </div>
  )
}

// ── Amount + unit inputs ─────────────────────────────────────────────────

export function DurationInput({
  id,
  amount,
  unit,
  onChange,
  placeholder = 'No limit',
}: {
  id: string
  amount: string
  unit: DurationUnit
  onChange: (next: { amount: string; unit: DurationUnit }) => void
  placeholder?: string
}) {
  return (
    <div className="flex gap-1.5">
      <Input
        id={id}
        inputMode="decimal"
        placeholder={placeholder}
        value={amount}
        onChange={(e) => onChange({ amount: e.target.value, unit })}
        className="rounded-md"
      />
      <select
        aria-label="Unit"
        className={cn(selectClassName, 'w-24 shrink-0')}
        value={unit}
        onChange={(e) => onChange({ amount, unit: e.target.value as DurationUnit })}
      >
        <option value="min">minutes</option>
        <option value="h">hours</option>
        <option value="d">days</option>
      </select>
    </div>
  )
}

export function QuotaInput({
  id,
  amount,
  unit,
  onChange,
  placeholder = 'No limit',
}: {
  id: string
  amount: string
  unit: QuotaUnit
  onChange: (next: { amount: string; unit: QuotaUnit }) => void
  placeholder?: string
}) {
  return (
    <div className="flex gap-1.5">
      <Input
        id={id}
        inputMode="decimal"
        placeholder={placeholder}
        value={amount}
        onChange={(e) => onChange({ amount: e.target.value, unit })}
        className="rounded-md"
      />
      <select
        aria-label="Unit"
        className={cn(selectClassName, 'w-24 shrink-0')}
        value={unit}
        onChange={(e) => onChange({ amount, unit: e.target.value as QuotaUnit })}
      >
        <option value="MB">MB</option>
        <option value="GB">GB</option>
      </select>
    </div>
  )
}

/** Previous / next for `{items, total}` lists. */
export function Pager({
  offset,
  limit,
  total,
  onChange,
}: {
  offset: number
  limit: number
  total: number
  onChange: (offset: number) => void
}) {
  if (total <= limit) return null
  const last = Math.min(offset + limit, total)
  return (
    <div className="flex items-center justify-between gap-2 pt-3 text-xs text-muted-foreground">
      <span>
        {offset + 1}–{last} of {total}
      </span>
      <div className="flex gap-1.5">
        <Button size="sm" variant="outline" disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - limit))}>
          Previous
        </Button>
        <Button size="sm" variant="outline" disabled={last >= total} onClick={() => onChange(offset + limit)}>
          Next
        </Button>
      </div>
    </div>
  )
}
