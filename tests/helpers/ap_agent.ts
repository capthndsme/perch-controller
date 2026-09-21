import ApJoinToken from '#models/ap_join_token'
import WifiAccessPoint, { type ApAgentInfo } from '#models/wifi_access_point'
import {
  generateAgentCredentials,
  generateJoinToken,
  joinTokenDisplayPrefix,
  sha256Hex,
} from '#services/ap_agent_credentials'
import app from '@adonisjs/core/services/app'
import type { AddressInfo } from 'node:net'
import { DateTime } from 'luxon'
import WebSocket from 'ws'

/**
 * Test side of the Perch AP Daemon: a fake agent speaking PROTOCOL.md over a real
 * WebSocket to the functional test server, plus seed helpers.
 *
 * The URL is built from the address the test server is actually bound to
 * (never from HOST/PORT): on this box `localhost:PORT` can also be the live
 * stack's published port on the other address family.
 */

export const AGENT_SUBPROTOCOL = 'perch-ap.v1'

export async function agentWsUrl(): Promise<string> {
  const server = await app.container.make('server')
  const address = server.getNodeServer()!.address() as AddressInfo
  const host = address.address.includes(':') ? `[${address.address}]` : address.address
  return `ws://${host}:${address.port}/api/v1/ap-agent/ws`
}

export const DEFAULT_SYSTEM_INFO = {
  agentVersion: '0.1.0',
  protocol: 1,
  hostname: 'ap-garage',
  model: 'Example AP 1',
  boardName: 'example,ap-1',
  system: 'Example SoC',
  release: '25.12.4',
  revision: 'r1-abcdef',
  target: 'ramips/mt7621',
  kernel: '6.12.87',
  arch: 'mipsle',
  uptimeSeconds: 1234,
  macs: ['02:00:00:00:00:10', '02:00:00:00:00:11'],
  capabilities: ['metrics', 'clients', 'kick', 'locate', 'reboot'],
  radios: [{ name: 'radio0', band: '2g', channel: 6, htmode: 'HE20', country: 'PH', up: true }],
  interfaces: [
    {
      ifname: 'phy0-ap0',
      radio: 'radio0',
      mode: 'ap',
      ssid: 'Example',
      bssid: '02:00:00:00:00:11',
      frequencyMhz: 2437,
      channel: 6,
      band: '2.4',
      stations: 1,
    },
  ],
}

export class RpcFailure extends Error {
  constructor(
    readonly code: number,
    message: string
  ) {
    super(message)
  }
}

type Handler = (params: Record<string, unknown>) => unknown | Promise<unknown>

export type ReceivedCall = {
  id: number | string | null
  method: string
  params: Record<string, unknown>
}

export class FakeAgent {
  readonly calls: ReceivedCall[] = []
  readonly closed: Promise<{ code: number; reason: string }>
  readonly handlers: Record<string, Handler>
  #waiters: Array<{ method: string; resolve: (call: ReceivedCall) => void }> = []
  #nextId = 1
  #pending = new Map<number, (message: Record<string, unknown>) => void>()

  private constructor(
    readonly socket: WebSocket,
    handlers: Record<string, Handler>
  ) {
    this.handlers = {
      'system.info': () => DEFAULT_SYSTEM_INFO,
      'ping': () => ({ pong: true, time: new Date().toISOString() }),
      ...handlers,
    }
    this.closed = new Promise((resolve) => {
      socket.on('close', (code, reason) => resolve({ code, reason: reason.toString() }))
    })
    socket.on('message', (data) => this.#onMessage(data.toString()))
  }

  static async connect(options: {
    agentId: string
    agentSecret: string
    handlers?: Record<string, Handler>
  }): Promise<FakeAgent> {
    const socket = new WebSocket(await agentWsUrl(), AGENT_SUBPROTOCOL, {
      headers: { Authorization: `Bearer ${options.agentId}.${options.agentSecret}` },
    })
    const agent = new FakeAgent(socket, options.handlers ?? {})
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve())
      socket.once('unexpected-response', (_req, res) =>
        reject(new Error(`handshake refused: HTTP ${res.statusCode}`))
      )
      socket.once('error', reject)
    })
    return agent
  }

  get isOpen() {
    return this.socket.readyState === WebSocket.OPEN
  }

  /** Resolves with the next (or an already received) call of `method`. */
  waitFor(method: string, timeoutMs = 3000): Promise<ReceivedCall> {
    const seen = this.calls.find((call) => call.method === method)
    if (seen) return Promise.resolve(seen)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`agent never received ${method}`)), timeoutMs)
      this.#waiters.push({
        method,
        resolve: (call) => {
          clearTimeout(timer)
          resolve(call)
        },
      })
    })
  }

  /** Resolves once `method` has been received `count` times; returns those calls. */
  async waitForCount(method: string, count: number, timeoutMs = 3000): Promise<ReceivedCall[]> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const calls = this.calls.filter((call) => call.method === method)
      if (calls.length >= count) return calls
      if (Date.now() > deadline) {
        throw new Error(`agent received ${method} ${calls.length} times, wanted ${count}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }

  /** Sends a notification TO the server (e.g. `metrics.push`). */
  notifyServer(method: string, params: Record<string, unknown> = {}) {
    this.socket.send(JSON.stringify({ jsonrpc: '2.0', method, params }))
  }

  /** Sends a request TO the server and resolves with its reply. */
  requestServer(method: string, params: Record<string, unknown> = {}) {
    const id = this.#nextId++
    return new Promise<Record<string, unknown>>((resolve) => {
      this.#pending.set(id, resolve)
      this.socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    })
  }

  async close() {
    if (this.socket.readyState === WebSocket.CLOSED) return
    this.socket.close(1000, 'test done')
    await this.closed
  }

  async #onMessage(raw: string) {
    const message = JSON.parse(raw) as Record<string, unknown>
    if (typeof message.method !== 'string') {
      const resolve = this.#pending.get(Number(message.id))
      if (resolve) {
        this.#pending.delete(Number(message.id))
        resolve(message)
      }
      return
    }

    const call: ReceivedCall = {
      id: (message.id as number | string | undefined) ?? null,
      method: message.method,
      params: (message.params as Record<string, unknown>) ?? {},
    }
    this.calls.push(call)
    for (const waiter of this.#waiters.filter((entry) => entry.method === call.method)) {
      waiter.resolve(call)
    }
    this.#waiters = this.#waiters.filter((entry) => entry.method !== call.method)

    if (call.id === null) return
    const handler = this.handlers[call.method]
    if (!handler) {
      this.#reply({ id: call.id, error: { code: -32601, message: 'method not found' } })
      return
    }
    try {
      const result = await handler(call.params)
      this.#reply({ id: call.id, result })
    } catch (error) {
      if (error instanceof RpcFailure) {
        this.#reply({ id: call.id, error: { code: error.code, message: error.message } })
      } else {
        this.#reply({ id: call.id, error: { code: -32603, message: String(error) } })
      }
    }
  }

  #reply(payload: Record<string, unknown>) {
    if (this.socket.readyState !== WebSocket.OPEN) return
    this.socket.send(JSON.stringify({ jsonrpc: '2.0', ...payload }))
  }
}

/**
 * Tries a handshake and reports the HTTP refusal instead of throwing.
 */
export async function attemptHandshake(options: {
  authorization?: string
  protocols?: string[]
}): Promise<
  | { status: 'open'; socket: WebSocket; protocol: string }
  | { status: number; body: any; headers: any }
> {
  const headers: Record<string, string> = {}
  if (options.authorization !== undefined) headers.Authorization = options.authorization
  const socket = new WebSocket(await agentWsUrl(), options.protocols ?? [AGENT_SUBPROTOCOL], {
    headers,
  })
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve({ status: 'open', socket, protocol: socket.protocol }))
    socket.once('unexpected-response', (_req, res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        body += chunk
      })
      res.on('end', () => {
        let parsed: unknown = body
        try {
          parsed = JSON.parse(body)
        } catch {
          // keep text
        }
        resolve({ status: res.statusCode ?? 0, body: parsed, headers: res.headers })
      })
    })
    socket.once('error', (error) => {
      // `unexpected-response` handles refusals; anything else is a real error.
      if (!String(error.message).includes('Unexpected server response')) reject(error)
    })
  })
}

/** A join token row; returns the plaintext too. */
export async function seedJoinToken(
  overrides: Partial<{
    label: string | null
    expiresAt: DateTime | null
    maxUses: number | null
    useCount: number
    revokedAt: DateTime | null
    createdByUserId: number | null
  }> = {}
): Promise<{ token: string; row: ApJoinToken }> {
  const token = generateJoinToken()
  const row = await ApJoinToken.create({
    label: overrides.label ?? null,
    tokenHash: sha256Hex(token),
    tokenPrefix: joinTokenDisplayPrefix(token),
    token,
    createdByUserId: overrides.createdByUserId ?? null,
    expiresAt: overrides.expiresAt ?? null,
    maxUses: overrides.maxUses ?? null,
    useCount: overrides.useCount ?? 0,
    lastUsedAt: null,
    revokedAt: overrides.revokedAt ?? null,
  })
  return { token, row }
}

/** An AP that already has agent credentials (as if it had joined). */
export async function seedAgentAp(
  overrides: Partial<{
    name: string
    metricsUrl: string | null
    capabilities: string[]
    macs: string[]
    enabled: boolean
  }> = {}
): Promise<{ ap: WifiAccessPoint; agentId: string; agentSecret: string }> {
  const credentials = generateAgentCredentials()
  const info: ApAgentInfo = {
    hostname: overrides.name ?? 'ap-garage',
    macs: overrides.macs ?? ['02:00:00:00:00:10', '02:00:00:00:00:11'],
    capabilities: overrides.capabilities ?? ['metrics', 'clients', 'kick', 'locate', 'reboot'],
  }
  const ap = await WifiAccessPoint.create({
    name: overrides.name ?? 'ap-garage',
    friendlyName: null,
    metricsUrl: overrides.metricsUrl ?? null,
    transport: 'agent',
    pollIntervalSeconds: 15,
    enabled: overrides.enabled ?? true,
    enableTwoWayCommands: false,
    sshHost: null,
    sshPort: 22,
    sshUsername: null,
    sshPrivateKey: null,
    model: null,
    openwrtRelease: null,
    nodename: null,
    lastSeenAt: null,
    lastStatus: null,
    agentId: credentials.agentId,
    agentSecretHash: credentials.secretHash,
    agentVersion: '0.1.0',
    agentInfo: info,
    agentJoinedAt: DateTime.utc(),
  })
  return { ap, agentId: credentials.agentId, agentSecret: credentials.agentSecret }
}

/** Polls until `predicate` holds (for things that settle asynchronously). */
export async function eventually<T>(
  probe: () => Promise<T> | T,
  predicate: (value: T) => boolean,
  timeoutMs = 3000
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last = await probe()
  while (!predicate(last)) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise((resolve) => setTimeout(resolve, 25))
    last = await probe()
  }
  return last
}

/**
 * An admin, an operator, an instance name and one adopted collector: what
 * `requireSetupComplete` needs before `/api/v1/settings/*` and
 * `/api/v1/wifi/*` open.
 */
export async function seedSetupComplete(): Promise<{
  adminToken: string
  operatorToken: string
  adminId: number
}> {
  const { default: User } = await import('#models/user')
  const { default: SystemSetting } = await import('#models/system_setting')
  const { default: Collector } = await import('#models/collector')
  const admin = await User.create({
    fullName: 'Admin',
    email: 'admin@example.com',
    password: 'admin-pass-123',
    role: 'admin',
  })
  const operator = await User.create({
    fullName: 'Operator',
    email: 'operator@example.com',
    password: 'operator-pass-123',
    role: 'operator',
  })
  await SystemSetting.set('site_name', 'Perch @ test')
  await SystemSetting.set('timezone', 'UTC')
  await Collector.create({
    name: 'localhost',
    baseUrl: 'http://127.0.0.1:9800',
    pollIntervalSeconds: 15,
    enabled: true,
    apiKey: null,
    lastStatus: null,
  })
  const adminToken = await User.accessTokens.create(admin)
  const operatorToken = await User.accessTokens.create(operator)
  return {
    adminToken: adminToken.value!.release(),
    operatorToken: operatorToken.value!.release(),
    adminId: admin.id,
  }
}
