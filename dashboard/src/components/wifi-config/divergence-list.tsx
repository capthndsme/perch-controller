import { useState } from 'react'
import { ArrowsSplit, Key } from '@phosphor-icons/react'
import { ErrorLine, ToneBadge } from '@/components/gateway-config/bits'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Spinner } from '@/components/ui/spinner'
import { PassphraseInput } from '@/components/wifi-config/passphrase-card'
import { EditorSheet } from '@/components/wifi-config/sheet'
import { useResolveDivergences } from '@/hooks/use-wifi-config'
import { formatAgo, formatDateTime, routerAuthorLabel } from '@/lib/gateway-config'
import {
  divergenceSummary,
  passphraseProblem,
  RESOLUTION_META,
  wifiRefusalMessage,
} from '@/lib/wifi-config'
import { cn } from '@/lib/utils'
import type { DivergenceResolution, ResolveDivergencesResult, WifiDivergence } from '@/types/wifi-config'

const ORDER: DivergenceResolution[] = ['fleet', 'override', 'revert', 'split']

const KIND_LABEL: Record<WifiDivergence['kind'], string> = {
  option: 'Setting changed',
  removed: 'Removed on the AP',
  added: 'Added on the AP',
  unassigned: 'Unassigned',
  country: 'Country',
}

/** The label a resolution gets for this divergence (the table of controller.md 5.3). */
function resolutionLabel(d: WifiDivergence, r: DivergenceResolution): string {
  if (d.kind === 'removed') return r === 'override' ? 'Leave it off this AP' : r === 'revert' ? 'Put it back' : RESOLUTION_META[r].label
  if (d.kind === 'added') {
    return r === 'fleet' ? 'Add to all APs' : r === 'override' ? 'Keep it on this AP' : r === 'revert' ? 'Remove it' : RESOLUTION_META[r].label
  }
  if (d.kind === 'country') {
    return r === 'fleet' ? 'Make it the fleet default' : r === 'override' ? 'Fix it for this AP' : r === 'revert' ? 'Write the policy' : RESOLUTION_META[r].label
  }
  return RESOLUTION_META[r].label
}

function DivergenceItem({
  divergence: d,
  isAdmin,
  onResolved,
}: {
  divergence: WifiDivergence
  isAdmin: boolean
  onResolved: (result: ResolveDivergencesResult) => void
}) {
  const resolve = useResolveDivergences()
  const [askPassphrase, setAskPassphrase] = useState(false)
  const [passphrase, setPassphrase] = useState('')
  const [tried, setTried] = useState(false)
  const author = routerAuthorLabel(d.routerAuthor)
  const secret = d.option === 'key'
  const resolutions = ORDER.filter((r) => d.resolutions.includes(r))

  async function run(resolution: DivergenceResolution, withPassphrase?: string) {
    try {
      // mutateAsync, not mutate's callbacks: the item is gone from the refreshed list before they would run.
      const result = await resolve.mutateAsync({
        items: [{ id: d.id, resolution, ...(withPassphrase ? { passphrase: withPassphrase } : {}) }],
      })
      setAskPassphrase(false)
      onResolved(result)
    } catch {
      // shown below
    }
  }

  return (
    <li className="rounded-lg border border-status-serious/30 bg-card" data-testid="divergence">
      <div className="space-y-2 p-3">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <ToneBadge tone="serious">
            <ArrowsSplit aria-hidden className="size-3" />
            {KIND_LABEL[d.kind]}
          </ToneBadge>
          <span className="font-semibold">{d.apName}</span>
          {d.networkName ? <span className="text-muted-foreground">· {d.networkName}</span> : null}
          {d.radio ? <span className="font-mono text-[11px] text-muted-foreground">{d.radio}</span> : null}
        </div>
        <p className="text-[13px]">{divergenceSummary(d)}</p>
        <p className="text-[11px] text-muted-foreground" title={formatDateTime(d.detectedAt)}>
          {author ? `Changed in ${author} · ` : ''}
          {formatAgo(d.detectedAt)}
        </p>
        {isAdmin ? (
          <div className="grid grid-cols-2 gap-2 pt-1 sm:flex sm:flex-wrap">
            {resolutions.map((r, i) => (
              <Button
                key={r}
                size="sm"
                variant={r === 'fleet' ? 'default' : 'outline'}
                className={cn('h-10 sm:h-7', i === 0 && 'col-span-2')}
                title={RESOLUTION_META[r].hint}
                disabled={resolve.isPending}
                onClick={() => (secret && r === 'fleet' ? setAskPassphrase(true) : run(r))}
              >
                {resolve.isPending && resolve.variables?.items[0]?.resolution === r ? (
                  <Spinner className="size-3.5 text-current" />
                ) : null}
                {resolutionLabel(d, r)}
              </Button>
            ))}
          </div>
        ) : null}
        <ErrorLine message={resolve.error && !askPassphrase ? wifiRefusalMessage(resolve.error) : null} />
      </div>

      {secret ? (
        <EditorSheet
          open={askPassphrase}
          onOpenChange={setAskPassphrase}
          title={`New passphrase for ${d.networkName ?? 'this network'}`}
          description={`${d.apName} uses a different passphrase now. Type it to make it the passphrase on every access point.`}
          footer={
            <>
              <Button variant="outline" onClick={() => setAskPassphrase(false)}>
                Cancel
              </Button>
              <Button
                disabled={resolve.isPending}
                onClick={() => {
                  setTried(true)
                  if (!passphraseProblem(passphrase)) run('fleet', passphrase)
                }}
              >
                {resolve.isPending ? <Spinner className="size-3.5 text-current" /> : <Key weight="bold" />}
                Check and apply to all
              </Button>
            </>
          }
        >
          <PassphraseInput value={passphrase} onChange={setPassphrase} showError={tried} autoFocus label={`Passphrase on ${d.apName}`} />
          <p className="text-xs text-muted-foreground">
            Perch checks it against {d.apName}’s fingerprint first; the other access points then get it and their devices
            must re-enter it.
          </p>
          <ErrorLine message={resolve.error ? wifiRefusalMessage(resolve.error) : null} />
        </EditorSheet>
      ) : null}
    </li>
  )
}

/**
 * Changes made on single access points (LuCI, uci) that differ from the
 * network they belong to (decision D5), across APs, newest first, each with
 * its choices: Apply to all APs, Keep for this AP, Revert this AP, Make a new
 * network.
 */
export function DivergenceList({
  divergences,
  isAdmin,
  onResolved,
  empty = 'Every access point matches its networks.',
}: {
  divergences: WifiDivergence[]
  isAdmin: boolean
  onResolved: (result: ResolveDivergencesResult) => void
  empty?: string
}) {
  if (divergences.length === 0) {
    return <EmptyState title="Nothing changed on the access points" description={empty} />
  }
  const sorted = [...divergences].sort((a, b) => Date.parse(b.detectedAt) - Date.parse(a.detectedAt))
  return (
    <ul className="space-y-2">
      {sorted.map((d) => (
        <DivergenceItem key={d.id} divergence={d} isAdmin={isAdmin} onResolved={onResolved} />
      ))}
    </ul>
  )
}
