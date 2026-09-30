import {
  device,
  FakeCollector,
  reading,
  RpcFailure,
  TEST_API_KEY,
  TEST_INSTANCE_ID,
} from '#tests/helpers/collector_agent'
import { signatureMessage } from '#services/gateway_config/rpc_signing'
import {
  derivePairingKey,
  generatePairingKeyPair,
  newPairingNonce,
  pairingCommitment,
  pairingKeyId,
  pairingSas,
  x25519Shared,
} from '#services/gateway_config/pairing_crypto'
import { createHash, createHmac, randomBytes } from 'node:crypto'

/**
 * A scripted OpenWrt gateway agent for the config plane's functional tests
 * (docs/gateway/config-plane.md sections 3.4 and 4): a router's UCI state
 * in memory, the read RPCs (`gateway.capabilities`, `gateway.config.read`),
 * the write RPCs (`gateway.config.apply`, `.confirm`, `.rollback`, `.ack`)
 * with the agent's state machine, the signed envelope of perch-collector's
 * `internal/gwconfig/sign.go`, change notifications with an author, and the
 * drop-and-redial after a commit: the session that received an apply is
 * closed and a fresh one says hello with the pending apply, then pushes.
 */

export const GW_MAC = '02:00:00:00:00:31'

export type Section = {
  name: string
  type: string
  anonymous?: boolean
  options: Record<string, string | string[]>
  secrets?: Record<string, string>
}

type Ledger = { perchId: string; config: string; section: string; domain: string }

type CheckItemParam = { id: string; kind: string; mustPass?: boolean; [key: string]: unknown }
type CheckState = { id: string; state: string; detail: string | null; at: string | null }

type Pending = {
  applyId: string
  kind: string
  gen: number
  deadline: Date
  snapshot: { configs: Record<string, Section[]>; ledger: Ledger[] }
  committed: Record<string, Section[]>
  timer: NodeJS.Timeout
  /** Gateway sync: the apply's checks (protocol.md 1) and where they stand. */
  checks?: {
    items: CheckItemParam[]
    state: string
    results: CheckState[]
    startedAt: string | null
  }
}

type Result = {
  applyId: string
  kind: string
  outcome: string
  reason: string
  at: string
  hashes: Record<string, string>
  discarded?: Record<string, Array<Section & { change: string }>>
  detail?: string
  checks?: Record<string, unknown>
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value))
}

function fail(error: string, message: string, extra: Record<string, unknown> = {}): never {
  throw new RpcFailure(-32000, message, { error, ...extra })
}

export type FakeGatewayOptions = {
  access?: 'none' | 'read' | 'write'
  /** The agent verifies the controller's TLS certificate (`transportOk`). */
  transportOk?: boolean
  /** UCI `config_allow_insecure '1'`. */
  allowInsecure?: boolean
  /** Send `X-Forwarded-Proto: https` from loopback (a trusted proxy): the controller sees TLS. */
  secure?: boolean
  /** The agent's own confirm window, whatever the controller asks. */
  confirmMs?: number
  /** Drop the session and redial after committing (default true). */
  redial?: boolean
  /** Push once after each hello (default true). */
  pushAfterHello?: boolean
  configs?: Record<string, Section[]>
  capabilities?: string[]
  /** The router's effective allowlist (`allowedConfigs`); default: every config it has. */
  allowedConfigs?: string[]
  /** Answer the QoS RPCs (`qos.probe`, `qos.devices.set`) like perch-collector. */
  qos?: boolean
  /** WAN interfaces the pushes' gateway report names (none = no gateway report). */
  wan?: string[]
  /** Gateway sync (protocol.md 4): `gateway.capabilities` `features` (e.g. `config.checks.v1`). */
  features?: string[]
}

export class FakeGateway {
  configs: Record<string, Section[]>
  ledger: Ledger[] = []
  results: Result[] = []
  pending: Pending | null = null
  collector: FakeCollector | null = null
  gen = 0
  challenge = ''
  seq = 1
  bytes = 1000
  readonly calls: Array<{ method: string; params: Record<string, unknown>; signed: boolean }> = []
  readonly nonces = new Set<string>()
  /** Next apply is refused with this code (once). */
  failNextApply: { error: string; message?: string; data?: Record<string, unknown> } | null = null
  /** Next apply answers `stale_base` (once). */
  staleNextApply = false
  /** Next apply fails after its first commit and rolls back (`apply_failed`, `rolledBack`). */
  failNextApplyAfterCommit = false
  /** Changes a router admin makes while an apply waits for its confirm. */
  duringWindow: (() => void) | null = null
  /** Set by `close()`: no timer of this fake dials or pushes any more. */
  closed = false
  /** Installed packages (name → version). */
  packages: Record<string, string> = { dnsmasq: '2.90-r1' }
  /** Gateway sync runtime RPCs it received: `gateway.ddns.update` services, `gateway.upnp.delete` mappings. */
  ddnsUpdates: string[] = []
  upnpDeletes: Array<{ proto: string; extPort: number }> = []
  /** Packages `gateway.package.install` may install. */
  installAllowlist = ['sqm-scripts', 'kmod-sched-cake', 'opennds']
  /** The router's own `config_sign_key` (signing.key says so when set). */
  signKey: string | null = null
  /** A pairing in progress on the router side (owner decision 29). */
  pairPending: {
    pairingId: string
    gatewayId: number
    controllerPub: string
    priv: string
    pub: string
    nonce: string
    key: Buffer | null
    sas: string | null
  } | null = null
  /** `order` ops the router ran (tests assert on them). */
  orderOps: Array<{ config: string; type: string; sections: string[] }> = []
  /** `net.conntrack_flush` calls (README decision 9), and the answer to give. */
  flushes: Array<{ ips: string[] }> = []
  flushAnswer: Record<string, unknown> | null = null
  /** The paired signing key, once the router's admin confirmed the code. */
  pairedKey: { key: Buffer; keyId: string } | null = null
  /**
   * Gateway sync: how the router's apply checks end once the fresh session is
   * up: `pass`, `fail` (then it rolls back at once, reason `checks_failed`)
   * or `hold` (they keep running).
   */
  checksOutcome: 'pass' | 'fail' | 'hold' = 'pass'
  /** Every `gateway.config.checks` notification sent. */
  checkNotes: Array<Record<string, unknown>> = []

  constructor(readonly options: FakeGatewayOptions = {}) {
    this.configs = clone(options.configs ?? { dhcp: [] })
  }

  get access() {
    return this.options.access ?? 'write'
  }
  get transportOk() {
    return this.options.transportOk ?? true
  }

  hash(config: string): string {
    return createHash('sha256')
      .update(JSON.stringify(this.configs[config] ?? []))
      .digest('hex')
  }

  hashes(): Record<string, string> {
    return Object.fromEntries(Object.keys(this.configs).map((c) => [c, this.hash(c)]))
  }

  applyState() {
    if (!this.pending) return { state: 'idle' }
    const checks = this.pending.checks
    return {
      state: 'pending_confirm',
      applyId: this.pending.applyId,
      kind: this.pending.kind,
      deadline: this.pending.deadline.toISOString(),
      ...(checks
        ? {
            checks: {
              state: checks.state,
              startedAt: checks.startedAt,
              timeoutSeconds: 60,
              items: checks.results,
            },
          }
        : {}),
    }
  }

  /** The router's checks run on the fresh session (protocol.md 1.2). */
  #runChecks() {
    const p = this.pending
    const checks = p?.checks
    if (!p || !checks || checks.state !== 'pending' || this.closed) return
    const at = new Date().toISOString()
    checks.startedAt = at
    checks.state = 'running'
    checks.results = checks.items.map((i) => ({
      id: i.id,
      state: 'running',
      detail: null,
      at: null,
    }))
    this.#noteChecks()
    if (this.checksOutcome === 'hold') return
    setTimeout(() => {
      if (this.pending !== p || checks.state !== 'running') return
      const ok = this.checksOutcome === 'pass'
      checks.state = ok ? 'passed' : 'failed'
      checks.results = checks.items.map((i, n) => ({
        id: i.id,
        state: ok || n > 0 ? 'passed' : 'failed',
        detail: ok || n > 0 ? 'ok' : 'no answer from 3 targets',
        at: new Date().toISOString(),
      }))
      this.#noteChecks()
      if (!ok) this.#rollback('checks_failed')
    }, 40)
  }

  #noteChecks() {
    const checks = this.pending?.checks
    if (!checks || !this.collector) return
    const note = {
      applyId: this.pending!.applyId,
      state: checks.state,
      startedAt: checks.startedAt,
      elapsedSeconds: 0.1,
      items: checks.results,
    }
    this.checkNotes.push(note)
    try {
      this.collector.notifyServer('gateway.config.checks', note)
    } catch {
      // closed
    }
  }

  // ── session ────────────────────────────────────────────────────────────

  async connect(): Promise<FakeCollector> {
    this.closed = false
    this.gen++
    this.challenge = randomBytes(16).toString('hex')
    const headers: Record<string, string> = {}
    if (this.options.secure) headers['X-Forwarded-Proto'] = 'https'
    const collector = await FakeCollector.connect({
      headers,
      handlers: this.#handlers(this.gen),
    })
    this.collector = collector
    await collector.hello({
      instanceId: TEST_INSTANCE_ID,
      apiKey: TEST_API_KEY,
      capabilities: this.options.capabilities ?? ['gateway_stats', 'gateway_config'],
      gatewayConfig: {
        protocol: 1,
        access: this.access,
        transportOk: this.transportOk,
        hashes: this.access === 'none' ? {} : this.hashes(),
        apply: this.applyState(),
        results: this.results,
        signing: {
          required: !this.transportOk,
          challenge: this.challenge,
          key: this.signKey ? 'config_sign_key' : this.pairedKey ? 'paired' : 'api_key',
          ...(this.pairedKey ? { keyId: this.pairedKey.keyId } : {}),
          windowSeconds: 300,
        },
        management: {
          network: 'lan',
          device: 'br-lan',
          controllerAddress: '192.168.1.5',
          reportedAt: new Date().toISOString(),
        },
      },
    })
    if (this.options.pushAfterHello !== false) {
      // Give the controller a moment for its after-hello work.
      setTimeout(() => this.push(), 50)
    }
    if (this.pending?.checks?.state === 'pending') setTimeout(() => this.#runChecks(), 80)
    return collector
  }

  push() {
    if (!this.collector || this.closed) return
    this.bytes += 1000
    try {
      this.collector.notifyServer(
        'collector.push',
        reading([device(GW_MAC, { bytesIn: this.bytes, bytesOut: this.bytes })], {
          seq: this.seq++,
          ...(this.options.wan
            ? {
                gateway: {
                  collectedAt: new Date().toISOString(),
                  conntrack: { entries: 10, limit: 65536 },
                  tcpEstablished: 1,
                  load: { load1: 0.1, load5: 0.1, load15: 0.1 },
                  memory: { totalBytes: 1e9, availableBytes: 5e8 },
                  wan: this.options.wan.map((name) => ({
                    name,
                    rxBytes: this.bytes,
                    txBytes: this.bytes,
                  })),
                  wanSource: 'default-route',
                },
              }
            : {}),
        })
      )
    } catch {
      // closed
    }
  }

  /** Closes the current session and dials a fresh one (section 3.4 step 5). */
  async redial(): Promise<void> {
    if (this.closed) return
    const old = this.collector
    this.collector = null
    if (old) await old.close()
    if (this.closed) return
    await this.connect()
  }

  /** Goes offline: the session closes and no timer dials again (the pending apply stays). */
  async close() {
    this.closed = true
    await this.collector?.close()
    this.collector = null
  }

  /** Ends the fake for good (test teardown). */
  async destroy() {
    await this.close()
    if (this.pending) clearTimeout(this.pending.timer)
    this.pending = null
  }

  /** A router-side edit (LuCI or uci), then `gateway.config.changed` with its author. */
  routerEdit(
    config: string,
    edit: (sections: Section[]) => void,
    author: Record<string, unknown> = { kind: 'luci', user: 'root', via: 'trigger' }
  ) {
    const sections = this.configs[config] ?? (this.configs[config] = [])
    edit(sections)
    this.collector?.notifyServer('gateway.config.changed', {
      hashes: this.hashes(),
      changed: [config],
      origin: 'router',
      author,
      at: new Date().toISOString(),
      uncommitted: [],
    })
  }

  // ── RPCs ───────────────────────────────────────────────────────────────

  #handlers(gen: number) {
    const wrap =
      (method: string, fn: (params: Record<string, unknown>, gen: number) => unknown) =>
      (raw: Record<string, unknown>) => {
        const { params, signed } = this.#unwrap(method, raw)
        this.calls.push({ method, params, signed })
        return fn(params, gen)
      }
    const qos: Record<string, (raw: Record<string, unknown>) => unknown> = this.options.qos
      ? {
          'qos.probe': wrap('qos.probe', () => ({
            sqm: { installed: true, version: '1.6.0', luci: false, queues: [] },
            kernel: { htb: true, fq_codel: true, cake: true, ifb: true, clsact: true },
            conflicts: [],
            flowOffload: { software: false, hardware: false },
            lanDevices: [],
            configured: true,
          })),
          'qos.devices.set': wrap('qos.devices.set', (params) => ({
            revision: params.revision,
            accepted: Array.isArray(params.devices) ? params.devices.length : 0,
            rejected: [],
          })),
        }
      : {}
    return {
      ...qos,
      'gateway.capabilities': wrap('gateway.capabilities', () => this.#capabilities()),
      'gateway.config.read': wrap('gateway.config.read', () => this.#read()),
      'net.conntrack_flush': (params: Record<string, unknown>) => {
        this.calls.push({ method: 'net.conntrack_flush', params, signed: false })
        const ips = (params.ips as string[]) ?? []
        this.flushes.push({ ips: [...ips] })
        return (
          this.flushAnswer ?? {
            flushed: true,
            matched: ips.length * 2,
            deleted: ips.length * 2,
            skipped: 0,
          }
        )
      },
      'gateway.config.apply': (raw: Record<string, unknown>) => {
        const { params, signed } = this.#unwrap('gateway.config.apply', raw)
        this.calls.push({ method: 'gateway.config.apply', params, signed })
        this.#writeGate(signed)
        this.#requireManaged()
        return this.#apply(params, gen)
      },
      'gateway.ddns.update': (raw: Record<string, unknown>) => {
        const { params, signed } = this.#unwrap('gateway.ddns.update', raw)
        this.calls.push({ method: 'gateway.ddns.update', params, signed })
        this.#writeGate(signed)
        if (!this.packages['ddns-scripts']) fail('ddns_not_installed', 'ddns-scripts missing')
        const known = (this.configs.ddns ?? []).some(
          (x) => x.type === 'service' && x.name === params.service
        )
        if (!known) fail('ddns_unknown_service', 'no such service')
        this.ddnsUpdates.push(String(params.service))
        return { started: true }
      },
      'gateway.upnp.delete': (raw: Record<string, unknown>) => {
        const { params, signed } = this.#unwrap('gateway.upnp.delete', raw)
        this.calls.push({ method: 'gateway.upnp.delete', params, signed })
        this.#writeGate(signed)
        if (!this.packages.miniupnpd) fail('upnp_not_installed', 'miniupnpd missing')
        const wanted = (params.mappings as Array<{ proto: string; extPort: number }>) ?? []
        for (const m of wanted) this.upnpDeletes.push({ proto: m.proto, extPort: m.extPort })
        return { deleted: wanted.length, notFound: 0, restarted: wanted.length > 0 }
      },
      'gateway.package.install': (raw: Record<string, unknown>) => {
        const { params, signed } = this.#unwrap('gateway.package.install', raw)
        this.calls.push({ method: 'gateway.package.install', params, signed })
        this.#writeGate(signed)
        this.#requireManaged()
        return this.#install(params, gen)
      },
      'gateway.pair.begin': (params: Record<string, unknown>) => {
        this.calls.push({ method: 'gateway.pair.begin', params, signed: false })
        if (this.access !== 'write') fail('not_managed', 'config_access is not write')
        if (this.transportOk) fail('pairing_not_needed', 'verified TLS')
        if (!this.options.allowInsecure) fail('insecure_transport', 'config_allow_insecure is 0')
        const mine = generatePairingKeyPair()
        this.pairPending = {
          pairingId: String(params.pairingId),
          gatewayId: Number(params.gatewayId),
          controllerPub: String(params.controllerPub),
          priv: mine.privateKey,
          pub: mine.publicKey,
          nonce: newPairingNonce(),
          key: null,
          sas: null,
        }
        return {
          pairingId: this.pairPending.pairingId,
          routerPub: mine.publicKey,
          commitment: pairingCommitment(
            this.pairPending.nonce,
            mine.publicKey,
            this.pairPending.controllerPub
          ),
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
        }
      },
      'gateway.pair.reveal': (params: Record<string, unknown>) => {
        this.calls.push({ method: 'gateway.pair.reveal', params, signed: false })
        const p = this.pairPending
        if (!p || p.pairingId !== params.pairingId) fail('unknown_pairing', 'no such pairing')
        const t = {
          gatewayId: p.gatewayId,
          controllerPub: p.controllerPub,
          routerPub: p.pub,
          controllerNonce: String(params.controllerNonce),
          routerNonce: p.nonce,
        }
        p.key = derivePairingKey(x25519Shared(p.priv, p.controllerPub), t)
        p.sas = pairingSas(t)
        return { pairingId: p.pairingId, routerNonce: p.nonce }
      },
      'gateway.pair.status': (params: Record<string, unknown>) => {
        this.calls.push({ method: 'gateway.pair.status', params, signed: false })
        if (
          this.pairedKey &&
          (!this.pairPending || this.pairPending.pairingId === params.pairingId)
        ) {
          return { pairingId: params.pairingId, state: 'paired', keyId: this.pairedKey.keyId }
        }
        if (this.pairPending?.pairingId === params.pairingId) {
          return { pairingId: params.pairingId, state: 'waiting_local' }
        }
        return { pairingId: params.pairingId, state: 'unknown' }
      },
      'gateway.pair.cancel': (params: Record<string, unknown>) => {
        this.calls.push({ method: 'gateway.pair.cancel', params, signed: false })
        this.pairPending = null
        return { pairingId: params.pairingId, state: 'cancelled' }
      },
      'gateway.pair.forget': (raw: Record<string, unknown>) => {
        const { params, signed } = this.#unwrap('gateway.pair.forget', raw)
        this.calls.push({ method: 'gateway.pair.forget', params, signed })
        if (!signed) fail('signature_required', 'sign it with the paired key')
        this.pairedKey = null
        return { state: 'forgotten' }
      },
      'gateway.config.confirm': (raw: Record<string, unknown>) => {
        const { params, signed } = this.#unwrap('gateway.config.confirm', raw)
        this.calls.push({ method: 'gateway.config.confirm', params, signed })
        this.#writeGate(signed)
        return this.#confirm(String(params.applyId), gen, params.overrideChecks === true)
      },
      'gateway.config.rollback': (raw: Record<string, unknown>) => {
        const { params, signed } = this.#unwrap('gateway.config.rollback', raw)
        this.calls.push({ method: 'gateway.config.rollback', params, signed })
        this.#writeGate(signed)
        const id = String(params.applyId)
        if (!this.pending || this.pending.applyId !== id) fail('unknown_apply', `no apply ${id}`)
        setTimeout(() => this.#rollback('admin'), 10)
        return { state: 'rolling_back', applyId: id }
      },
      'gateway.config.ack': (raw: Record<string, unknown>) => {
        const { params, signed } = this.#unwrap('gateway.config.ack', raw)
        this.calls.push({ method: 'gateway.config.ack', params, signed })
        const ids = (params.applyIds as string[]) ?? []
        const before = this.results.length
        this.results = this.results.filter((r) => !ids.includes(r.applyId))
        return { acked: before - this.results.length }
      },
    }
  }

  /** perch-collector `sign.go`: verifies and unwraps a signed envelope. */
  #unwrap(method: string, raw: Record<string, unknown>) {
    if (typeof raw.payload !== 'string' && raw.sig === undefined)
      return { params: raw, signed: false }
    const sig = raw.sig as Record<string, unknown>
    const payload = raw.payload as string
    if (sig.challenge !== this.challenge) fail('bad_signature', 'challenge mismatch')
    const ts = Number(sig.ts)
    if (Math.abs(Date.now() / 1000 - ts) > 300) {
      fail('stale_signature', 'clock skew', { agentTime: Math.floor(Date.now() / 1000) })
    }
    const mac = createHmac('sha256', this.signKey ?? this.pairedKey?.key ?? TEST_API_KEY)
      .update(signatureMessage(method, String(sig.challenge), ts, String(sig.nonce), payload))
      .digest('hex')
    if (mac !== sig.mac) fail('bad_signature', 'the signature does not verify')
    if (this.nonces.has(String(sig.nonce))) fail('replayed', 'nonce used')
    this.nonces.add(String(sig.nonce))
    return { params: JSON.parse(payload) as Record<string, unknown>, signed: true }
  }

  #writeGate(signed: boolean) {
    if (this.access !== 'write') fail('not_managed', 'config_access is not write')
    if (this.transportOk) return
    if (!this.options.allowInsecure) fail('insecure_transport', 'writes need verified TLS')
    if (!signed) fail('signature_required', 'sign it')
  }

  /**
   * The router's admin confirms the pairing (`perch-collector pair confirm
   * <code>`): with the right code the key becomes the signing key and the
   * agent tells the controller.
   */
  localConfirm(code: string | null = this.pairPending?.sas ?? null): boolean {
    const p = this.pairPending
    if (!p || !p.key || code !== p.sas) return false
    this.pairedKey = { key: p.key, keyId: pairingKeyId(p.key) }
    this.pairPending = null
    this.collector?.notifyServer('gateway.pair.state', {
      pairingId: p.pairingId,
      state: 'paired',
      keyId: this.pairedKey.keyId,
    })
    return true
  }

  /** Apply and install need `agent.configure` mode `managed` on the session. */
  #requireManaged() {
    const block = this.collector?.lastConfigure()?.gatewayConfig as { mode?: string } | undefined
    if (block?.mode !== 'managed') fail('not_managed', 'the controller has not set mode managed')
  }

  #install(params: Record<string, unknown>, gen: number) {
    const applyId = String(params.applyId)
    const wanted = (params.packages as string[]) ?? []
    const refused = wanted.filter((p) => !this.installAllowlist.includes(p))
    if (refused.length > 0) fail('package_not_allowed', 'not allowed', { packages: refused })
    if (this.pending) fail('busy', 'apply pending', { reason: 'apply_pending' })
    const install = wanted.filter((p) => !this.packages[p])
    if (params.dryRun) {
      return {
        state: 'dry_run',
        applyId,
        manager: 'opkg',
        install,
        alreadyInstalled: [],
        needBytes: 1000,
        freeBytes: 5_000_000,
      }
    }
    if (install.length === 0) return { state: 'noop', applyId, hashes: this.hashes() }
    const snapshot = { configs: clone(this.configs), ledger: clone(this.ledger) }
    const before = { ...this.packages }
    for (const p of install) this.packages[p] = '1.0-r1'
    const confirmMs = this.options.confirmMs ?? 3000
    const deadline = new Date(Date.now() + confirmMs)
    this.pending = {
      applyId,
      kind: 'package',
      gen,
      deadline,
      snapshot,
      committed: clone(this.configs),
      timer: setTimeout(() => {
        this.packages = before
        this.#rollback('confirm_timeout')
      }, confirmMs),
    }
    setTimeout(() => {
      if (!this.closed) void this.redial()
    }, 30)
    return {
      state: 'pending_confirm',
      applyId,
      deadline: deadline.toISOString(),
      confirmTimeoutSeconds: Math.round(confirmMs / 1000),
      manager: 'opkg',
      install,
      alreadyInstalled: [],
      hashes: this.hashes(),
    }
  }

  #capabilities() {
    return {
      protocol: 1,
      access: this.access,
      allowedConfigs: this.options.allowedConfigs ?? Object.keys(this.configs),
      transportOk: this.transportOk,
      allowInsecure: this.options.allowInsecure ?? false,
      confirmMaxSeconds: 600,
      backend: 'ubus',
      openwrt: { release: '24.10.2', target: 'x86/64' },
      firewall: 'fw4',
      packageManager: 'opkg',
      packages: this.packages,
      installAllowlist: this.installAllowlist,
      configs: Object.keys(this.configs),
      hashes: this.hashes(),
      uncommitted: [],
      luciPending: false,
      apply: this.applyState(),
      capture: { networks: [] },
      ...(this.options.features ? { features: this.options.features } : {}),
      writableConfigs: this.options.allowedConfigs ?? Object.keys(this.configs),
    }
  }

  #read() {
    if (this.access === 'none') fail('not_managed', 'config_access none')
    return {
      readAt: new Date().toISOString(),
      configs: Object.entries(this.configs).map(([name, sections]) => ({
        name,
        hash: this.hash(name),
        sections: sections.map((s, index) => ({
          name: s.name,
          type: s.type,
          anonymous: s.anonymous ?? false,
          index,
          options: s.options,
          ...(s.secrets ? { secrets: s.secrets } : {}),
        })),
      })),
      ledger: this.ledger,
      uncommitted: [],
      luciPending: false,
    }
  }

  #apply(params: Record<string, unknown>, gen: number) {
    const applyId = String(params.applyId)
    if (this.failNextApply) {
      const f = this.failNextApply
      this.failNextApply = null
      fail(f.error, f.message ?? f.error, f.data ?? {})
    }
    if (this.pending) fail('busy', 'apply pending', { reason: 'apply_pending' })
    if (this.failNextApplyAfterCommit) {
      this.failNextApplyAfterCommit = false
      const result: Result = {
        applyId,
        kind: String(params.kind ?? 'apply'),
        outcome: 'rolled_back',
        reason: 'reload_failed',
        at: new Date().toISOString(),
        hashes: this.hashes(),
      }
      this.results.push(result)
      fail('apply_failed', 'dnsmasq did not reload', { rolledBack: true, result })
    }
    const base = (params.base ?? {}) as Record<string, string>
    if (this.staleNextApply) {
      this.staleNextApply = false
      fail('stale_base', 'base moved', { hashes: this.hashes() })
    }
    for (const [config, hash] of Object.entries(base)) {
      if (this.hash(config) !== hash) fail('stale_base', 'base moved', { hashes: this.hashes() })
    }
    const snapshot = { configs: clone(this.configs), ledger: clone(this.ledger) }
    const secrets = (params.secrets ?? {}) as Record<string, string>
    const ops = (params.ops ?? []) as Array<Record<string, any>>
    let functional = false
    // perch-collector's ownership rule: an existing section is written only
    // when it is in the ledger or adopted/created earlier in the job.
    const owned = new Set(this.ledger.map((e) => `${e.config}/${e.section}`))
    const undo = () => {
      this.configs = snapshot.configs
      this.ledger = snapshot.ledger
    }
    for (const op of ops) {
      const sections = this.configs[op.config] ?? (this.configs[op.config] = [])
      if (op.op === 'adopt') {
        const s = sections.find((x) => x.name === op.section)
        if (!s) fail('not_owned', `no section ${op.section}`)
        if (op.renameTo) {
          s.name = op.renameTo
          s.anonymous = false
          functional = true
        }
        this.ledger = this.ledger.filter((e) => e.perchId !== op.perchId)
        this.ledger.push({
          perchId: op.perchId,
          config: op.config,
          section: s.name,
          domain: op.domain ?? '',
        })
        owned.add(`${op.config}/${s.name}`)
      } else if (op.op === 'delete') {
        const i = sections.findIndex((x) => x.name === op.section)
        if (i >= 0) {
          // perch-collector deletes owned sections only (simulate.go `not_owned`).
          if (!owned.has(`${op.config}/${op.section}`)) {
            undo()
            fail('not_owned', `${op.config}.${op.section} is not in the ledger`)
          }
          sections.splice(i, 1)
        }
        // Its ledger entries go with it (simulate.go removes them by section).
        this.ledger = this.ledger.filter(
          (e) => !(e.config === op.config && e.section === op.section)
        )
        functional = true
      } else if (op.op === 'put') {
        const existing = sections.find((x) => x.name === op.section)
        if (existing && !owned.has(`${op.config}/${op.section}`)) {
          undo()
          fail('not_owned', `${op.config}.${op.section} is not in the ledger`)
        }
        owned.add(`${op.config}/${op.section}`)
        const options: Record<string, string | string[]> = {}
        for (const [k, v] of Object.entries(op.options as Record<string, any>)) {
          if (v && typeof v === 'object' && !Array.isArray(v)) {
            if (v.$keep && existing?.options[k] !== undefined) options[k] = existing.options[k]
            if (v.$secret) options[k] = secrets[v.$secret] ?? ''
          } else {
            options[k] = v
          }
        }
        if (existing) {
          existing.type = op.type
          existing.options = options
        } else {
          sections.push({ name: op.section, type: op.type, options })
        }
        if (op.position) {
          const ref = op.position.after ?? op.position.before
          const from = sections.findIndex((x) => x.name === op.section)
          const [moved] = sections.splice(from, 1)
          const at = sections.findIndex((x) => x.name === ref)
          if (at === -1) {
            undo()
            fail('bad_params', `position: no section ${ref}`)
          }
          sections.splice(op.position.after ? at + 1 : at, 0, moved)
        }
        functional = true
      } else if (op.op === 'order') {
        // The listed sections take the slots they occupy together, in the
        // listed order; nothing else moves (perch-collector simulate.go).
        const names = (op.sections as string[]) ?? []
        const slots: number[] = []
        for (const name of names) {
          const i = sections.findIndex((x) => x.name === name)
          if (i === -1) {
            undo()
            fail('no_section', `order: no section ${name}`)
          }
          if (op.type && sections[i].type !== op.type) {
            undo()
            fail('bad_params', `order: ${name} is not a ${op.type}`)
          }
          if (!owned.has(`${op.config}/${name}`)) {
            undo()
            fail('not_owned', `order: ${name} is not in the ledger`)
          }
          slots.push(i)
        }
        const moved = names.map((name) => sections.find((x) => x.name === name)!)
        slots.sort((a, b) => a - b)
        slots.forEach((slot, k) => {
          sections[slot] = moved[k]
        })
        this.orderOps.push({ config: op.config, type: op.type, sections: [...names] })
        functional = true
      }
    }
    const ledger = (params.ledger ?? {}) as { set?: Ledger[]; remove?: string[] }
    this.ledger = this.ledger.filter((e) => !(ledger.remove ?? []).includes(e.perchId))
    for (const e of ledger.set ?? []) {
      this.ledger = this.ledger.filter((x) => x.perchId !== e.perchId)
      this.ledger.push(e)
    }
    if (params.dryRun) {
      const changes = ops.map((op) => ({ config: op.config, section: op.section, op: op.op }))
      this.configs = snapshot.configs
      this.ledger = snapshot.ledger
      return { state: 'dry_run', applyId, changes }
    }
    if (!functional) return { state: 'applied', applyId, hashes: this.hashes() }

    const confirmMs = this.options.confirmMs ?? 3000
    const deadline = new Date(Date.now() + confirmMs)
    const wanted = params.checks as { v?: number; items?: CheckItemParam[] } | undefined
    const runsChecks =
      (this.options.features ?? []).includes('config.checks.v1') &&
      Array.isArray(wanted?.items) &&
      wanted.items.length > 0
    this.pending = {
      applyId,
      kind: String(params.kind ?? 'apply'),
      gen,
      deadline,
      snapshot,
      committed: clone(this.configs),
      timer: setTimeout(() => this.#rollback('confirm_timeout'), confirmMs),
      ...(runsChecks
        ? {
            checks: {
              items: wanted!.items!,
              state: 'pending',
              startedAt: null,
              results: wanted!.items!.map((i) => ({
                id: i.id,
                state: 'pending',
                detail: null,
                at: null,
              })),
            },
          }
        : {}),
    }
    if (this.options.redial !== false) {
      setTimeout(() => {
        if (this.closed) return
        this.duringWindow?.()
        void this.redial()
      }, 30)
    }
    return {
      state: 'pending_confirm',
      applyId,
      deadline: deadline.toISOString(),
      confirmTimeoutSeconds: Math.round(confirmMs / 1000),
      hashes: this.hashes(),
      ...(this.pending.checks
        ? {
            checks: {
              state: 'pending',
              timeoutSeconds: 60,
              baseline: this.pending.checks.items.map((i) => ({
                id: i.id,
                state: 'passed',
                detail: 'ok',
                at: new Date().toISOString(),
              })),
            },
          }
        : {}),
    }
  }

  #confirm(applyId: string, gen: number, overrideChecks = false) {
    if (!this.pending || this.pending.applyId !== applyId) {
      const r = this.results.find((x) => x.applyId === applyId)
      if (r) fail('deadline_passed', `apply ${applyId} was ${r.outcome}`, { result: r })
      fail('unknown_apply', `no pending apply ${applyId}`)
    }
    if (gen <= this.pending.gen) fail('not_reconnected', 'confirm on the fresh session')
    const checks = this.pending.checks
    if (checks && checks.state !== 'passed' && checks.state !== 'overridden') {
      if (!overrideChecks) {
        fail(checks.state === 'failed' ? 'checks_failed' : 'checks_pending', 'checks not passed', {
          checks: { state: checks.state, items: checks.results },
        })
      }
      checks.state = 'overridden'
    }
    clearTimeout(this.pending.timer)
    this.pending = null
    return { state: 'confirmed', applyId, hashes: this.hashes() }
  }

  #rollback(reason: string) {
    const p = this.pending
    if (!p) return
    clearTimeout(p.timer)
    this.pending = null
    // Router edits made during the window are discarded (section 3.4 step 7).
    const discarded: Record<string, Array<Section & { change: string }>> = {}
    for (const [config, sections] of Object.entries(this.configs)) {
      const committed = p.committed[config] ?? []
      for (const s of sections) {
        const was = committed.find((x) => x.name === s.name)
        if (!was) (discarded[config] ??= []).push({ ...clone(s), change: 'added' })
        else if (JSON.stringify(was) !== JSON.stringify(s)) {
          ;(discarded[config] ??= []).push({ ...clone(s), change: 'changed' })
        }
      }
      for (const s of committed) {
        if (!sections.some((x) => x.name === s.name)) {
          ;(discarded[config] ??= []).push({ ...clone(s), change: 'removed' })
        }
      }
    }
    this.configs = p.snapshot.configs
    this.ledger = p.snapshot.ledger
    const result: Result = {
      applyId: p.applyId,
      kind: p.kind,
      outcome: 'rolled_back',
      reason,
      at: new Date().toISOString(),
      hashes: this.hashes(),
      ...(Object.keys(discarded).length > 0 ? { discarded } : {}),
      ...(reason === 'checks_failed' && p.checks
        ? {
            detail: 'up: no answer from 3 targets',
            checks: { state: 'failed', items: p.checks.results },
          }
        : {}),
    }
    this.results.push(result)
    try {
      this.collector?.notifyServer(
        'gateway.config.result',
        result as unknown as Record<string, unknown>
      )
    } catch {
      // offline: the next hello carries it
    }
  }
}
