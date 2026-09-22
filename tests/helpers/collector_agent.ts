import app from '@adonisjs/core/services/app'
import type { AddressInfo } from 'node:net'
import WebSocket from 'ws'

/**
 * Test side of the collector socket (docs/collector-agent.md section 3): a
 * fake collector speaking `perch-collector.v1` over a real WebSocket to the
 * functional test server. Same conventions as `tests/helpers/ap_agent.ts`:
 * the URL comes from the address the test server is bound to.
 */

export const COLLECTOR_SUBPROTOCOL = 'perch-collector.v1'

export async function collectorWsUrl(): Promise<string> {
  const server = await app.container.make('server')
  const address = server.getNodeServer()!.address() as AddressInfo
  const host = address.address.includes(':') ? `[${address.address}]` : address.address
  return `ws://${host}:${address.port}/api/v1/collector-agent/ws`
}

export const TEST_INSTANCE_ID = 'e56204aa11bb22cc33dd44ee55ff6677'
export const TEST_API_KEY = 'collector-key-0123456789abcdef'

type Handler = (params: Record<string, unknown>) => unknown | Promise<unknown>

export type ReceivedCall = {
  id: number | string | null
  method: string
  params: Record<string, unknown>
}

export type HelloParams = Record<string, unknown>

export const DEFAULT_PROTOCOLS = [
  { protocol: 'TLS', category: 'Web' },
  { protocol: 'QUIC', category: 'Web' },
]

export class FakeCollector {
  readonly calls: ReceivedCall[] = []
  readonly closed: Promise<{ code: number; reason: string }>
  readonly handlers: Record<string, Handler>
  #nextId = 1
  #pending = new Map<number, (message: Record<string, unknown>) => void>()

  private constructor(
    readonly socket: WebSocket,
    handlers: Record<string, Handler>
  ) {
    this.handlers = {
      'collector.status': () => ({
        startedAt: '2026-09-21T10:00:00Z',
        totalDevices: 3,
        captureInterface: 'br-lan',
        version: '0.2.0',
        uptimeSeconds: 60,
      }),
      'collector.protocols': () => ({ protocols: DEFAULT_PROTOCOLS }),
      ...handlers,
    }
    this.closed = new Promise((resolve) => {
      socket.on('close', (code, reason) => resolve({ code, reason: reason.toString() }))
    })
    socket.on('message', (data) => this.#onMessage(data.toString()))
  }

  static async connect(
    options: {
      instanceId?: string
      apiKey?: string
      handlers?: Record<string, Handler>
      /** Extra upgrade headers, e.g. what a reverse proxy adds. */
      headers?: Record<string, string>
    } = {}
  ): Promise<FakeCollector> {
    const socket = new WebSocket(await collectorWsUrl(), COLLECTOR_SUBPROTOCOL, {
      headers: {
        ...options.headers,
        'Authorization': `Bearer ${options.apiKey ?? TEST_API_KEY}`,
        'X-Perch-Instance-Id': options.instanceId ?? TEST_INSTANCE_ID,
      },
      perMessageDeflate: true,
    })
    const collector = new FakeCollector(socket, options.handlers ?? {})
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve())
      socket.once('unexpected-response', (_req, res) =>
        reject(new Error(`handshake refused: HTTP ${res.statusCode}`))
      )
      socket.once('error', reject)
    })
    return collector
  }

  /** Sends `collector.hello` and resolves with the whole reply. */
  hello(params: HelloParams = {}): Promise<Record<string, unknown>> {
    return this.request('collector.hello', {
      instanceId: TEST_INSTANCE_ID,
      hostname: 'OpenWrt',
      version: '0.2.0',
      captureInterface: 'br-lan',
      apiKey: TEST_API_KEY,
      capabilities: ['gateway_stats'],
      system: { os: 'OpenWrt 24.10.2', arch: 'amd64' },
      ...params,
    })
  }

  request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = this.#nextId++
    return new Promise((resolve) => {
      this.#pending.set(id, resolve)
      this.socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    })
  }

  /** Sends a notification TO the server (`collector.push`). */
  notifyServer(method: string, params: Record<string, unknown>) {
    this.socket.send(JSON.stringify({ jsonrpc: '2.0', method, params }))
  }

  sendRaw(text: string) {
    this.socket.send(text)
  }

  /** Resolves once `method` has been received `count` times; returns those calls. */
  async waitForCount(method: string, count: number, timeoutMs = 3000): Promise<ReceivedCall[]> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const calls = this.calls.filter((call) => call.method === method)
      if (calls.length >= count) return calls
      if (Date.now() > deadline) {
        throw new Error(`collector received ${method} ${calls.length} times, wanted ${count}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }

  async waitFor(method: string, timeoutMs = 3000): Promise<ReceivedCall> {
    const calls = await this.waitForCount(method, 1, timeoutMs)
    return calls[0]
  }

  /** The params of the latest `agent.configure`. */
  lastConfigure(): Record<string, unknown> | null {
    const calls = this.calls.filter((call) => call.method === 'agent.configure')
    return calls.length > 0 ? calls[calls.length - 1].params : null
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
    if (call.id === null) return
    const handler = this.handlers[call.method]
    if (!handler) {
      this.#reply({ id: call.id, error: { code: -32601, message: 'method not found' } })
      return
    }
    try {
      this.#reply({ id: call.id, result: await handler(call.params) })
    } catch (error) {
      this.#reply({ id: call.id, error: { code: -32603, message: String(error) } })
    }
  }

  #reply(payload: Record<string, unknown>) {
    if (this.socket.readyState !== WebSocket.OPEN) return
    this.socket.send(JSON.stringify({ jsonrpc: '2.0', ...payload }))
  }
}

/** Tries a handshake and reports the HTTP refusal instead of throwing. */
export async function attemptCollectorHandshake(options: {
  authorization?: string | null
  instanceId?: string | null
  protocols?: string[]
}): Promise<{ status: 'open'; socket: WebSocket } | { status: number; body: any; headers: any }> {
  const headers: Record<string, string> = {}
  const authorization =
    options.authorization === undefined ? `Bearer ${TEST_API_KEY}` : options.authorization
  if (authorization !== null) headers.Authorization = authorization
  const instanceId = options.instanceId === undefined ? TEST_INSTANCE_ID : options.instanceId
  if (instanceId !== null) headers['X-Perch-Instance-Id'] = instanceId
  const socket = new WebSocket(
    await collectorWsUrl(),
    options.protocols ?? [COLLECTOR_SUBPROTOCOL],
    {
      headers,
    }
  )
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve({ status: 'open', socket }))
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
      if (!String(error.message).includes('Unexpected server response')) reject(error)
    })
  })
}

/** One device's cumulative counters, shaped like GET /api/v1/devices. */
export function device(
  mac: string,
  counters: { bytesIn: number; bytesOut: number; packetsIn?: number; packetsOut?: number }
) {
  return {
    mac,
    ips: ['192.168.1.100'],
    first_seen: '2026-09-21T10:00:00Z',
    last_seen: '2026-09-21T10:00:15Z',
    bytes_in: counters.bytesIn,
    bytes_out: counters.bytesOut,
    packets_in: counters.packetsIn ?? Math.round(counters.bytesIn / 1000),
    packets_out: counters.packetsOut ?? Math.round(counters.bytesOut / 1000),
    top_peers: [{ ip: '203.0.113.10', bytes_in: 100, bytes_out: 200 }],
    top_lan_peers: [],
    protocols: [
      {
        protocol: 'TLS',
        bytes_in: counters.bytesIn,
        bytes_out: counters.bytesOut,
        packets_in: counters.packetsIn ?? Math.round(counters.bytesIn / 1000),
        packets_out: counters.packetsOut ?? Math.round(counters.bytesOut / 1000),
      },
    ],
  }
}

/** `collector.push` params (or a polled summary + devices) for one reading. */
export function reading(
  devices: ReturnType<typeof device>[],
  options: { startedAt?: string; seq?: number; gateway?: Record<string, unknown> } = {}
) {
  return {
    seq: options.seq ?? 1,
    collectedAt: '2026-09-21T10:00:15Z',
    summary: {
      started_at: options.startedAt ?? '2026-09-21T10:00:00Z',
      total_devices: devices.length,
    },
    meta: { capture_interface: 'br-lan', version: '0.2.0' },
    devices,
    ...(options.gateway ? { gateway: options.gateway } : {}),
  }
}
