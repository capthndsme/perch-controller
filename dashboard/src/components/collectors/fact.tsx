import type { ReactNode } from 'react'

/** A small labelled value, as used on collector cards. */
export function Fact({ label, mono, children }: { label: string; mono?: boolean; children: ReactNode }) {
  return (
    <div className="space-y-0.5">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={mono ? 'font-mono text-[11px] break-all' : 'text-xs'}>{children}</p>
    </div>
  )
}
