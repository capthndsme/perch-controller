import { useState } from 'react'
import { ArrowsClockwise, Crosshair, Info, WifiSlash } from '@phosphor-icons/react'
import { ErrorLine, IssueList } from '@/components/gateway-config/bits'
import { Button } from '@/components/ui/button'
import { Segmented } from '@/components/ui/segmented'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { RadioChannelPicker } from '@/components/wifi-config/radio-channel-picker'
import { RadioPower, type TxDraft } from '@/components/wifi-config/radio-power'
import { EditorSheet } from '@/components/wifi-config/sheet'
import { useUpdateRadio } from '@/hooks/use-wifi-config'
import { cacSecondsFor, durationText, plural, radioLabel, txPresetOf, wifiRefusalMessage, widthLabel } from '@/lib/wifi-config'
import type { RadioPatch, WifiRadio, WriteResult } from '@/types/wifi-config'

function Impact({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <span className="mt-px shrink-0 [&>svg]:size-3.5">{icon}</span>
      <span>{children}</span>
    </li>
  )
}

/**
 * One radio's settings (a bottom sheet on a phone): on/off, channel (Auto
 * with its allowed set, or one channel), width, transmit power. The impact
 * shows inline; Apply runs a one-AP rollout, Save keeps it as a draft.
 */
export function RadioEditorSheet({
  open,
  onOpenChange,
  radio,
  apName,
  managed,
  clients,
  isAdmin,
  onDone,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  radio: WifiRadio
  apName: string
  managed: boolean
  /** Clients on this radio now (null = unknown). */
  clients: number | null
  isAdmin: boolean
  onDone: (result: WriteResult<WifiRadio>, applied: boolean) => void
}) {
  const update = useUpdateRadio()
  const [enabled, setEnabled] = useState(radio.enabled)
  const [channelMode, setChannelMode] = useState(radio.channelMode)
  const [channel, setChannel] = useState<number | null>(radio.channel ?? radio.current.channel)
  const [allowed, setAllowed] = useState<number[] | null>(radio.allowed)
  const [width, setWidth] = useState<number | null>(radio.width)
  const [tx, setTx] = useState<TxDraft>({
    preset: txPresetOf(radio.txpower, radio.options.txpowerMaxDbm),
    dbm: radio.txpower.dbm,
  })
  const editable = isAdmin && managed && radio.present

  const patch: RadioPatch = {}
  if (enabled !== radio.enabled) patch.enabled = enabled
  if (channelMode !== radio.channelMode) patch.channelMode = channelMode
  if (channelMode === 'fixed' && channel !== null && channel !== radio.channel) patch.channel = channel
  if (channelMode === 'auto' && JSON.stringify(allowed) !== JSON.stringify(radio.allowed)) patch.allowed = allowed
  if (width !== null && width !== radio.width) patch.width = width
  const txNow = tx.preset === 'auto' ? { mode: 'auto' as const } : { mode: 'fixed' as const, dbm: tx.dbm ?? undefined }
  if (tx.preset === 'auto' ? radio.txpower.mode !== 'auto' : tx.dbm !== radio.txpower.dbm || radio.txpower.mode !== 'fixed') {
    patch.txpower = txNow
  }
  const changed = Object.keys(patch).length > 0
  const invalid =
    (channelMode === 'fixed' && channel === null) ||
    (channelMode === 'auto' && allowed !== null && allowed.length === 0) ||
    (tx.preset === 'custom' && (tx.dbm === null || tx.dbm < 1))

  const dfsFixed = channelMode === 'fixed' ? cacSecondsFor(radio, channel) : null
  const dfsAuto =
    channelMode === 'auto' &&
    radio.options.channels.some((c) => c.dfs && (allowed === null || allowed.includes(c.channel)))
  const widths = radio.options.widths.length > 0 ? radio.options.widths : [20]

  async function submit(apply: boolean) {
    try {
      const result = await update.mutateAsync({ apId: radio.apId, section: radio.section, patch, apply })
      onDone(result, apply)
      onOpenChange(false)
    } catch {
      // shown below
    }
  }

  const issues = (update.error as { body?: { issues?: [] } } | null)?.body?.issues ?? []

  return (
    <EditorSheet
      open={open}
      onOpenChange={onOpenChange}
      title={`${apName} · ${radioLabel(radio)}`}
      description={
        !radio.present
          ? 'This radio is not present on the access point any more.'
          : !managed
            ? 'Read-only: switch this access point to Managed under Sync to change its radios.'
            : 'Applies to this access point alone.'
      }
      wide
      footer={
        editable ? (
          <>
            <Button variant="outline" onClick={() => submit(false)} disabled={!changed || invalid || update.isPending}>
              Save without applying
            </Button>
            <Button onClick={() => submit(true)} disabled={!changed || invalid || update.isPending} data-testid="radio-apply">
              {update.isPending ? <Spinner className="size-3.5 text-current" /> : null}
              Apply
            </Button>
          </>
        ) : undefined
      }
    >
      <section className="flex items-center justify-between gap-3">
        <div>
          <p className="text-[13px] font-medium">Radio on</p>
          <p className="text-xs text-muted-foreground">Off takes every network on this radio off the air here.</p>
        </div>
        <Switch checked={enabled} disabled={!editable} onCheckedChange={setEnabled} aria-label="Radio on" />
      </section>

      <section className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="section-label">Channel</p>
          <Segmented
            size="xs"
            ariaLabel="Channel mode"
            value={channelMode}
            onChange={(mode) => editable && setChannelMode(mode)}
            options={[
              { id: 'auto', label: 'Auto' },
              { id: 'fixed', label: 'Fixed' },
            ]}
          />
        </div>
        {channelMode === 'auto' ? (
          <RadioChannelPicker
            single={false}
            band={radio.band}
            channels={radio.options.channels}
            current={radio.current.channel}
            allowed={allowed}
            onAllowedChange={setAllowed}
            disabled={!editable}
          />
        ) : (
          <RadioChannelPicker
            single
            band={radio.band}
            channels={radio.options.channels}
            current={radio.current.channel}
            value={channel}
            onChange={setChannel}
            disabled={!editable}
          />
        )}
      </section>

      <section className="space-y-2">
        <p className="section-label">Width</p>
        <Segmented
          size="xs"
          ariaLabel="Channel width"
          value={String(width ?? widths[0])}
          className="w-fit"
          onChange={(w) => editable && setWidth(Number(w))}
          options={widths.map((w) => ({ id: String(w), label: widthLabel(w) }))}
        />
        <p className="text-xs text-muted-foreground">
          {radio.band === '2g'
            ? '20 MHz is the neighbourly choice on 2.4 GHz: there are only three channels that do not overlap.'
            : 'Wider is faster up close; narrower reaches further and shares better with neighbours.'}
        </p>
      </section>

      <section className="space-y-2">
        <p className="section-label">Transmit power</p>
        <RadioPower value={tx} onChange={setTx} maxDbm={radio.options.txpowerMaxDbm} disabled={!editable} />
      </section>

      {editable ? (
        <section className="space-y-1.5 rounded-md border border-border bg-muted/30 p-3" aria-live="polite">
          <p className="section-label">What happens</p>
          {!changed ? (
            <p className="text-xs text-muted-foreground">Nothing changed yet.</p>
          ) : (
            <ul className="space-y-1 text-xs">
              {!enabled && radio.enabled ? (
                <Impact icon={<WifiSlash weight="bold" className="text-status-serious" />}>
                  {radio.networks.length > 0
                    ? `${plural(radio.networks.length, 'network')} go${radio.networks.length === 1 ? 'es' : ''} off the air on ${apName}`
                    : 'No network is on this radio'}
                  {clients ? `: ${plural(clients, 'client')} disconnect.` : '.'}
                </Impact>
              ) : (
                <Impact icon={<ArrowsClockwise weight="bold" className="text-status-warning" />}>
                  The radio restarts:{' '}
                  {clients === null
                    ? 'devices on it reconnect.'
                    : clients === 0
                      ? 'no clients on it now.'
                      : `all ${plural(clients, 'client')} on it reconnect.`}
                </Impact>
              )}
              {dfsFixed || (dfsAuto && patch.channelMode !== undefined) ? (
                <Impact icon={<Crosshair weight="bold" className="text-status-warning" />}>
                  Radar check: the radio stays silent for up to {durationText(dfsFixed ?? 60)} after the change.
                </Impact>
              ) : null}
              <Impact icon={<Info weight="bold" className="text-muted-foreground" />}>
                If {apName} does not check in within the confirm window, it restores its previous settings by itself.
              </Impact>
            </ul>
          )}
        </section>
      ) : null}

      {issues.length > 0 ? <IssueList issues={issues} /> : null}
      <ErrorLine message={update.error ? wifiRefusalMessage(update.error) : null} />
    </EditorSheet>
  )
}
