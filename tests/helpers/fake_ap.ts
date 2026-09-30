import { DEFAULT_SYSTEM_INFO, FakeAgent, RpcFailure } from '#tests/helpers/ap_agent'
import { metricsPush } from '#tests/helpers/infra'
import { createHash, createHmac } from 'node:crypto'

/**
 * A scripted perch-apd with the Wi-Fi plane (docs/design/wifi protocol.md,
 * ap-controller PROTOCOL.md section 2.5) for the controller's functional
 * tests, over the real AP socket (the `fake_gateway.ts` pattern):
 *
 * - UCI state in memory (`wireless`, `network`), passphrases in the clear
 *   like `/etc/config/wireless`, read back as unbound fingerprints with the
 *   fleet key the controller sent in `agent.configure`;
 * - `system.info` with the `wifiConfig` block, `wifi.capabilities`,
 *   `wifi.config.read`, `wifi.health`;
 * - the write path of the kit's plane: the write gate (access, verified
 *   TLS, managed on the session), `busy` while a window is open, base
 *   hashes (`stale_base`), `{"$keep":true}` / `{"$secret":ref}`, ownership
 *   (`not_owned`), the ledger, `applied` for adopt-only jobs, else
 *   `pending_confirm`, a drop-and-redial, a confirm only on a newer session
 *   and only once the scripted health check passed (`health_pending`,
 *   `unhealthy` with a rollback), rollback at the deadline or on
 *   `wifi.config.rollback`, results kept until `wifi.config.ack`;
 * - router edits with an author (`wifi.config.changed`).
 */

export type Section = {
  name: string
  type: string
  anonymous?: boolean
  options: Record<string, string | string[]>
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
  protected: boolean
}

type Result = {
  applyId: string
  kind: string
  outcome: string
  reason: string
  at: string
  hashes: Record<string, string>
  discarded?: Record<string, Array<Section & { change: string }>>
  health?: Record<string, unknown>
}

const SECRET_OPTIONS = new Set(['key', 'sae_password', 'password'])

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value))
}

function fail(error: string, message: string, extra: Record<string, unknown> = {}): never {
  throw new RpcFailure(-32000, message, { error, ...extra })
}

/** A small dual-band AP: one SSID on both radios, WPA2, bridged into `lan`. */
export function apConfigs(passphrase = 'correct horse battery'): Record<string, Section[]> {
  return {
    wireless: [
      {
        name: 'radio0',
        type: 'wifi-device',
        options: {
          type: 'mac80211',
          path: 'platform/soc/18000000.wifi',
          band: '2g',
          channel: '6',
          htmode: 'HE20',
          country: 'PH',
          cell_density: '0',
        },
      },
      {
        name: 'radio1',
        type: 'wifi-device',
        options: {
          type: 'mac80211',
          path: 'platform/soc/18000000.wifi+1',
          band: '5g',
          channel: '36',
          htmode: 'HE80',
          country: 'PH',
          cell_density: '0',
        },
      },
      {
        name: 'default_radio0',
        type: 'wifi-iface',
        options: {
          device: 'radio0',
          network: 'lan',
          mode: 'ap',
          ssid: 'Home',
          encryption: 'psk2+ccmp',
          key: passphrase,
          ifname: 'home-2g',
        },
      },
      {
        name: 'default_radio1',
        type: 'wifi-iface',
        options: {
          device: 'radio1',
          network: 'lan',
          mode: 'ap',
          ssid: 'Home',
          encryption: 'psk2+ccmp',
          key: passphrase,
        },
      },
    ],
    network: [
      {
        name: 'loopback',
        type: 'interface',
        options: { device: 'lo', proto: 'static', ipaddr: '127.0.0.1', netmask: '255.0.0.0' },
      },
      {
        name: 'cfg030f15',
        type: 'device',
        anonymous: true,
        options: { name: 'br-lan', type: 'bridge', ports: ['lan1', 'lan2'] },
      },
      { name: 'lan', type: 'interface', options: { device: 'br-lan', proto: 'dhcp' } },
    ],
  }
}

function channels(band: '2g' | '5g') {
  const list =
    band === '2g'
      ? Array.from({ length: 11 }, (_, i) => i + 1)
      : [36, 40, 44, 48, 52, 56, 60, 64, 100, 104, 108, 112, 149, 153, 157, 161]
  return list.map((channel) => {
    const dfs = band === '5g' && channel >= 52 && channel <= 144
    return {
      channel,
      mhz: band === '2g' ? 2407 + channel * 5 : 5000 + channel * 5,
      maxDbm: band === '2g' ? 20 : 23,
      dfs,
      noIr: false,
      disabled: false,
      ...(dfs ? { cacSeconds: 60 } : {}),
    }
  })
}

export type HealthScript = 'ok' | 'fail' | { pending: number }

export type FakeApOptions = {
  agentId: string
  agentSecret: string
  access?: 'none' | 'read' | 'write'
  /** The agent verifies the controller's certificate. */
  transportOk?: boolean
  /** Send `X-Forwarded-Proto: https` from loopback: the controller sees TLS (default true). */
  secure?: boolean
  guard?: 'installed' | 'self_installed' | 'missing'
  /** The AP's own confirm window. */
  confirmMs?: number
  /** Drop the session and redial after a commit (default true). */
  redial?: boolean
  /** Push metrics after each hello and then every `pushMs` (default true). */
  pushAfterHello?: boolean
  /** Push interval while connected (default 200 ms: the AP row's interval is 1 s in tests). */
  pushMs?: number
  configs?: Record<string, Section[]>
  /** Without the plane (an older perch-apd). */
  noPlane?: boolean
  features?: Record<string, boolean>
}

export class FakeAp {
  configs: Record<string, Section[]>
  ledger: Ledger[] = []
  results: Result[] = []
  pending: Pending | null = null
  agent: FakeAgent | null = null
  gen = 0
  seq = 1
  closed = false
  readonly calls: Array<{ method: string; params: Record<string, unknown> }> = []
  /** The health check's verdict for the next confirms. */
  health: HealthScript = 'ok'
  /** Next apply is refused with this (once). */
  failNextApply: { error: string; message?: string; data?: Record<string, unknown> } | null = null
  /** Router edits made during a window. */
  duringWindow: (() => void) | null = null
  #healthPending = 0
  #pushTimer: NodeJS.Timeout | null = null

  constructor(readonly options: FakeApOptions) {
    this.configs = clone(options.configs ?? apConfigs())
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
    return {
      ...Object.fromEntries(Object.keys(this.configs).map((c) => [c, this.hash(c)])),
      'perch-managed': createHash('sha256').update(JSON.stringify(this.ledger)).digest('hex'),
    }
  }

  section(config: string, name: string): Section | undefined {
    return this.configs[config]?.find((s) => s.name === name)
  }

  /** The `wifiConfig` block of the last `agent.configure`. */
  configureBlock(): Record<string, unknown> | null {
    const calls = this.agent?.calls.filter((c) => c.method === 'agent.configure') ?? []
    const last = calls[calls.length - 1]
    return (last?.params.wifiConfig as Record<string, unknown> | undefined) ?? null
  }

  #fingerprint(config: string, option: string, value: string | string[]): string {
    const keyHex = (this.configureBlock()?.fingerprintKey as string | undefined) ?? ''
    const key = Buffer.from(keyHex, 'hex')
    const tail = Array.isArray(value) ? `[]=${value.join('\n')}` : `=${value}`
    const digest = createHmac('sha256', key).update(`${config}.*.${option}${tail}`).digest('hex')
    return `hmac:${digest.slice(0, 16)}`
  }

  applyState() {
    if (!this.pending) return { state: 'idle' }
    return {
      state: 'pending_confirm',
      applyId: this.pending.applyId,
      kind: this.pending.kind,
      deadline: this.pending.deadline.toISOString(),
      protected: this.pending.protected,
      health: 'pending',
    }
  }

  // ── session ────────────────────────────────────────────────────────────

  async connect(): Promise<FakeAgent> {
    this.closed = false
    this.gen++
    const gen = this.gen
    const headers: Record<string, string> = {}
    if (this.options.secure !== false) headers['X-Forwarded-Proto'] = 'https'
    const agent = await FakeAgent.connect({
      agentId: this.options.agentId,
      agentSecret: this.options.agentSecret,
      headers,
      handlers: this.#handlers(gen),
    })
    this.agent = agent
    return agent
  }

  push() {
    if (!this.agent || this.closed || !this.agent.isOpen) return
    try {
      this.agent.notifyServer('metrics.push', metricsPush(this.seq++))
    } catch {
      // closed
    }
  }

  #startPushing() {
    if (this.#pushTimer) clearInterval(this.#pushTimer)
    this.#pushTimer = setInterval(() => this.push(), this.options.pushMs ?? 200)
  }

  #stopPushing() {
    if (this.#pushTimer) clearInterval(this.#pushTimer)
    this.#pushTimer = null
  }

  async redial(): Promise<void> {
    if (this.closed) return
    const old = this.agent
    this.agent = null
    this.#stopPushing()
    if (old) await old.close()
    if (this.closed) return
    await this.connect()
  }

  async close() {
    this.closed = true
    this.#stopPushing()
    await this.agent?.close()
    this.agent = null
  }

  async destroy() {
    await this.close()
    if (this.pending) clearTimeout(this.pending.timer)
    this.pending = null
  }

  /** A LuCI/uci edit, then `wifi.config.changed` with its author. */
  routerEdit(
    config: string,
    edit: (sections: Section[]) => void,
    author: Record<string, unknown> = { kind: 'luci', user: 'root', via: 'trigger' }
  ) {
    const sections = this.configs[config] ?? (this.configs[config] = [])
    edit(sections)
    this.agent?.notifyServer('wifi.config.changed', {
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
    const log =
      (method: string, fn: (params: Record<string, unknown>) => unknown) =>
      (params: Record<string, unknown>) => {
        this.calls.push({ method, params })
        return fn(params)
      }
    return {
      'system.info': log('system.info', () => {
        if (this.options.pushAfterHello !== false) this.#startPushing()
        return this.#systemInfo()
      }),
      'wifi.capabilities': log('wifi.capabilities', () => this.#capabilities()),
      'wifi.config.read': log('wifi.config.read', () => this.#read()),
      'wifi.health': log('wifi.health', () => this.#healthReport(true)),
      'wifi.config.apply': log('wifi.config.apply', (p) => {
        this.#writeGate()
        return this.#apply(p, gen)
      }),
      'wifi.config.confirm': log('wifi.config.confirm', (p) =>
        this.#confirm(String(p.applyId), gen)
      ),
      'wifi.config.rollback': log('wifi.config.rollback', (p) => {
        const id = String(p.applyId)
        if (!this.pending || this.pending.applyId !== id) fail('unknown_apply', `no apply ${id}`)
        setTimeout(() => this.#rollback('admin'), 10)
        return { state: 'rolling_back', applyId: id }
      }),
      'wifi.config.ack': log('wifi.config.ack', (p) => {
        const ids = (p.applyIds as string[]) ?? []
        const before = this.results.length
        this.results = this.results.filter((r) => !ids.includes(r.applyId))
        return { acked: before - this.results.length }
      }),
    }
  }

  #systemInfo() {
    const capabilities = [...DEFAULT_SYSTEM_INFO.capabilities, 'ports']
    if (!this.options.noPlane) capabilities.push('wifi_config')
    return {
      ...DEFAULT_SYSTEM_INFO,
      agentVersion: '1.2.0-pre.1',
      capabilities,
      ...(this.options.noPlane
        ? {}
        : {
            wifiConfig: {
              protocol: 1,
              access: this.access,
              transportOk: this.transportOk,
              allowInsecure: false,
              allowedConfigs: ['wireless', 'network'],
              hashes: this.access === 'none' ? {} : this.hashes(),
              apply: this.applyState(),
              results: this.results,
              signing: { required: false, challenge: 'c0ffee', key: 'none', windowSeconds: 300 },
              management: {
                network: 'lan',
                device: 'br-lan',
                radios: [],
                controllerAddress: '192.168.1.10',
                reportedAt: new Date().toISOString(),
              },
              groups: { engine: true, enabled: false, state: 'idle', handedOver: false },
            },
          }),
    }
  }

  #capabilities() {
    if (this.access === 'none') fail('wifi_config_off', 'wifi_config none')
    const radio = (section: string, band: '2g' | '5g', path: string) => ({
      section,
      phy: section === 'radio0' ? 'phy0' : 'phy1',
      path,
      band,
      present: true,
      up: true,
      retrySetupFailed: false,
      country: 'PH',
      txpowerMaxDbm: band === '2g' ? 20 : 23,
      maxBss: 16,
      widths: band === '2g' ? [20, 40] : [20, 40, 80, 160],
      modes: band === '2g' ? ['HT', 'HE'] : ['HT', 'VHT', 'HE'],
      channels: channels(band),
      current: {
        channel: band === '2g' ? 6 : 36,
        htmode: band === '2g' ? 'HE20' : 'HE80',
        txpowerDbm: 20,
      },
    })
    return {
      protocol: 1,
      access: this.access,
      allowedConfigs: ['wireless', 'network'],
      transportOk: this.transportOk,
      allowInsecure: false,
      confirmMaxSeconds: 900,
      backend: 'ubus',
      guard: this.options.guard ?? 'installed',
      openwrt: { release: '24.10.2', target: 'mediatek/filogic', arch: 'aarch64_cortex-a53' },
      packageManager: 'opkg',
      packages: { 'wpad-basic-mbedtls': '2024.09.15-r1' },
      wifiScripts: 'ucode',
      schema: false,
      hostapd: {
        binary: '/usr/sbin/wpad',
        variant: 'wpad-basic-mbedtls',
        ubus: true,
        features: this.options.features ?? {
          '11r': true,
          'sae': true,
          'owe': true,
          'eap': false,
          '11ax': true,
          'acs': true,
        },
      },
      regulatory: { global: 'PH', settable: true, reason: null, selfManaged: [] },
      radios: [
        radio('radio0', '2g', 'platform/soc/18000000.wifi'),
        radio('radio1', '5g', 'platform/soc/18000000.wifi+1'),
      ],
      trunk: { port: 'lan1', bridge: 'br-lan', vlanFiltering: false, source: 'auto' },
      networks: [{ name: 'lan', device: 'br-lan', proto: 'dhcp', up: true }],
      management: {
        network: 'lan',
        device: 'br-lan',
        radios: [],
        controllerAddress: '192.168.1.10',
        reportedAt: new Date().toISOString(),
      },
      hashes: this.hashes(),
      uncommitted: [],
      luciPending: false,
      apply: this.applyState(),
      groups: {
        engine: true,
        enabled: false,
        state: 'idle',
        appliedRevision: 0,
        owned: [],
        handedOver: false,
      },
    }
  }

  #read() {
    if (this.access === 'none') fail('wifi_config_off', 'wifi_config none')
    return {
      readAt: new Date().toISOString(),
      configs: Object.entries(this.configs).map(([name, sections]) => ({
        name,
        hash: this.hash(name),
        sections: sections.map((s, index) => {
          const options: Record<string, string | string[]> = {}
          const secrets: Record<string, string> = {}
          for (const [k, v] of Object.entries(s.options)) {
            if (SECRET_OPTIONS.has(k)) secrets[k] = this.#fingerprint(name, k, v)
            else options[k] = v
          }
          return {
            name: s.name,
            type: s.type,
            anonymous: s.anonymous ?? false,
            index,
            options,
            ...(Object.keys(secrets).length > 0 ? { secrets } : {}),
            hash: createHash('sha256').update(JSON.stringify(s)).digest('hex').slice(0, 16),
          }
        }),
      })),
      ledger: this.ledger,
      uncommitted: [],
      luciPending: false,
      groupsOwned: { dynamicVlan: [] },
    }
  }

  #healthReport(ok: boolean, pending = false) {
    const radios = this.configs.wireless.filter((s) => s.type === 'wifi-device')
    const ifaces = this.configs.wireless.filter(
      (s) => s.type === 'wifi-iface' && s.options.disabled !== '1'
    )
    return {
      checkedAt: new Date().toISOString(),
      ok,
      pending,
      radios: radios.map((r) => ({
        section: r.name,
        up: ok,
        retrySetupFailed: false,
        channel: Number(r.options.channel) || null,
        dfs: null,
        expected: true,
      })),
      bss: ifaces.map((i) => ({
        section: i.name,
        ifname: `${i.options.device}-ap`,
        ssid: String(i.options.ssid ?? ''),
        status: ok ? 'ENABLED' : pending ? 'DFS' : 'DISABLED',
        expected: true,
        bssid: '02:00:00:00:00:51',
      })),
      pskGuard: 'skipped',
      problems: ok
        ? []
        : [
            {
              code: pending ? 'cac_running' : 'bss_disabled',
              section: ifaces[0]?.name ?? null,
              message: pending ? 'radar check running' : 'the BSS did not come up',
            },
          ],
    }
  }

  #writeGate() {
    if (this.access !== 'write') fail('not_managed', 'wifi_config is not write')
    if (!this.transportOk) fail('insecure_transport', 'writes need verified TLS')
    const mode = this.configureBlock()?.mode
    if (mode !== 'managed') fail('not_managed', 'the controller has not set mode managed')
    if ((this.options.guard ?? 'installed') === 'missing') fail('guard_missing', 'no boot guard')
  }

  #apply(params: Record<string, unknown>, gen: number) {
    const applyId = String(params.applyId)
    if (!/^a\d+-[0-9a-f]{12}$/.test(applyId)) fail('bad_params', 'applyId')
    if (this.failNextApply) {
      const f = this.failNextApply
      this.failNextApply = null
      fail(f.error, f.message ?? f.error, f.data ?? {})
    }
    if (this.pending) fail('busy', 'apply pending', { reason: 'apply_pending' })
    const base = (params.base ?? {}) as Record<string, string>
    for (const [config, hash] of Object.entries(base)) {
      if (hash === '' && !this.configs[config]) continue
      if (this.hash(config) !== hash) fail('stale_base', 'base moved', { hashes: this.hashes() })
    }
    const snapshot = { configs: clone(this.configs), ledger: clone(this.ledger) }
    const secrets = (params.secrets ?? {}) as Record<string, string>
    const ops = (params.ops ?? []) as Array<Record<string, any>>
    const undo = () => {
      this.configs = snapshot.configs
      this.ledger = snapshot.ledger
    }
    const owned = new Set(this.ledger.map((e) => `${e.config}/${e.section}`))
    let functional = false
    for (const op of ops) {
      const sections = this.configs[op.config] ?? (this.configs[op.config] = [])
      if (op.op === 'adopt') {
        const s = sections.find((x) => x.name === op.section)
        if (!s) {
          undo()
          fail('not_owned', `no section ${op.section}`)
        }
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
        if (!owned.has(`${op.config}/${op.section}`)) {
          undo()
          fail('not_owned', `${op.config}.${op.section} is not in the ledger`)
        }
        const i = sections.findIndex((x) => x.name === op.section)
        if (i >= 0) sections.splice(i, 1)
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
            if (v.$keep) {
              if (existing?.options[k] !== undefined) options[k] = existing.options[k]
            } else if (v.$secret) {
              const value = secrets[v.$secret]
              if (value === undefined) {
                undo()
                fail('bad_params', `no secret ${v.$secret}`)
              }
              options[k] = value
            }
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
      protected: params.protected === true,
    }
    this.#healthPending = typeof this.health === 'object' ? this.health.pending : 0
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
      protected: params.protected === true,
      hashes: this.hashes(),
      reload: 'wifi',
    }
  }

  #confirm(applyId: string, gen: number) {
    if (!this.pending || this.pending.applyId !== applyId) {
      const r = this.results.find((x) => x.applyId === applyId)
      if (r) fail('deadline_passed', `apply ${applyId} was ${r.outcome}`, { result: r })
      fail('unknown_apply', `no pending apply ${applyId}`)
    }
    if (gen <= this.pending.gen) fail('not_reconnected', 'confirm on the fresh session')
    if (this.health === 'fail') {
      const health = this.#healthReport(false)
      this.#rollback('health_failed', health)
      fail('unhealthy', 'the health check failed', { health, rolledBack: true })
    }
    if (this.#healthPending > 0) {
      this.#healthPending--
      fail('health_pending', 'the health check still runs', {
        health: this.#healthReport(false, true),
      })
    }
    clearTimeout(this.pending.timer)
    this.pending = null
    return { state: 'confirmed', applyId, hashes: this.hashes(), health: this.#healthReport(true) }
  }

  #rollback(reason: string, health?: Record<string, unknown>) {
    const p = this.pending
    if (!p) return
    clearTimeout(p.timer)
    this.pending = null
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
      ...(health ? { health } : {}),
    }
    this.results.push(result)
    try {
      this.agent?.notifyServer('wifi.config.result', result as unknown as Record<string, unknown>)
    } catch {
      // offline: the next hello carries it
    }
  }
}

// ── setup helpers for the Wi-Fi plane's functional suites ────────────────

/**
 * An agent AP row for a `FakeAp` (as if it had joined), with a 1 s push
 * interval so every push of the fake is accepted.
 */
export async function seedPlaneAp(name = 'ap-one') {
  const { seedAgentAp } = await import('#tests/helpers/ap_agent')
  const seeded = await seedAgentAp({ name, macs: [] })
  seeded.ap.pollIntervalSeconds = 1
  seeded.ap.friendlyName = name
  await seeded.ap.save()
  return seeded
}

/** Forgets every in-memory state of the plane and the AP socket (between tests). */
export async function resetPlaneState() {
  const registry = await import('#services/wifi_config/registry')
  const secrets = await import('#services/wifi_config/secrets')
  const metrics = await import('#services/ap_agent_metrics')
  const rateLimit = await import('#services/ap_agent_rate_limit')
  const groups = await import('#services/ap_groups')
  registry._resetApSessions()
  secrets._resetFleetKeyCache()
  metrics._resetAgentMetricsState()
  rateLimit._resetApAgentRateLimits()
  groups._resetApGroupsState()
}

/** Waits until both queues of the plane are idle. */
export async function drainPlane() {
  const { apConfigQueue, fleetQueue } = await import('#services/wifi_config/store')
  for (let i = 0; i < 5; i++) {
    await apConfigQueue.drainAll()
    await fleetQueue.drainAll()
  }
}
