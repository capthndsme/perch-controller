import { Link } from 'react-router-dom'
import { CaretRight, Crosshair, Globe, UsersThree } from '@phosphor-icons/react'
import { ToneBadge } from '@/components/gateway-config/bits'
import { STATUS_META } from '@/lib/gateway-config'
import { AP_MODE_META, channelText, isDfsChannel, txpowerText, widthLabel } from '@/lib/wifi-config'
import { cn } from '@/lib/utils'
import type { ApConfig, Band, WifiRadio } from '@/types/wifi-config'

const BAND_SHORT: Record<Band, string> = { '2g': '2.4', '5g': '5', '6g': '6' }

function BandBadge({ band, off }: { band: Band | null; off: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'grid size-9 shrink-0 place-items-center rounded-lg border font-mono text-[11px] font-semibold',
        off ? 'border-border bg-muted/40 text-muted-foreground' : 'border-brand/30 bg-brand/10 text-brand',
      )}
    >
      {band ? BAND_SHORT[band] : '?'}
    </span>
  )
}

function RadioRow({
  radio,
  cacLeft,
  clients,
  onEdit,
}: {
  radio: WifiRadio
  cacLeft: number | null
  clients: number | null
  onEdit: () => void
}) {
  const off = !radio.enabled || !radio.present
  const dfs = isDfsChannel(radio, radio.current.channel ?? radio.channel)
  const statusMeta = radio.status !== 'in_sync' ? STATUS_META[radio.status] : null
  return (
    <li>
      <button
        type="button"
        onClick={onEdit}
        className={cn(
          'flex w-full items-start gap-3 px-4 py-3 text-left select-none [-webkit-touch-callout:none]',
          'transition-colors duration-base hover:bg-muted/30 active:bg-muted/60 active:duration-0',
          !radio.present && 'opacity-60',
        )}
        data-testid="radio-row"
      >
        <BandBadge band={radio.band} off={off} />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13px] font-semibold">{radio.band ? `${BAND_SHORT[radio.band]} GHz` : 'Radio'}</span>
            <span className="font-mono text-[11px] text-muted-foreground">{radio.section}</span>
            {!radio.present ? <ToneBadge tone="neutral">Not present</ToneBadge> : !radio.enabled ? <ToneBadge tone="neutral">Off</ToneBadge> : null}
            {statusMeta ? <ToneBadge tone={statusMeta.tone}>{statusMeta.label}</ToneBadge> : null}
            {radio.protected ? <ToneBadge tone="serious">Uplink</ToneBadge> : null}
          </div>
          {radio.present ? (
            <>
              <p className="text-xs">
                <span className="font-medium">Channel {channelText(radio)}</span>
                <span className="text-muted-foreground"> · {widthLabel(radio.width)} · {txpowerText(radio)}</span>
              </p>
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                {radio.current.channel ? (
                  <span className="font-mono">
                    now ch {radio.current.channel}
                    {radio.current.htmode ? ` ${radio.current.htmode}` : ''}
                    {radio.current.txpowerDbm !== null ? ` · ${radio.current.txpowerDbm} dBm` : ''}
                  </span>
                ) : (
                  <span>not on the air</span>
                )}
                {radio.current.utilization !== null ? <span>{Math.round(radio.current.utilization)}% busy</span> : null}
                {clients !== null ? (
                  <span className="inline-flex items-center gap-0.5">
                    <UsersThree aria-hidden className="size-3" />
                    {clients}
                  </span>
                ) : null}
                {dfs ? (
                  <ToneBadge tone={cacLeft !== null ? 'warning' : 'neutral'}>
                    <Crosshair aria-hidden weight="bold" className="size-3 text-status-warning" />
                    {cacLeft !== null ? `Radar check ${cacLeft} s left` : 'DFS'}
                  </ToneBadge>
                ) : null}
              </p>
              {radio.networks.length > 0 ? (
                <p className="truncate text-[11px] text-muted-foreground">{radio.networks.map((n) => n.name).join(' · ')}</p>
              ) : null}
            </>
          ) : (
            <p className="text-xs text-muted-foreground">
              A leftover radio section in the access point’s config: Perch never puts networks on it. Tidy it up in LuCI.
            </p>
          )}
        </div>
        <CaretRight aria-hidden className="mt-2.5 size-3.5 shrink-0 text-muted-foreground" />
      </button>
    </li>
  )
}

/**
 * One access point's radios (dashboard.md 1.3): a row per radio with its
 * band, channel, width, power and what it runs now (as ACS chose it,
 * utilisation, a radar check counting down); stale radios greyed. A row opens
 * the radio editor.
 */
export function RadioApCard({
  ap,
  radios,
  clientsByRadio,
  onEdit,
}: {
  ap: ApConfig
  radios: WifiRadio[]
  clientsByRadio: Map<string, number>
  onEdit: (radio: WifiRadio) => void
}) {
  const cac = new Map<string, number>()
  for (const r of ap.pendingApply?.health?.radios ?? ap.health?.radios ?? []) {
    if (r.dfs?.cacActive) cac.set(r.section, r.dfs.cacSecondsLeft)
  }
  const sorted = [...radios].sort(
    (a, b) => Number(b.present) - Number(a.present) || (a.band ?? '').localeCompare(b.band ?? '') || a.section.localeCompare(b.section),
  )
  return (
    <section className="card-surface overflow-hidden" data-testid="radio-ap-card">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <span
            aria-label={ap.online ? 'Online' : 'Offline'}
            className={cn('size-2 shrink-0 rounded-full', ap.online ? 'bg-status-good' : 'bg-muted-foreground/50')}
          />
          <h2 className="truncate text-[13px] font-semibold">{ap.name}</h2>
          <ToneBadge tone={AP_MODE_META[ap.mode].tone} title={AP_MODE_META[ap.mode].hint}>
            {AP_MODE_META[ap.mode].label}
          </ToneBadge>
          {ap.country.effective ? (
            <ToneBadge tone="neutral" title="Country the radios run with">
              <Globe aria-hidden className="size-3" />
              {ap.country.effective}
            </ToneBadge>
          ) : null}
        </div>
        <Link
          to={`/wifi/sync/${ap.apId}`}
          className="text-xs font-medium text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
        >
          Config
        </Link>
      </header>
      <ul className="divide-y divide-border/70">
        {sorted.map((radio) => (
          <RadioRow
            key={radio.section}
            radio={radio}
            cacLeft={cac.get(radio.section) ?? null}
            clients={clientsByRadio.get(`${ap.apId}:${radio.section}`) ?? null}
            onEdit={() => onEdit(radio)}
          />
        ))}
        {sorted.length === 0 ? <li className="px-4 py-3 text-xs text-muted-foreground">No radios reported yet.</li> : null}
      </ul>
    </section>
  )
}
