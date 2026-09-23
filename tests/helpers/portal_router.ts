import {
  type PortalGatewayKeys,
  gatewayKeysFrom,
  offlineVoucherVerifier,
  signEnvelope,
  signGrant,
  signGroup,
} from '#services/portal/crypto'
import { normalizeVoucherCode } from '#services/portal/codes'
import { FakeCollector, TEST_API_KEY, TEST_INSTANCE_ID } from '#tests/helpers/collector_agent'

/**
 * A scripted router for the portal socket suites (docs/gateway/portal.md
 * section 13): a `FakeCollector` whose `portal.*` handlers keep a small
 * model of what perch-collector's portal engine holds: the gateway key,
 * grants, groups, the offline voucher list, an event journal and outside
 * authorizations. It verifies every envelope and item signature with the key
 * it was handed, as the real router does, and records what it received.
 */

type Grant = {
  grantId: number | null
  localRef: string | null
  portalId: number
  groupKey: string
  mac: string
  expiresAt: number | null
  revision: number
  state: 'active' | 'pending_device' | 'paused'
  bytesUp: number
  bytesDown: number
  activeSeconds: number
  createdSeq: number
}

export type RouterEventInput = Record<string, unknown> & { type: string; mac: string }

export class FakePortalRouter {
  collector!: FakeCollector
  keys: PortalGatewayKeys | null = null
  gatewayId: number | null = null
  configRevision: number | null = null
  config: Record<string, unknown> | null = null
  grants: Grant[] = []
  groups = new Map<string, Record<string, unknown>>()
  vouchers: Array<Record<string, unknown>> = []
  vouchersEnabled = true
  events: Array<Record<string, unknown>> = []
  lastSeq = 0
  externals: Array<{ portalId: number | null; mac: string }> = []
  /** MACs that are "on the network": their grants go active at once. */
  present = new Set<string>()
  nonces = new Set<string>()
  templates = new Map<string, unknown>()
  /** Methods that fail once with a timeout (no answer) or an error code. */
  failNext = new Map<string, 'hang' | string>()
  signatureFailures = 0

  instanceId = TEST_INSTANCE_ID
  apiKey = TEST_API_KEY

  static async connect(
    options: {
      keys?: { gatewayId: number; epoch: number; key: Buffer }
      instanceId?: string
      apiKey?: string
    } = {}
  ): Promise<FakePortalRouter> {
    const router = new FakePortalRouter()
    router.instanceId = options.instanceId ?? TEST_INSTANCE_ID
    router.apiKey = options.apiKey ?? TEST_API_KEY
    if (options.keys) {
      router.gatewayId = options.keys.gatewayId
      router.keys = gatewayKeysFrom(options.keys.key, options.keys.gatewayId, options.keys.epoch)
    }
    router.collector = await router.#dial()
    return router
  }

  /** A second session with this router's state (a reconnect). */
  async reconnect(): Promise<void> {
    await this.collector.close()
    this.collector = await this.#dial()
  }

  #dial() {
    return FakeCollector.connect({
      handlers: this.handlers(),
      instanceId: this.instanceId,
      apiKey: this.apiKey,
    })
  }

  hello(extra: Record<string, unknown> = {}) {
    return this.collector.hello({
      instanceId: this.instanceId,
      apiKey: this.apiKey,
      capabilities: ['gateway_stats', 'portal'],
      portal: {
        version: 1,
        keyEpoch: this.keys?.epoch ?? null,
        configRevision: this.configRevision,
        enforcement: { nft: true, egress: true, fw4Include: 'ok', nftset: true, conntrack: true },
        storage: { path: '/etc/perch-collector/portal', kind: 'spi_flash' },
        port: 2080,
        maxPortals: 16,
      },
      ...extra,
    })
  }

  calls(method: string) {
    return this.collector.calls.filter((c) => c.method === method)
  }

  methods(): string[] {
    return this.collector.calls.map((c) => c.method).filter((m) => m.startsWith('portal.'))
  }

  grant(mac: string): Grant | undefined {
    return this.grants.find((g) => g.mac === mac)
  }

  journal(event: RouterEventInput) {
    this.lastSeq += 1
    this.events.push({ seq: this.lastSeq, at: Date.now(), portalId: null, ...event })
    return this.lastSeq
  }

  /** The router redeems a held voucher by itself (controller unreachable). */
  redeemOffline(portalId: number, mac: string, code: string, localRef: string) {
    if (!this.keys) throw new Error('no key')
    const verifier = offlineVoucherVerifier(this.keys, normalizeVoucherCode(code)!)
    const v = this.vouchers.find((x) => x.verifier === verifier)
    if (!v) return false
    const now = Date.now()
    const expiresAt =
      v.durationMode === 'wall_clock' && v.durationSeconds !== null && v.expiresAt === null
        ? now + Number(v.durationSeconds) * 1000
        : null
    const seq = this.journal({
      type: 'offline_redeemed',
      portalId,
      mac,
      voucherId: v.voucherId,
      localRef,
      placement: 'current',
      startsAt: expiresAt === null ? null : now,
      expiresAt,
    })
    this.grants.push({
      grantId: null,
      localRef,
      portalId,
      groupKey: `v:${v.voucherId}`,
      mac,
      expiresAt: null,
      revision: 0,
      state: 'active',
      bytesUp: 0,
      bytesDown: 0,
      activeSeconds: 0,
      createdSeq: seq,
    })
    return true
  }

  #check(kind: 'authorize' | 'deauthorize' | 'vouchers', p: any, items: string[], extra = {}) {
    if (!this.keys) throw rpcError('no_keys')
    if (p.keyEpoch !== this.keys.epoch) throw rpcError('key_epoch_mismatch')
    const want = signEnvelope(this.keys, {
      kind,
      full: p.full ?? (kind === 'vouchers' ? p.enabled : false),
      serverNow: p.serverNow,
      nonce: p.nonce,
      itemSignatures: items,
      ...extra,
    })
    if (want !== p.sig) {
      this.signatureFailures += 1
      throw rpcError('bad_signature')
    }
    if (this.nonces.has(p.nonce)) throw rpcError('replayed')
    this.nonces.add(p.nonce)
  }

  #fail(method: string) {
    const mode = this.failNext.get(method)
    if (!mode) return null
    this.failNext.delete(method)
    if (mode === 'hang') return new Promise(() => {})
    throw rpcError(mode)
  }

  handlers(): Record<string, (params: any) => unknown> {
    return {
      'portal.configure': (p) => {
        this.#fail('portal.configure')
        if (p.keys) {
          this.gatewayId = p.gatewayId
          this.keys = gatewayKeysFrom(
            Buffer.from(p.keys.gatewayKey, 'base64url'),
            p.gatewayId,
            p.keys.epoch
          )
          this.nonces.clear()
        }
        this.config = p
        this.configRevision = p.revision
        return {
          revision: p.revision,
          keyEpoch: this.keys?.epoch ?? null,
          missingTemplates: [],
          portals: (p.portals as any[]).map((x) => ({
            portalId: x.portalId,
            device: `br-${x.network}`,
            state: 'active',
            listen: '192.168.30.1:2080',
            counting: true,
            issues: [],
          })),
          enforcement: { nft: true, egress: true, fw4Include: 'ok', nftset: true, conntrack: true },
          storage: { path: '/etc/perch-collector/portal', kind: 'spi_flash' },
          issues: [],
        }
      },
      'portal.template': (p) => {
        this.templates.set(p.sha256, p.files)
        return { stored: true }
      },
      'portal.authorize': (p) => {
        const hang = this.#fail('portal.authorize')
        if (hang) return hang
        const items = [...p.groups.map((g: any) => g.sig), ...p.grants.map((g: any) => g.sig)]
        this.#check('authorize', p, items, {
          ackedEventSeq: p.ackedEventSeq,
          externals: p.revertExternals,
        })
        for (const g of p.groups) {
          const { sig, ...wire } = g
          if (signGroup(this.keys!, wire) !== sig) throw rpcError('bad_signature')
          this.groups.set(g.groupKey, wire)
        }
        const results = []
        const listed = new Set<Grant>()
        for (const w of p.grants) {
          const { sig, ...wire } = w
          if (signGrant(this.keys!, wire) !== sig) {
            results.push({ grantId: w.grantId, revision: w.revision, state: 'rejected' })
            continue
          }
          let g =
            this.grants.find((x) => w.grantId !== null && x.grantId === w.grantId) ??
            this.grants.find((x) => w.localRef && x.localRef === w.localRef)
          if (!g) {
            g = {
              ...wire,
              state: this.present.has(w.mac) ? 'active' : 'pending_device',
              bytesUp: 0,
              bytesDown: 0,
              activeSeconds: 0,
              createdSeq: 0,
            } as Grant
            this.grants.push(g)
          } else {
            g.grantId = w.grantId
            g.revision = w.revision
            g.expiresAt = w.expiresAt
          }
          listed.add(g)
          results.push({
            grantId: g.grantId,
            localRef: g.localRef ?? undefined,
            revision: g.revision,
            state: g.state === 'paused' ? 'pending_device' : g.state,
          })
        }
        const ended = []
        if (p.full) {
          for (const g of [...this.grants]) {
            if (listed.has(g) || g.createdSeq > p.ackedEventSeq) continue
            ended.push({ grantId: g.grantId, localRef: g.localRef })
            this.grants = this.grants.filter((x) => x !== g)
          }
        }
        // Outside authorizations are undone (decision 25).
        for (const x of p.revertExternals) {
          this.externals = this.externals.filter((e) => e.mac !== x.mac)
        }
        return { results, ended }
      },
      'portal.deauthorize': (p) => {
        this.#check('deauthorize', p, [], { grantIds: p.grantIds, reason: p.reason })
        const ended = this.grants
          .filter((g) => g.grantId !== null && p.grantIds.includes(g.grantId))
          .map((g) => g.grantId)
        this.grants = this.grants.filter(
          (g) => g.grantId === null || !p.grantIds.includes(g.grantId)
        )
        return { ended }
      },
      'portal.vouchers': (p) => {
        this.#check(
          'vouchers',
          p,
          p.vouchers.map((v: any) => v.sig),
          { reason: p.append ? 'append' : null }
        )
        this.vouchersEnabled = p.enabled
        this.vouchers = p.append ? [...this.vouchers, ...p.vouchers] : p.vouchers
        return { stored: p.vouchers.length, rejected: 0 }
      },
      'portal.sync': (p) => {
        const hang = this.#fail('portal.sync')
        if (hang) return hang
        return {
          lastEventSeq: this.lastSeq,
          truncated: false,
          events: this.events.filter((e) => Number(e.seq) > p.ackedEventSeq),
          grants: this.grants.map((g) => ({
            grantId: g.grantId,
            localRef: g.localRef,
            portalId: g.portalId,
            mac: g.mac,
            ip: '192.168.30.20',
            bytesUp: g.bytesUp,
            bytesDown: g.bytesDown,
            activeSeconds: g.activeSeconds,
            state: g.state,
            lastSeenAt: Date.now(),
            revision: g.grantId === null ? null : g.revision,
          })),
          externals: this.externals.map((x) => ({
            ...x,
            ip: '192.168.30.99',
            since: Date.now(),
            bytesUp: 0,
            bytesDown: 0,
          })),
        }
      },
    }
  }
}

/** A refusal the way perch-collector answers: -32000 with `data.error`. */
function rpcError(code: string) {
  return Object.assign(new Error(code), {
    rpc: { code: -32000, message: code, data: { error: code } },
  })
}
