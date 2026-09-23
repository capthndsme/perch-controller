import QosGatewayState from '#models/qos_gateway_state'
import { recordQosReport } from '#services/qos_live'
import { setQosPlaneWriter, StubQosPlaneWriter } from '#services/qos_plane'
import { flushQosSync, QOS_NOT_ACTIVE, sweepQosSync } from '#services/qos_sync'
import { eventually, seedSetupComplete } from '#tests/helpers/ap_agent'
import { FakeCollector, rpcError } from '#tests/helpers/collector_agent'
import { AcceptingQosPlaneWriter, PROBE, resetQosTests, seedQosGateway } from '#tests/helpers/qos'
import type { ApiClient } from '@japa/api-client'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'

const MAC1 = '02:00:00:00:00:21'
const MAC2 = '02:00:00:00:00:22'

function bodyOf(response: { body(): unknown }): any {
  return response.body()
}

type SetParams = { revision: number; devices: Array<Record<string, any>> }

/** A fake collector that answers the QoS RPCs; `setReply` decides each `qos.devices.set`. */
async function connectAgent(
  setReply: (params: SetParams) => unknown = (params) => ({
    revision: params.revision,
    accepted: params.devices.length,
    rejected: [],
  })
) {
  const agent = await FakeCollector.connect({
    handlers: {
      'qos.probe': () => PROBE,
      'qos.devices.set': (params) => setReply(params as SetParams),
    },
  })
  const reply = await agent.hello()
  if (!reply.result) throw new Error(`hello refused: ${JSON.stringify(reply)}`)
  return agent
}

function sets(agent: FakeCollector): SetParams[] {
  return agent.calls
    .filter((call) => call.method === 'qos.devices.set')
    .map((call) => call.params as SetParams)
}

async function setup() {
  const tokens = await seedSetupComplete()
  const { gateway, collector } = await seedQosGateway({ agent: true })
  return { ...tokens, gateway, collector }
}

function post(client: ApiClient, token: string, path: string, body: Record<string, unknown>) {
  return client.post(`/api/v1/qos/${path}`).bearerToken(token).json(body)
}

async function overview(client: ApiClient, token: string) {
  const response = await client.get('/api/v1/qos').bearerToken(token)
  response.assertStatus(200)
  return bodyOf(response).data
}

test.group('qos | device-set delivery (fake agent on the hub)', (group) => {
  group.each.setup(async () => {
    await resetQosTests()
  })

  test('on connect: probe, then the entries; a change sends a new revision', async ({
    client,
    assert,
  }) => {
    const { adminToken, operatorToken } = await setup()
    const policy = bodyOf(
      await post(client, adminToken, 'policies', {
        name: 'Kids',
        each: { downloadKbit: 2000, uploadKbit: 1000 },
      })
    ).data
    await post(client, adminToken, 'assignments', {
      target: { type: 'device', mac: MAC1 },
      policyId: policy.id,
    })
    await flushQosSync()

    const agent = await connectAgent()
    try {
      await agent.waitFor('qos.probe')
      const first = await agent.waitFor('qos.devices.set')
      assert.deepEqual(first.params, {
        revision: 1,
        devices: [
          {
            mac: MAC1,
            bucket: null,
            downKbit: 2000,
            upKbit: 1000,
            quota: null,
            expiresAt: null,
          },
        ],
      })
      await flushQosSync()
      let view = await overview(client, operatorToken)
      assert.containsSubset(view, {
        managed: true,
        online: true,
        agentSupportsQos: true,
        devices: { state: 'in_sync', revision: 1, entries: 1, rejected: [], error: null },
        capabilities: {
          sqm: { installed: true, version: '1.6.0', luci: true },
          shaper: { available: true, missing: [] },
          conflicts: [],
          flowOffload: { software: true, hardware: false },
        },
      })

      // A second device: revision 2 with both entries.
      await post(client, adminToken, 'assignments', {
        target: { type: 'device', mac: MAC2 },
        rate: { downloadKbit: 5000, uploadKbit: null },
      })
      await flushQosSync()
      await agent.waitForCount('qos.devices.set', 2)
      assert.equal(sets(agent)[1].revision, 2)
      assert.deepEqual(
        sets(agent)[1].devices.map((d) => [d.mac, d.downKbit, d.upKbit]),
        [
          [MAC1, 2000, 1000],
          [MAC2, 5000, null],
        ]
      )

      // A change the router does not see (notes) and the sweep send nothing.
      await client
        .patch(`/api/v1/qos/policies/${policy.id}`)
        .bearerToken(adminToken)
        .json({ notes: 'tablets' })
      await flushQosSync()
      await sweepQosSync()
      await flushQosSync()
      assert.lengthOf(sets(agent), 2)
      const state = await QosGatewayState.firstOrFail()
      assert.equal(Number(state.devicesRevision), 2)
      assert.equal(Number(state.devicesAckedRevision), 2)

      // A reconnect gets the entries again (new session), with a new revision.
      await agent.close()
      view = await overview(client, operatorToken)
      assert.equal(view.online, false)
    } finally {
      await agent.close()
    }
    const again = await connectAgent()
    try {
      const resent = await again.waitFor('qos.devices.set')
      assert.equal(resent.params.revision, 3)
      assert.lengthOf(resent.params.devices as unknown[], 2)
    } finally {
      await again.close()
    }
  })

  test('offline writes wait; qos_not_active is retried once the router says active', async ({
    client,
    assert,
  }) => {
    const { adminToken, operatorToken, collector } = await setup()
    await post(client, adminToken, 'assignments', {
      target: { type: 'device', mac: MAC1 },
      rate: { downloadKbit: 2000, uploadKbit: 1000 },
    })
    await flushQosSync()
    let view = await overview(client, operatorToken)
    assert.containsSubset(view, { online: false, devices: { state: 'offline' } })

    let active = false
    const agent = await connectAgent((params) => {
      if (!active) throw rpcError(QOS_NOT_ACTIVE, 'qos_not_active')
      return { revision: params.revision, accepted: params.devices.length, rejected: [] }
    })
    try {
      await agent.waitFor('qos.devices.set')
      await flushQosSync()
      view = await overview(client, operatorToken)
      assert.containsSubset(view.devices, { state: 'queued', error: 'qos_not_active' })
      // An inactive agent is retried when its report says active, not before.
      await recordQosReport(collector.id, { epoch: 'e1', state: 'error', devicesRevision: 0 })
      await flushQosSync()
      assert.lengthOf(sets(agent), 1)

      active = true
      // The router reports an active shaper: resend.
      await recordQosReport(
        collector.id,
        { epoch: 'e1', state: 'active', configRevision: 0, devicesRevision: 0 },
        DateTime.utc().plus({ seconds: 5 })
      )
      await flushQosSync()
      await eventually(
        () => overview(client, operatorToken),
        (v) => v.devices.state === 'in_sync'
      )
    } finally {
      await agent.close()
    }
  })

  test('a new epoch resends; refused entries show up per device', async ({ client, assert }) => {
    const { adminToken, operatorToken, collector } = await setup()
    await post(client, adminToken, 'assignments', {
      target: { type: 'device', mac: MAC1 },
      rate: { downloadKbit: 2000, uploadKbit: 1000 },
    })
    await post(client, adminToken, 'assignments', {
      target: { type: 'device', mac: MAC2 },
      rate: { downloadKbit: 2000, uploadKbit: 1000 },
    })
    const agent = await connectAgent((params) => ({
      revision: params.revision,
      accepted: params.devices.length - 1,
      rejected: [{ mac: MAC2, error: 'router_mac' }],
    }))
    try {
      await agent.waitFor('qos.devices.set')
      await flushQosSync()
      const now = DateTime.utc()
      await recordQosReport(
        collector.id,
        {
          epoch: 'a',
          state: 'active',
          devicesRevision: 1,
          devices: [{ mac: MAC1, classId: '1:200' }],
        },
        now
      )
      await flushQosSync()
      assert.lengthOf(sets(agent), 1)

      const devices = await client.get('/api/v1/qos/devices').bearerToken(operatorToken)
      devices.assertStatus(200)
      const byMac = Object.fromEntries(bodyOf(devices).data.map((d: any) => [d.mac, d]))
      assert.equal(byMac[MAC1].state, 'enforced')
      assert.equal(byMac[MAC1].classId, '1:200')
      assert.equal(byMac[MAC2].state, 'failed')
      const view = await overview(client, operatorToken)
      assert.deepInclude(view.errors, {
        code: 'qos_entry_rejected',
        message: 'router_mac',
        mac: MAC2,
      })

      // The agent restarted its shaper: a new epoch gets the entries again.
      await recordQosReport(
        collector.id,
        { epoch: 'b', state: 'active', devicesRevision: 0 },
        now.plus({ seconds: 5 })
      )
      await flushQosSync()
      await agent.waitForCount('qos.devices.set', 2)
    } finally {
      await agent.close()
    }
  })

  test('the perch-qos package goes to the config plane; pause and resume', async ({
    client,
    assert,
  }) => {
    const { adminToken, operatorToken, collector, gateway } = await setup()
    const stub = new StubQosPlaneWriter()
    setQosPlaneWriter(stub)
    const guest = bodyOf(
      await post(client, adminToken, 'policies', {
        name: 'Guest',
        shared: { downloadKbit: 50000, uploadKbit: 10000 },
        each: { downloadKbit: 5000, uploadKbit: 1000 },
      })
    ).data
    await post(client, adminToken, 'assignments', {
      target: { type: 'network', network: 'guest' },
      policyId: guest.id,
    })
    await flushQosSync()
    assert.isAbove(stub.recorded.length, 0)
    const last = stub.recorded[stub.recorded.length - 1]
    assert.equal(last.gatewayId, gateway.id)
    assert.deepEqual(
      last.sections.map((s) => `${s.type}:${s.name}`),
      ['globals:globals', 'bucket:b2', 'network:guest']
    )
    let view = await overview(client, operatorToken)
    assert.containsSubset(view.config, { state: 'queued', error: 'plane_unavailable' })

    // With a plane that accepts: queued until the router reports the revision.
    const plane = new AcceptingQosPlaneWriter()
    setQosPlaneWriter(plane)
    await client
      .patch(`/api/v1/qos/policies/${guest.id}`)
      .bearerToken(adminToken)
      .json({ shared: { downloadKbit: 40000, uploadKbit: 10000 } })
    await flushQosSync()
    assert.lengthOf(plane.accepted, 1)
    assert.equal(plane.accepted[0].sections[1].options.down_kbit, '40000')
    view = await overview(client, operatorToken)
    assert.containsSubset(view.config, { state: 'queued', revision: 1, error: null })
    await recordQosReport(collector.id, { epoch: 'x', state: 'active', configRevision: 1 })
    view = await overview(client, operatorToken)
    assert.equal(view.config.state, 'in_sync')
    // Unchanged: not submitted again.
    await sweepQosSync()
    await flushQosSync()
    assert.lengthOf(plane.accepted, 1)

    // Pause: globals.enabled '0'.
    const paused = await post(client, adminToken, 'pause', {})
    paused.assertStatus(200)
    assert.containsSubset(bodyOf(paused).data, { paused: { by: 'controller' } })
    await flushQosSync()
    assert.equal(plane.accepted[plane.accepted.length - 1].sections[0].options.enabled, '0')
    const operatorPause = await post(client, operatorToken, 'pause', {})
    operatorPause.assertStatus(403)

    const resumed = await post(client, adminToken, 'resume', {})
    resumed.assertStatus(200)
    assert.isNull(bodyOf(resumed).data.paused)
    await flushQosSync()
    assert.equal(plane.accepted[plane.accepted.length - 1].sections[0].options.enabled, '1')

    // A router-side pause: resume needs overrideRouter.
    await recordQosReport(collector.id, {
      epoch: 'x',
      state: 'paused',
      pausedBy: 'router',
      configRevision: 3,
    })
    view = await overview(client, operatorToken)
    assert.containsSubset(view.paused, { by: 'router' })
    const refused = await post(client, adminToken, 'resume', {})
    refused.assertStatus(409)
    assert.equal(bodyOf(refused).error, 'qos_paused_on_router')
    const overridden = await post(client, adminToken, 'resume', { overrideRouter: true })
    overridden.assertStatus(200)
    await flushQosSync()
    assert.isTrue(plane.accepted[plane.accepted.length - 1].overrideRouterPause)
  })

  test('a collector without the shaper is asked once per session, not by every sweep', async ({
    client,
    assert,
  }) => {
    const { adminToken, operatorToken } = await setup()
    await post(client, adminToken, 'assignments', {
      target: { type: 'device', mac: MAC1 },
      rate: { downloadKbit: 5000, uploadKbit: null },
    })
    await flushQosSync()

    // perch-qos not installed: the collector has no qos.* methods.
    let agent = await FakeCollector.connect({ handlers: {} })
    await agent.hello()
    try {
      await agent.waitFor('qos.devices.set')
      await flushQosSync()
      await sweepQosSync()
      await flushQosSync()
      await sweepQosSync()
      await flushQosSync()
      assert.lengthOf(sets(agent), 1)
      assert.containsSubset(await overview(client, operatorToken), {
        agentSupportsQos: false,
        devices: { state: 'failed', error: 'qos_unsupported' },
      })
    } finally {
      await agent.close()
    }

    // A new session (perch-qos may have been installed meanwhile): asked again, once.
    agent = await FakeCollector.connect({ handlers: {} })
    await agent.hello()
    try {
      await agent.waitFor('qos.devices.set')
      await flushQosSync()
      await sweepQosSync()
      await flushQosSync()
      assert.lengthOf(sets(agent), 1)
    } finally {
      await agent.close()
    }
  })
})
