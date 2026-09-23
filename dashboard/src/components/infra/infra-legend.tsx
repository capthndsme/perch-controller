import { Devices, Warning } from '@phosphor-icons/react'
import { PORT_LED_CLASSES, PORT_LED_LABELS, type PortLed } from '@/lib/infra'
import { signalStroke } from '@/lib/infra-overlay'
import { cn } from '@/lib/utils'
import type { WifiSignalQuality } from '@/types/api'

const LEDS: PortLed[] = ['fast', 'slow', 'down', 'unknown', 'missing']

function PortSwatch({ led }: { led: PortLed }) {
  return (
    <span
      aria-hidden
      className={cn(
        'relative inline-block h-[14px] w-[18px] shrink-0 rounded-[3px] border bg-muted/80',
        led === 'missing' ? 'border-dashed border-status-critical' : 'border-foreground/30',
      )}
    >
      <span className={cn('absolute inset-x-[2px] top-[2px] h-[3px] rounded-full', PORT_LED_CLASSES[led])} />
    </span>
  )
}

type CableSample = { label: string; stroke: string; opacity: number; dash?: string; animated?: boolean }

const CABLES: CableSample[] = [
  { label: 'Ethernet, up', stroke: 'var(--foreground)', opacity: 0.72 },
  { label: 'Fiber', stroke: 'var(--series-4)', opacity: 1 },
  { label: 'Down', stroke: 'var(--muted-foreground)', opacity: 0.6 },
  { label: 'Virtual or unknown', stroke: 'var(--muted-foreground)', opacity: 0.8, dash: '2 5' },
  { label: 'Wireless', stroke: 'var(--foreground)', opacity: 0.72, dash: '5 5' },
]

function CableSwatch({ sample }: { sample: CableSample }) {
  return (
    <svg aria-hidden width="28" height="8" className="shrink-0">
      <line
        x1="2"
        y1="4"
        x2="26"
        y2="4"
        stroke={sample.stroke}
        strokeOpacity={sample.opacity}
        strokeWidth="2"
        strokeDasharray={sample.dash}
        strokeLinecap={sample.dash ? 'round' : undefined}
      />
    </svg>
  )
}

// The overlay's wireless lines, in the signal palette of `wifiSignalQualityDotClass`.
const SIGNALS: Array<{ label: string; quality: WifiSignalQuality | null }> = [
  { label: 'Excellent / very good', quality: 'excellent' },
  { label: 'Good / fair', quality: 'good' },
  { label: 'Weak / very weak', quality: 'weak' },
  { label: 'Unknown', quality: null },
]

/**
 * What the port lights and the cable strokes mean; sits under the map. With
 * the WiFi clients overlay on, also its chips and lines (A4.4), with how many
 * clients it shows.
 */
export function InfraLegend({ className, wifi }: { className?: string; wifi?: { summary: string } | null }) {
  return (
    <div className={cn('flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-muted-foreground', className)}>
      <span className="section-label">Ports</span>
      {LEDS.map((led) => (
        <span key={led} className="inline-flex items-center gap-1.5">
          <PortSwatch led={led} />
          {PORT_LED_LABELS[led]}
        </span>
      ))}
      <span className="section-label sm:ml-2">Cables</span>
      {CABLES.map((sample) => (
        <span key={sample.label} className="inline-flex items-center gap-1.5">
          <CableSwatch sample={sample} />
          {sample.label}
        </span>
      ))}
      <span className="inline-flex items-center gap-1 font-medium text-status-critical">
        <Warning aria-hidden weight="fill" className="size-3" />
        Mismatch: the two ends disagree
      </span>
      {wifi ? (
        <>
          <span className="section-label sm:ml-2" data-legend-wifi>
            WiFi
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span
              aria-hidden
              className="inline-flex h-3.5 w-6 items-center justify-center rounded-[3px] border border-border bg-card"
            >
              <Devices className="size-2.5" />
            </span>
            Client (not saved on the map)
          </span>
          {SIGNALS.map((sample) => (
            <span key={sample.label} className="inline-flex items-center gap-1.5">
              <CableSwatch
                sample={{ label: sample.label, stroke: signalStroke(sample.quality), opacity: 0.95, dash: '5 4' }}
              />
              {sample.label}
            </span>
          ))}
          <span>{wifi.summary}</span>
        </>
      ) : null}
    </div>
  )
}
