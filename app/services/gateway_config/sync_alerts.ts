import Collector from '#models/collector'
import type Gateway from '#models/gateway'
import User from '#models/user'
import { emitAlertEvent, type EmitInput } from '#services/alerts/emit'
import logger from '@adonisjs/core/services/logger'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'

/**
 * The gateway-sync area's notices (catalogue `alerts/catalogue/gateway_sync.ts`,
 * design gateway-sync README 14). The services call these after a write
 * succeeded; the conditions (DDNS, silent WireGuard peers) come from the
 * `gateway_sync` detector instead. Emitting never throws; the same key within
 * a rule's dedupe window merges into one notice.
 */

const SOURCE = 'gateway_sync'

function userName(user: Pick<User, 'fullName' | 'email'> | null): string | null {
  if (!user) return null
  return user.fullName?.trim() || user.email
}

async function gatewayName(gateway: Pick<Gateway, 'id' | 'collectorId'>): Promise<string> {
  if (gateway.collectorId === null) return `Gateway ${gateway.id}`
  const collector = await Collector.find(gateway.collectorId)
  return collector?.name ?? `Gateway ${gateway.id}`
}

/** Builds the event (which may read a name) and emits it; a failed read never fails the write. */
async function emitSafely(type: string, build: () => Promise<EmitInput>): Promise<void> {
  try {
    emitAlertEvent(await build())
  } catch (error) {
    logger.warn({ err: error, type }, 'gateway_sync: alert not emitted')
  }
}

/** A new WireGuard peer: remote access into the LAN (warning, pushed by default). */
export async function alertWgPeerAdded(
  gateway: Pick<Gateway, 'id' | 'collectorId'>,
  user: Pick<User, 'fullName' | 'email'>,
  peer: { interface: string; label: string; publicKey: string; perchId: string }
): Promise<void> {
  await emitSafely('gateway.wireguard.peer_added', async () => ({
    type: 'gateway.wireguard.peer_added',
    subject: { kind: 'gateway', id: gateway.id },
    dedupeKey: `gateway.wireguard.peer_added:${gateway.id}:${peer.perchId}`,
    source: SOURCE,
    payload: {
      gatewayId: gateway.id,
      gatewayName: await gatewayName(gateway),
      interface: peer.interface,
      label: peer.label,
      // Enough to recognise the key; the whole key is on the VPN page.
      publicKeyPrefix: peer.publicKey.slice(0, 8),
      userName: userName(user),
    },
  }))
}

export async function alertWgKeyRotated(
  gateway: Pick<Gateway, 'id' | 'collectorId'>,
  user: Pick<User, 'fullName' | 'email'>,
  iface: { name: string; perchId: string }
): Promise<void> {
  await emitSafely('gateway.wireguard.key_rotated', async () => ({
    type: 'gateway.wireguard.key_rotated',
    subject: { kind: 'gateway', id: gateway.id },
    dedupeKey: `gateway.wireguard.key_rotated:${gateway.id}:${iface.perchId}`,
    source: SOURCE,
    payload: {
      gatewayId: gateway.id,
      gatewayName: await gatewayName(gateway),
      interface: iface.name,
      userName: userName(user),
    },
  }))
}

/** "Keep anyway": a change kept although the router's checks had not passed. */
export async function alertChecksOverridden(
  gateway: Pick<Gateway, 'id' | 'collectorId'>,
  userId: number | null,
  applyKey: string
): Promise<void> {
  await emitSafely('gateway.apply.checks_overridden', async () => ({
    type: 'gateway.apply.checks_overridden',
    subject: { kind: 'gateway', id: gateway.id },
    dedupeKey: `gateway.apply.checks_overridden:${gateway.id}:${applyKey}`,
    source: SOURCE,
    payload: {
      gatewayId: gateway.id,
      gatewayName: await gatewayName(gateway),
      applyId: applyKey,
      userName: userName(userId === null ? null : await User.find(userId)),
    },
  }))
}

/** Settings → Gateway sync: multi-WAN writes switched on (owner decision 12 superseded). */
export function alertMultiwanWritesEnabled(user: Pick<User, 'fullName' | 'email'>): void {
  emitAlertEvent({
    type: 'gateway.multiwan.writes_enabled',
    subject: { kind: 'controller' },
    dedupeKey: 'gateway.multiwan.writes_enabled',
    source: SOURCE,
    payload: { userName: userName(user) },
  })
}

/** The delegated IPv6 prefix of an uplink (or its companion) changed. */
export function alertIpv6PrefixChanged(
  gatewayId: number,
  network: string,
  before: string[],
  after: string[]
): void {
  emitAlertEvent({
    type: 'gateway.ipv6.prefix_changed',
    subject: { kind: 'gateway', id: gatewayId },
    dedupeKey: `gateway.ipv6.prefix_changed:${gatewayId}:${network}`,
    source: SOURCE,
    payload: { gatewayId, network, before, after },
  })
}

export type OpenedMapping = {
  proto: string
  extPort: number
  intIp: string
  intPort: number
  description: string | null
}

/**
 * Ports a device opened with UPnP / NAT-PMP (setting `upnpOpenedEvents`).
 * Posted after the ingest's transaction commits. At most 20 per report: a
 * burst beyond that is one device's game or torrent client, not news.
 */
export function alertUpnpOpened(
  gatewayId: number,
  opened: OpenedMapping[],
  trx?: TransactionClientContract
): void {
  for (const m of opened.slice(0, 20)) {
    emitAlertEvent({
      type: 'gateway.upnp.mapping_opened',
      subject: { kind: 'gateway', id: gatewayId },
      dedupeKey: `gateway.upnp.mapping_opened:${gatewayId}:${m.proto}:${m.extPort}:${m.intIp}:${m.intPort}`,
      source: SOURCE,
      trx,
      payload: {
        gatewayId,
        proto: m.proto,
        externalPort: m.extPort,
        internalIp: m.intIp,
        internalPort: m.intPort,
        description: m.description,
      },
    })
  }
}
