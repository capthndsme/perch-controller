import { ArrowSquareOut } from '@phosphor-icons/react'
import { CopyButton } from '@/components/ui/copy-button'
import { TERMINAL_PROTOCOL_URL, terminalExample } from '@/lib/hotspot'

const ROUTES: Array<[string, string]> = [
  ['POST session', 'Open a session with a fresh nonce; answers the session id and heartbeatSeconds (5).'],
  ['POST heartbeat', 'Every few seconds, with the coin slot’s state. Answers the open checkout, if a guest picked this box.'],
  ['POST coins', 'One call per coin: {checkoutRef, eventId, amount}. An eventId counts once, so retries are safe.'],
  ['POST done', 'The box’s own Done button: finalises the checkout for what was paid.'],
  ['GET checkout', 'The open checkout, or the last one for 120 s with its reference code (for a receipt printer).'],
]

/**
 * How a coin terminal talks to the gateway (portal.md §14.10), for the
 * token dialog and the terminals page. `router` is the portal's guest-page
 * address when known.
 */
export function TerminalProtocol({ terminalId, router }: { terminalId: number | string; router: string }) {
  const example = terminalExample(terminalId, router)
  return (
    <div className="space-y-3 text-xs">
      <p className="text-muted-foreground">
        The box sits on the guest network and talks only to the gateway, at the portal’s address. Each request carries the
        headers <code className="font-mono text-foreground">X-Perch-Terminal</code>,{' '}
        <code className="font-mono text-foreground">X-Perch-Session</code>,{' '}
        <code className="font-mono text-foreground">X-Perch-Seq</code> (strictly increasing) and{' '}
        <code className="font-mono text-foreground">X-Perch-Signature</code>, an HMAC-SHA256 made with the token. The token
        itself never crosses the Wi-Fi.
      </p>
      <dl className="divide-y divide-border rounded-md border border-border">
        {ROUTES.map(([route, text]) => (
          <div key={route} className="grid gap-0.5 px-2.5 py-1.5 sm:grid-cols-[8.5rem_minmax(0,1fr)] sm:gap-2">
            <dt className="font-mono text-[11px] font-medium">{route}</dt>
            <dd className="text-[11px] text-muted-foreground">{text}</dd>
          </div>
        ))}
      </dl>
      <p className="text-[11px] text-muted-foreground">
        Routes live under <code className="font-mono">/portal/v1/terminal/</code>. A 401{' '}
        <code className="font-mono">session_unknown</code> means: open a new session and retry. A coin reported after the
        checkout closed lands in the ledger as unclaimed, for an admin to credit.
      </p>
      <div className="overflow-hidden rounded-md border border-border">
        <div className="flex items-center justify-between gap-2 border-b border-border bg-muted/40 px-2.5 py-1.5">
          <span className="text-[11px] font-medium text-muted-foreground">Reference client (sh, curl, openssl, jq)</span>
          <CopyButton value={example} ariaLabel="Copy the reference client" />
        </div>
        <pre className="max-h-80 overflow-y-auto p-2.5 font-mono text-[10.5px] leading-relaxed break-all whitespace-pre-wrap">{example}</pre>
      </div>
      <a
        href={TERMINAL_PROTOCOL_URL}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1 text-[11px] underline underline-offset-2"
      >
        Full protocol, errors and threat model
        <ArrowSquareOut className="size-3" />
      </a>
    </div>
  )
}
