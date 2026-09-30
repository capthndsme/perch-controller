import { LockOpen } from '@phosphor-icons/react'
import { isDashboardPlainHttp, PLAIN_HTTP_DOCS_URL } from '@/lib/transport-security'

/**
 * Under a passphrase field when the dashboard itself came over plain HTTP from
 * another machine (dashboard.md section 5): what is typed travels unencrypted.
 */
export function PlainHttpPassphraseNote() {
  if (!isDashboardPlainHttp()) return null
  return (
    <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
      <LockOpen aria-hidden className="mt-px size-3.5 shrink-0 text-status-warning" />
      <span>
        This passphrase travels to the controller unencrypted from this browser.{' '}
        <a href={PLAIN_HTTP_DOCS_URL} target="_blank" rel="noreferrer" className="underline underline-offset-2">
          Plain HTTP and a management VLAN
        </a>
      </span>
    </p>
  )
}
