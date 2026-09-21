import Collector from '#models/collector'
import { apiKeyFingerprint } from '#services/collector_announce'
import { probeCollector, type ProbeOptions } from '#services/collector_probe'
import { DateTime } from 'luxon'

export type DefaultCollectorOptions = {
  baseUrl: string
  apiKey?: string | null
  name?: string
  pollIntervalSeconds?: number
  /** Test seam, forwarded to the probe. */
  fetcher?: ProbeOptions['fetcher']
}

export type DefaultCollectorResult =
  | { action: 'skipped'; reason: 'exists' | 'ambiguous' }
  | { action: 'updated'; id: number; previousBaseUrl: string | null }
  | { action: 'created'; id: number; ok: boolean; error?: string }

/**
 * Registers the collector named by COLLECTOR_URL / COLLECTOR_API_KEY, so a
 * packaged deployment (Docker compose) never asks the user to type the
 * collector address into the setup wizard. The probe result is stored like
 * the wizard does; an unreachable collector is still saved so the poller
 * keeps retrying and the dashboard can show why.
 *
 * The row this variable owns is marked `source = 'env'`. That marker is the
 * whole point: once collectors can announce themselves, "there is exactly
 * one row" stopped being a safe proxy for "the row I own" — a router that
 * announced and was adopted would otherwise be yanked to the compose
 * address on the next boot. Precedence, in order:
 *
 *   1. a row already at this address        → take ownership of it: mark it
 *                                             `env`, and if it is sitting
 *                                             `pending`/`dismissed` adopt
 *                                             and enable it. COLLECTOR_URL
 *                                             IS the operator's decision to
 *                                             poll that address, so a row
 *                                             the daemon announced into
 *                                             first must not be left
 *                                             un-polled.
 *   2. a row with `source = 'env'`          → move it; exact ownership
 *   3. exactly one row, and it is `manual`  → move it and mark it ours;
 *                                             the upgrade path for every
 *                                             install that exists today
 *   4. only `announced` rows (or none)      → create our own row
 *   5. anything else                        → `ambiguous`; touch nothing
 */
export async function ensureDefaultCollector(
  options: DefaultCollectorOptions
): Promise<DefaultCollectorResult> {
  const baseUrl = options.baseUrl.replace(/\/+$/, '')
  const apiKey = options.apiKey?.trim() || null

  const existing = await Collector.all()

  const atAddress = existing.find((row) => row.baseUrl === baseUrl)
  if (atAddress) {
    const wasUnadopted = atAddress.lifecycle !== 'adopted'
    if (wasUnadopted) {
      // The collector announced itself before the server booted (or an admin
      // dismissed it and then set COLLECTOR_URL). Configuring the address is
      // the adoption decision; leaving the row pending would mean the
      // packaged deployment silently collects nothing.
      atAddress.lifecycle = 'adopted'
      atAddress.enabled = true
    }
    if (atAddress.source !== 'env') atAddress.source = 'env'
    if (atAddress.$isDirty) await atAddress.save()
    return wasUnadopted
      ? { action: 'updated', id: atAddress.id, previousBaseUrl: atAddress.baseUrl }
      : { action: 'skipped', reason: 'exists' }
  }

  const owned = existing.find((row) => row.source === 'env')
  if (owned) return moveCollector(owned, baseUrl, apiKey)

  if (existing.length === 1 && existing[0].source === 'manual') {
    existing[0].source = 'env'
    return moveCollector(existing[0], baseUrl, apiKey)
  }

  if (existing.every((row) => row.source === 'announced')) {
    return createCollector(baseUrl, apiKey, options)
  }

  return { action: 'skipped', reason: 'ambiguous' }
}

async function moveCollector(
  row: Collector,
  baseUrl: string,
  apiKey: string | null
): Promise<DefaultCollectorResult> {
  const previousBaseUrl = row.baseUrl
  row.baseUrl = baseUrl
  // COLLECTOR_URL is an address to poll.
  row.transport = 'poll'
  if (apiKey) {
    row.apiKey = apiKey
    row.apiKeyFingerprint = apiKeyFingerprint(apiKey)
  }
  await row.save()
  return { action: 'updated', id: row.id, previousBaseUrl }
}

async function createCollector(
  baseUrl: string,
  apiKey: string | null,
  options: DefaultCollectorOptions
): Promise<DefaultCollectorResult> {
  const status = await probeCollector(baseUrl, { apiKey, fetcher: options.fetcher })

  const collector = await Collector.create({
    name: options.name ?? 'Default collector',
    baseUrl,
    apiKey,
    apiKeyFingerprint: apiKey ? apiKeyFingerprint(apiKey) : null,
    pollIntervalSeconds: options.pollIntervalSeconds ?? 5,
    enabled: true,
    source: 'env',
    lifecycle: 'adopted',
    captureInterface: status.captureInterface ?? null,
    version: status.version ?? null,
    lastSeenAt: status.ok ? DateTime.fromISO(status.checkedAt) : null,
    lastStatus: status,
  })

  return { action: 'created', id: collector.id, ok: status.ok, error: status.error }
}
