import { useState } from 'react'
import { PlainHttpNotice } from '@/components/security/plain-http'
import { CopyButton } from '@/components/ui/copy-button'
import { buildInstallCommands } from '@/lib/ap-agents'
import { isPlainHttpUrl } from '@/lib/transport-security'
import type { ApAgentInstallInfo } from '@/types/api'

const SELECT_CLASS =
  'h-8 w-full min-w-0 rounded-md border border-border bg-card px-2 text-xs outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50'

function CommandBlock({
  title,
  hint,
  command,
  children,
}: {
  title: string
  hint?: string
  command: string
  children?: React.ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-medium">{title}</p>
          {hint ? <p className="text-[11px] text-muted-foreground">{hint}</p> : null}
        </div>
        <CopyButton value={command} ariaLabel={`Copy the ${title.toLowerCase()} command`} />
      </div>
      {children}
      <pre className="rounded-md border border-border bg-muted/40 p-2 font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap select-all">
        {command}
      </pre>
    </div>
  )
}

type InstallCommandsProps = {
  token: string
  info: ApAgentInstallInfo | undefined
  infoLoading: boolean
  infoError: string | null
}

/**
 * The join token plus the three ways to put it on an AP
 * (docs/ap-controller.md §4.2), each with a copy button.
 */
export function InstallCommands({ token, info, infoLoading, infoError }: InstallCommandsProps) {
  const [arch, setArch] = useState<string | null>(null)
  const assets = info?.assets ?? []
  const asset = assets.find((candidate) => candidate.arch === arch) ?? assets[0]
  const commands = info ? buildInstallCommands(info, token, asset) : null

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs font-medium">Join token</p>
          <CopyButton value={token} label="Copy token" />
        </div>
        <p className="rounded-md border border-border bg-muted/40 p-2 font-mono text-[11px] break-all select-all">
          {token}
        </p>
      </div>

      {commands ? (
        <>
          {isPlainHttpUrl(info?.controllerUrl) ? <PlainHttpNotice /> : null}
          <CommandBlock
            title="One-liner"
            hint="Picks the right binary for the AP and checks its checksum."
            command={commands.oneLiner}
          />
          <CommandBlock
            title="Manual download"
            hint="Choose the AP's architecture (DISTRIB_ARCH in /etc/openwrt_release)."
            command={commands.manual}
          >
            <select
              aria-label="AP architecture"
              className={SELECT_CLASS}
              value={asset?.arch ?? ''}
              onChange={(event) => setArch(event.target.value)}
            >
              {assets.map((candidate) => (
                <option key={candidate.arch} value={candidate.arch}>
                  {candidate.label}: {candidate.hint}
                </option>
              ))}
            </select>
          </CommandBlock>
          <CommandBlock
            title="Already installed"
            hint="The opkg/apk package, or an AP that ran the installer before."
            command={commands.join}
          />
          <p className="text-[11px] text-muted-foreground">
            Run it as root on the AP. It joins within seconds and shows up under Registered
            sources; an AP scraped today keeps its history.
          </p>
        </>
      ) : infoLoading ? (
        <p className="text-xs text-muted-foreground">Loading install commands…</p>
      ) : (
        <p className="text-xs text-destructive">
          Could not load the install commands{infoError ? `: ${infoError}` : '.'}
        </p>
      )}
    </div>
  )
}
