import Collector from '#models/collector'
import Gateway from '#models/gateway'
import type { GatewayMode } from '#services/gateway_config/types'
import { setSqmPlaneWriter, StubSqmPlaneWriter } from '#services/sqm_plane'
import testUtils from '@adonisjs/core/services/test_utils'

/** Truncates everything and puts a fresh stub plane writer in place; returns the stub. */
export async function resetQosTests(): Promise<StubSqmPlaneWriter> {
  const teardown = await testUtils.db().truncate()
  await teardown()
  const stub = new StubSqmPlaneWriter()
  setSqmPlaneWriter(stub)
  return stub
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
  } = {}
): Promise<{ gateway: Gateway; collector: Collector }> {
  const collector = await Collector.create({
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
