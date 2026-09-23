import type { ReactNode } from 'react'
import { ArrowSquareOut, CloudSlash, Cpu, DeviceMobile } from '@phosphor-icons/react'
import { Badge } from '@/components/ui/badge'
import {
  CHECKOUT_STATE_LABELS,
  TERMINAL_PROTOCOL_URL,
  checkoutStateClass,
  terminalState,
  terminalToneClass,
} from '@/lib/hotspot'
import { cn } from '@/lib/utils'
import type { CheckoutState, HotspotTerminal } from '@/types/api'

export function CheckoutStateBadge({ state, className }: { state: CheckoutState; className?: string }) {
  return (
    <Badge variant="outline" className={cn('rounded-sm', checkoutStateClass(state), className)}>
      {CHECKOUT_STATE_LABELS[state]}
    </Badge>
  )
}

export function TerminalStateBadge({ terminal }: { terminal: HotspotTerminal }) {
  const state = terminalState(terminal)
  return (
    <Badge variant="outline" title={state.detail ?? undefined} className={cn('rounded-sm', terminalToneClass(state.tone))}>
      {state.tone === 'busy' || state.tone === 'good' ? (
        <span aria-hidden className={cn('size-1.5 rounded-full', state.tone === 'busy' ? 'bg-brand' : 'bg-status-good')} />
      ) : null}
      {state.label}
    </Badge>
  )
}

function Point({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <li className="flex items-start gap-2.5">
      <span className="mt-0.5 shrink-0 text-muted-foreground">{icon}</span>
      <span className="space-y-0.5">
        <span className="block text-xs font-medium text-foreground">{title}</span>
        <span className="block text-[11px] leading-relaxed text-muted-foreground">{children}</span>
      </span>
    </li>
  )
}

/**
 * The three facts an operator needs before setting up paid access: who runs
 * a checkout, what the reference code is for, and that Perch ships no coin
 * hardware (portal.md §14.1, §14.6, §14.10).
 */
export function HotspotExplainer({ className, compact = false }: { className?: string; compact?: boolean }) {
  return (
    <ul className={cn('space-y-3', compact && 'space-y-2', className)}>
      <Point icon={<CloudSlash className="size-4" />} title="The router runs every checkout">
        The coin terminal and the guest’s page both talk to the gateway, never to this controller. Payments keep working
        while the controller is unreachable; the ledger fills in when it is back. Voids and credits wait for it.
      </Point>
      <Point icon={<DeviceMobile className="size-4" />} title="Reference codes move time to another phone">
        After paying, the guest sees a code (“screenshot or save this code”). Typing it on another device, or after the
        phone changed its private MAC address, moves what is left there; the first device goes offline.
      </Point>
      <Point icon={<Cpu className="size-4" />} title="No coin hardware is provided">
        Perch documents the terminal protocol (signed HTTP to the gateway) and a shell reference client; you build or buy
        the box.{' '}
        <a
          href={TERMINAL_PROTOCOL_URL}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-0.5 text-foreground underline underline-offset-2"
        >
          Terminal protocol
          <ArrowSquareOut className="size-3" />
        </a>
      </Point>
    </ul>
  )
}
