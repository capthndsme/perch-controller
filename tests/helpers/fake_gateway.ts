import {
  device,
  FakeCollector,
  reading,
  RpcFailure,
  TEST_API_KEY,
  TEST_INSTANCE_ID,
} from '#tests/helpers/collector_agent'
import { signatureMessage } from '#services/gateway_config/rpc_signing'
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

type Pending = {
  applyId: string
  kind: string
  gen: number
  deadline: Date
  snapshot: { configs: Record<string, Section[]>; ledger: Ledger[] }
  committed: Record<string, Section[]>
  timer: NodeJS.Timeout
}

type Result = {
  applyId: string
  kind: string
  outcome: string
  reason: string
  at: string
  hashes: Record<string, string>
  discarded?: Record<string, Array<Section & { change: string }>>
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
  /** Packages `gateway.package.install` may install. */
  installAllowlist = ['sqm-scripts', 'kmod-sched-cake', 'opennds']
  /** The router's own `config_sign_key` (signing.key says so when set). */
  signKey: string | null = null

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
    return {
      state: 'pending_confirm',
      applyId: this.pending.applyId,
      kind: this.pending.kind,
      deadline: this.pending.deadline.toISOString(),
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
          key: this.signKey ? 'config_sign_key' : 'api_key',
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
    return {
      'gateway.capabilities': wrap('gateway.capabilities', () => this.#capabilities()),
      'gateway.config.read': wrap('gateway.config.read', () => this.#read()),
      'gateway.config.apply': (raw: Record<string, unknown>) => {
        const { params, signed } = this.#unwrap('gateway.config.apply', raw)
        this.calls.push({ method: 'gateway.config.apply', params, signed })
        this.#writeGate(signed)
        this.#requireManaged()
        return this.#apply(params, gen)
      },
      'gateway.package.install': (raw: Record<string, unknown>) => {
        const { params, signed } = this.#unwrap('gateway.package.install', raw)
        this.calls.push({ method: 'gateway.package.install', params, signed })
        this.#writeGate(signed)
        this.#requireManaged()
        return this.#install(params, gen)
      },
      'gateway.config.confirm': (raw: Record<string, unknown>) => {
        const { params, signed } = this.#unwrap('gateway.config.confirm', raw)
        this.calls.push({ method: 'gateway.config.confirm', params, signed })
        this.#writeGate(signed)
        return this.#confirm(String(params.applyId), gen)
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
    const mac = createHmac('sha256', this.signKey ?? TEST_API_KEY)
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
      allowedConfigs: Object.keys(this.configs),
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
      } else if (op.op === 'delete') {
        const i = sections.findIndex((x) => x.name === op.section)
        if (i >= 0) sections.splice(i, 1)
        functional = true
      } else if (op.op === 'put') {
        const existing = sections.find((x) => x.name === op.section)
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
    this.pending = {
      applyId,
      kind: String(params.kind ?? 'apply'),
      gen,
      deadline,
      snapshot,
      committed: clone(this.configs),
      timer: setTimeout(() => this.#rollback('confirm_timeout'), confirmMs),
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
    }
  }

  #confirm(applyId: string, gen: number) {
    if (!this.pending || this.pending.applyId !== applyId) {
      const r = this.results.find((x) => x.applyId === applyId)
      if (r) fail('deadline_passed', `apply ${applyId} was ${r.outcome}`, { result: r })
      fail('unknown_apply', `no pending apply ${applyId}`)
    }
    if (gen <= this.pending.gen) fail('not_reconnected', 'confirm on the fresh session')
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
