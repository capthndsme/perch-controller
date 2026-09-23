import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Broadcast, Devices, MagnifyingGlass, WifiHigh } from '@phosphor-icons/react'
import { useDevices } from '@/hooks/use-devices'
import { useWifiClients, useWifiOverview } from '@/hooks/use-wifi'
import { deviceDisplayName, deviceSearchText } from '@/lib/device-names'
import { macPath } from '@/lib/traffic'
import { cn } from '@/lib/utils'

type SearchHit = {
  kind: 'device' | 'wifi-client' | 'ssid'
  id: string
  title: string
  subtitle: string
  to: string
}

const SEARCH_WINDOW = { kind: 'relative', range: '24h' } as const

/**
 * Global search over what the API already knows: devices (hostname / IP /
 * MAC), WiFi clients and SSIDs. Results are matched client-side against the
 * loaded lists; Enter or click navigates to the entity's page.
 */
export function GlobalSearch({ className }: { className?: string }) {
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // Lists are only fetched once the box is focused, so the search costs
  // nothing on pages that already load them (react-query dedupes).
  const devices = useDevices({ window: SEARCH_WINDOW, refreshInterval: null, enabled: open })
  const clients = useWifiClients({ refreshInterval: null, activeOnly: false, enabled: open })
  const overview = useWifiOverview({ window: SEARCH_WINDOW, refreshInterval: null, enabled: open })

  const hits = useMemo<SearchHit[]>(() => {
    const q = query.trim().toLowerCase()
    if (q.length < 2) return []
    const out: SearchHit[] = []
    const seenDevices = new Set<string>()
    for (const device of devices.data ?? []) {
      const mac = device.mac.toLowerCase()
      const hay = deviceSearchText(device)
      if (!hay.includes(q) || seenDevices.has(mac)) continue
      seenDevices.add(mac)
      out.push({
        kind: 'device',
        id: `d:${mac}`,
        title: deviceDisplayName(device),
        subtitle: [device.primaryIp, device.mac].filter(Boolean).join(' · '),
        to: `/devices/${macPath(device.mac)}`,
      })
    }
    for (const client of clients.data ?? []) {
      const mac = client.mac.toLowerCase()
      if (seenDevices.has(mac)) continue
      const hay = [deviceSearchText(client), client.ssid ?? '', client.ap].join(' ').toLowerCase()
      if (!hay.includes(q)) continue
      out.push({
        kind: 'wifi-client',
        id: `w:${mac}`,
        title: deviceDisplayName(client),
        subtitle: `${client.ap} · ${client.ssid ?? 'unknown SSID'} · ${client.mac}`,
        to: `/wifi/clients/${macPath(client.mac)}`,
      })
    }
    for (const ssid of overview.data?.ssids ?? []) {
      if (!ssid.ssid.toLowerCase().includes(q)) continue
      out.push({
        kind: 'ssid',
        id: `s:${ssid.ssid}`,
        title: ssid.ssid,
        subtitle: `${ssid.clientCount} clients · ${ssid.accessPoints.join(', ')}`,
        to: `/wifi/ssids/${encodeURIComponent(ssid.ssid)}`,
      })
    }
    return out.slice(0, 12)
  }, [query, devices.data, clients.data, overview.data])

  // Keyboard shortcut: "/" focuses the box from anywhere.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
      event.preventDefault()
      inputRef.current?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (!open) return
    const onClick = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onClick)
    return () => window.removeEventListener('mousedown', onClick)
  }, [open])

  const go = (hit: SearchHit | undefined) => {
    if (!hit) return
    setOpen(false)
    setQuery('')
    navigate(hit.to)
  }

  const showResults = open && query.trim().length >= 2

  return (
    <div ref={containerRef} className={cn('relative', className)}>
      <div className="flex h-8 items-center gap-2 rounded-md border border-border bg-background px-2.5 text-sm focus-within:border-ring">
        <MagnifyingGlass className="size-4 shrink-0 text-muted-foreground" />
        <input
          ref={inputRef}
          type="search"
          value={query}
          placeholder="Search devices, IPs, MACs, SSIDs…"
          className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
          onFocus={() => setOpen(true)}
          onChange={(event) => {
            setQuery(event.target.value)
            setActive(0)
            setOpen(true)
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              setActive((index) => Math.min(index + 1, Math.max(hits.length - 1, 0)))
            } else if (event.key === 'ArrowUp') {
              event.preventDefault()
              setActive((index) => Math.max(index - 1, 0))
            } else if (event.key === 'Enter') {
              event.preventDefault()
              go(hits[active])
            } else if (event.key === 'Escape') {
              setOpen(false)
              inputRef.current?.blur()
            }
          }}
          aria-label="Global search"
          aria-expanded={showResults}
          aria-controls="global-search-results"
        />
        <kbd className="hidden rounded border border-border px-1 text-[10px] text-muted-foreground sm:block">/</kbd>
      </div>
      {showResults ? (
        <div
          id="global-search-results"
          role="listbox"
          className="absolute left-0 right-0 top-full z-50 mt-1 max-h-96 overflow-auto rounded-md border border-border bg-popover p-1 shadow-lg"
        >
          {hits.length === 0 ? (
            <p className="px-2 py-3 text-xs text-muted-foreground">
              {devices.isPending || clients.isPending ? 'Searching…' : 'No matches.'}
            </p>
          ) : (
            hits.map((hit, index) => (
              <button
                key={hit.id}
                type="button"
                role="option"
                aria-selected={index === active}
                data-prefetch-href={hit.to}
                onMouseEnter={() => setActive(index)}
                onClick={() => go(hit)}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded px-2 py-1.5 text-left',
                  index === active ? 'bg-muted' : 'hover:bg-muted/60',
                )}
              >
                {hit.kind === 'device' ? (
                  <Devices className="size-4 shrink-0 text-muted-foreground" />
                ) : hit.kind === 'wifi-client' ? (
                  <WifiHigh className="size-4 shrink-0 text-muted-foreground" />
                ) : (
                  <Broadcast className="size-4 shrink-0 text-muted-foreground" />
                )}
                <span className="min-w-0">
                  <span className="block truncate text-[13px] font-medium">{hit.title}</span>
                  <span className="block truncate font-mono text-[11px] text-muted-foreground">
                    {hit.subtitle}
                  </span>
                </span>
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  )
}
