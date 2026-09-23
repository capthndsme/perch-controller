import Collector from '#models/collector'
import Gateway from '#models/gateway'
import type { GatewayMode } from '#services/gateway_config/types'
import { apiKeyFingerprint } from '#services/collector_announce'
import { _resetQosLive } from '#services/qos_live'
import {
  setQosPlaneWriter,
  StubQosPlaneWriter,
  type QosConfigChange,
  type QosPlaneAccepted,
  type QosPlaneWriter,
} from '#services/qos_plane'
import { _resetQosSync, setQosSyncTiming } from '#services/qos_sync'
import { setSqmPlaneWriter, StubSqmPlaneWriter } from '#services/sqm_plane'
import { TEST_API_KEY, TEST_INSTANCE_ID } from '#tests/helpers/collector_agent'
import { closeAgentSessions, resetInfraState } from '#tests/helpers/infra'
import testUtils from '@adonisjs/core/services/test_utils'

/**
 * Truncates everything, forgets the in-process QoS state (sender, live
 * reports, plan cache), closes agent sessions, makes the sender's debounces
 * zero and puts fresh stub plane writers in place; returns the sqm stub.
 */
export async function resetQosTests(): Promise<StubSqmPlaneWriter> {
  closeAgentSessions()
  const teardown = await testUtils.db().truncate()
  await teardown()
  resetInfraState()
  _resetQosSync()
  _resetQosLive()
  setQosSyncTiming({ deviceDebounceMs: 0, configDebounceMs: 0 })
  setQosPlaneWriter(new StubQosPlaneWriter())
  const stub = new StubSqmPlaneWriter()
  setSqmPlaneWriter(stub)
  return stub
}

/** A plane writer that accepts every package (revision counts up) and keeps them. */
export class AcceptingQosPlaneWriter implements QosPlaneWriter {
  readonly accepted: QosConfigChange[] = []
  revision = 0

  async submit(change: QosConfigChange): Promise<QosPlaneAccepted> {
    this.accepted.push(structuredClone(change))
    this.revision++
    return { revision: this.revision }
  }
}

/**
 * A collector on a router with its gateway row. `wanInterfaces` is what its
 * last gateway report named (the devices a WAN queue may shape).
 */
export async function seedQosGateway(
  options: {
    mode?: GatewayMode
    wanInterfaces?: string[]
    name?: string
    packages?: Record<string, string>
    /** Bind the collector to the fake agent's identity (`FakeCollector`). */
    agent?: boolean
  } = {}
): Promise<{ gateway: Gateway; collector: Collector }> {
  const collector = await Collector.create({
    ...(options.agent
      ? {
          instanceId: TEST_INSTANCE_ID,
          apiKey: TEST_API_KEY,
          apiKeyFingerprint: apiKeyFingerprint(TEST_API_KEY),
          version: '1.0.0',
        }
      : {}),
    name: options.name ?? 'gateway',
    baseUrl: null,
    pollIntervalSeconds: 5,
    enabled: true,
    lifecycle: 'adopted',
    source: 'announced',
    transport: 'agent',
    lastStatus: {
      ok: true,
      checkedAt: new Date().toISOString(),
      gateway: {
        reportedAt: new Date().toISOString(),
        wanInterfaces: options.wanInterfaces ?? ['wan0'],
        wanSource: 'default-route',
      },
    },
  } as Partial<Collector>)
  const gateway = await Gateway.create({
    collectorId: collector.id,
    mode: options.mode ?? 'managed',
    capabilities: {
      protocol: 1,
      access: 'write',
      transportOk: true,
      packages: options.packages ?? { 'sqm-scripts': '1.6.0', 'luci-app-sqm': '1.6.0' },
    },
  })
  return { gateway, collector }
}

/** What perch-collector's `qos.probe` answers on a capable router (plan 3 section 6). */
export const PROBE = {
  sqm: { installed: true, version: '1.6.0', luci: true, queues: ['wan'] },
  kernel: {
    htb: true,
    fq_codel: true,
    cake: true,
    ifb: true,
    clsact: true,
    flower: true,
    skbedit: true,
    mirred: true,
    matchall: true,
  },
  conflicts: [],
  flowOffload: { software: true, hardware: false },
  lanDevices: [{ network: 'lan', device: 'br-lan', prefixes: ['192.168.1.0/24'] }],
}
