import hub from '#services/ap_agent_hub'
import { setAgentCommandTimeoutForTesting } from '#services/wifi_command_channel'
import { FakeAgent, RpcFailure, seedAgentAp, seedSetupComplete } from '#tests/helpers/ap_agent'
import db from '@adonisjs/lucid/services/db'
import testUtils from '@adonisjs/core/services/test_utils'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'

const CLIENT_MAC = '02:00:00:00:00:01'

async function resetDb() {
  const teardown = await testUtils.db().truncate()
  await teardown()
  return teardown
}

/** The client as the poller last saw it: on `phy0-ap0` of `apId`. */
async function seedStation(apId: number) {
  await db
    .insertQuery()
    .table('wifi_station_latest')
    .insert({
      mac: CLIENT_MAC,
      ap_id: apId,
      ifname: 'phy0-ap0',
      ssid: 'Example',
      radio: 'radio0',
      channel: 6,
      frequency_mhz: 2437,
      band: '2.4',
      signal_dbm: -50,
      inactive_ms: 10,
      recorded_at: DateTime.utc().toFormat('yyyy-MM-dd HH:mm:ss'),
    })
}

/** `/wifi/aps` answers with a bare array (plain arrays are not wrapped). */
function rowsOf(body: any): any[] {
  return Array.isArray(body) ? body : body.data
}

async function lastAudit() {
  return db.from('wifi_command_audits').orderBy('id', 'desc').first()
}

test.group('wifi commands over a perch-apd session', (group) => {
  group.each.setup(resetDb)
  group.each.setup(() => () => {
    hub.closeAll(1000, 'test reset')
    setAgentCommandTimeoutForTesting(null)
  })

  test('kick sends client.kick with the documented params and audits it', async ({
    client,
    assert,
  }) => {
    const { adminToken, adminId } = await seedSetupComplete()
    const { ap, agentId, agentSecret } = await seedAgentAp()
    await seedStation(ap.id)
    const agent = await FakeAgent.connect({
      agentId,
      agentSecret,
      handlers: {
        'client.kick': (params) => ({ mac: params.mac, ifname: 'phy0-ap1', banTimeMs: 0 }),
      },
    })

    const response = await client
      .post(`/api/v1/wifi/clients/${CLIENT_MAC}/kick`)
      .bearerToken(adminToken)
    response.assertStatus(200)
    const body = response.body().data
    assert.equal(body.ok, true)
    assert.equal(body.via, 'agent')
    assert.equal(body.apId, ap.id)
    assert.equal(body.ifname, 'phy0-ap1')
    assert.isNumber(body.latencyMs)

    const call = await agent.waitFor('client.kick')
    assert.deepEqual(call.params, {
      mac: CLIENT_MAC,
      ifname: 'phy0-ap0',
      reason: 1,
      deauth: true,
      banTimeMs: 0,
    })

    const audit = await lastAudit()
    assert.equal(audit.command, 'kick_client')
    assert.equal(audit.status, 'ok')
    assert.equal(audit.mac, CLIENT_MAC)
    assert.equal(audit.executed_by_user_id, adminId)
    assert.equal(JSON.parse(audit.params).via, 'agent')
    assert.equal(JSON.parse(audit.stdout).ifname, 'phy0-ap1')
    await agent.close()
  })

  test('steer bans for 5 s by default, or for banTimeMs', async ({ client, assert }) => {
    const { adminToken } = await seedSetupComplete()
    const { ap, agentId, agentSecret } = await seedAgentAp()
    await seedStation(ap.id)
    const seen: Array<Record<string, unknown>> = []
    const agent = await FakeAgent.connect({
      agentId,
      agentSecret,
      handlers: {
        'client.kick': (params) => {
          seen.push(params)
          return { mac: params.mac, ifname: params.ifname, banTimeMs: params.banTimeMs }
        },
      },
    })

    const byDefault = await client
      .post(`/api/v1/wifi/clients/${CLIENT_MAC}/steer`)
      .bearerToken(adminToken)
      .json({})
    byDefault.assertStatus(200)
    assert.equal(byDefault.body().data.banTimeMs, 5000)
    assert.equal(byDefault.body().data.via, 'agent')

    const custom = await client
      .post(`/api/v1/wifi/clients/${CLIENT_MAC}/steer`)
      .bearerToken(adminToken)
      .json({ banTimeMs: 12000 })
    custom.assertStatus(200)
    assert.equal(custom.body().data.banTimeMs, 12000)

    assert.deepEqual(
      seen.map((params) => params.banTimeMs),
      [5000, 12000]
    )
    assert.deepInclude(seen[0], { reason: 1, deauth: true, ifname: 'phy0-ap0' })
    const audit = await lastAudit()
    assert.equal(audit.command, 'steer_client')
    await agent.close()
  })

  test('reboot and locate map onto system.reboot and locate.*', async ({ client, assert }) => {
    const { adminToken } = await seedSetupComplete()
    const { ap, agentId, agentSecret } = await seedAgentAp()
    const agent = await FakeAgent.connect({
      agentId,
      agentSecret,
      handlers: {
        'system.reboot': (params) => ({ scheduled: true, delaySeconds: params.delaySeconds }),
        'locate.start': (params) => ({
          active: true,
          durationSeconds: params.durationSeconds,
          leds: 6,
          endsAt: new Date().toISOString(),
        }),
        'locate.stop': () => ({ active: false }),
      },
    })

    const reboot = await client.post(`/api/v1/wifi/aps/${ap.id}/reboot`).bearerToken(adminToken)
    reboot.assertStatus(200)
    assert.deepInclude(reboot.body().data, { ok: true, apId: ap.id, via: 'agent' })
    const rebootCall = await agent.waitFor('system.reboot')
    assert.deepEqual(rebootCall.params, { delaySeconds: 2 })
    const rebootAudit = await lastAudit()
    assert.equal(rebootAudit.command, 'reboot_ap')

    const locate = await client
      .post(`/api/v1/wifi/aps/${ap.id}/locate`)
      .bearerToken(adminToken)
      .json({})
    locate.assertStatus(200)
    assert.deepInclude(locate.body().data, {
      ok: true,
      apId: ap.id,
      via: 'agent',
      active: true,
      durationSeconds: 30,
    })
    const locateCall = await agent.waitFor('locate.start')
    assert.deepEqual(locateCall.params, { durationSeconds: 30 })

    const longer = await client
      .post(`/api/v1/wifi/aps/${ap.id}/locate`)
      .bearerToken(adminToken)
      .json({ durationSeconds: 45 })
    longer.assertStatus(200)
    assert.equal(longer.body().data.durationSeconds, 45)

    const stop = await client
      .post(`/api/v1/wifi/aps/${ap.id}/locate`)
      .bearerToken(adminToken)
      .json({ stop: true })
    stop.assertStatus(200)
    assert.deepInclude(stop.body().data, { active: false, durationSeconds: 0, via: 'agent' })
    await agent.waitFor('locate.stop')
    const stopAudit = await lastAudit()
    assert.equal(stopAudit.command, 'locate_ap_stop')

    const invalid = await client
      .post(`/api/v1/wifi/aps/${ap.id}/locate`)
      .bearerToken(adminToken)
      .json({ durationSeconds: 601 })
    invalid.assertStatus(422)
    await agent.close()
  })

  test('an offline agent is a 409, and the attempt is audited', async ({ client, assert }) => {
    const { adminToken } = await seedSetupComplete()
    const { ap } = await seedAgentAp()
    await seedStation(ap.id)

    const kick = await client
      .post(`/api/v1/wifi/clients/${CLIENT_MAC}/kick`)
      .bearerToken(adminToken)
    kick.assertStatus(409)
    kick.assertBodyContains({ error: 'agent_offline' })
    const audit = await lastAudit()
    assert.equal(audit.status, 'failed')
    assert.equal(audit.stderr, 'agent offline')

    const reboot = await client.post(`/api/v1/wifi/aps/${ap.id}/reboot`).bearerToken(adminToken)
    reboot.assertStatus(409)
  })

  test('agent errors map to 404 / 400 and a silent agent to 504', async ({ client, assert }) => {
    const { adminToken } = await seedSetupComplete()
    const { ap, agentId, agentSecret } = await seedAgentAp()
    await seedStation(ap.id)
    let mode: 'not_found' | 'unsupported' | 'failed' | 'silent' = 'not_found'
    const agent = await FakeAgent.connect({
      agentId,
      agentSecret,
      handlers: {
        'client.kick': () => {
          if (mode === 'not_found') {
            throw new RpcFailure(-32002, '02:00:00:00:00:01 is not associated with this AP')
          }
          if (mode === 'unsupported') throw new RpcFailure(-32001, 'no hostapd ubus object')
          if (mode === 'failed') throw new RpcFailure(-32000, 'ubus call failed: Not found')
          return new Promise(() => {})
        },
      },
    })

    const notFound = await client
      .post(`/api/v1/wifi/clients/${CLIENT_MAC}/kick`)
      .bearerToken(adminToken)
    notFound.assertStatus(404)
    notFound.assertBodyContains({ error: 'wifi_client_not_associated' })

    mode = 'unsupported'
    const unsupported = await client
      .post(`/api/v1/wifi/clients/${CLIENT_MAC}/kick`)
      .bearerToken(adminToken)
    unsupported.assertStatus(400)
    unsupported.assertBodyContains({
      error: 'wifi_command_unsupported',
      message: 'no hostapd ubus object',
    })

    mode = 'failed'
    const failed = await client
      .post(`/api/v1/wifi/clients/${CLIENT_MAC}/kick`)
      .bearerToken(adminToken)
    failed.assertStatus(400)
    failed.assertBodyContains({
      error: 'wifi_command_failed',
      message: 'ubus call failed: Not found',
    })

    mode = 'silent'
    setAgentCommandTimeoutForTesting(200)
    const silent = await client
      .post(`/api/v1/wifi/clients/${CLIENT_MAC}/kick`)
      .bearerToken(adminToken)
    silent.assertStatus(504)
    silent.assertBodyContains({ error: 'agent_timeout' })
    const timeoutAudit = await lastAudit()
    assert.equal(timeoutAudit.status, 'failed')
    await agent.close()
  })

  test('/wifi/aps reports transport, online state and controls', async ({ client, assert }) => {
    const { adminToken } = await seedSetupComplete()
    const { ap, agentId, agentSecret } = await seedAgentAp({ capabilities: [] })

    const offline = await client.get('/api/v1/wifi/aps').bearerToken(adminToken)
    offline.assertStatus(200)
    const offlineRow = rowsOf(offline.body()).find((row: any) => row.id === ap.id)
    assert.equal(offlineRow.transport, 'agent')
    assert.equal(offlineRow.agentOnline, false)
    assert.deepEqual(offlineRow.controls, {
      via: 'agent',
      online: false,
      kick: false,
      steer: false,
      locate: false,
      reboot: false,
    })

    const agent = await FakeAgent.connect({
      agentId,
      agentSecret,
      handlers: {
        'system.info': () => ({
          agentVersion: '0.1.0',
          capabilities: ['metrics', 'kick', 'reboot'],
        }),
      },
    })
    await agent.waitFor('system.info')
    // Capabilities land asynchronously after the system.info answer.
    let onlineRow: any
    for (let i = 0; i < 40; i++) {
      const online = await client.get('/api/v1/wifi/aps').bearerToken(adminToken)
      onlineRow = rowsOf(online.body()).find((row: any) => row.id === ap.id)
      if (onlineRow.controls.kick) break
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    assert.equal(onlineRow.agentOnline, true)
    assert.deepEqual(onlineRow.controls, {
      via: 'agent',
      online: true,
      kick: true,
      steer: true,
      locate: false,
      reboot: true,
    })

    const overview = await client.get('/api/v1/wifi/overview').bearerToken(adminToken)
    overview.assertStatus(200)
    const overviewRows = overview.body().data.accessPoints as any[]
    const overviewRow = overviewRows.find((row) => row.id === ap.id)
    assert.equal(overviewRow.transport, 'agent')
    assert.equal(overviewRow.controls.via, 'agent')
    await agent.close()
  })

  test('scrape rows keep the SSH / no-channel behaviour and report it', async ({
    client,
    assert,
  }) => {
    const { adminToken } = await seedSetupComplete()
    const now = DateTime.utc().toFormat('yyyy-MM-dd HH:mm:ss')
    const [sshId] = await db.insertQuery().table('wifi_access_points').insert({
      name: 'ssh-ap',
      metrics_url: 'http://192.168.1.17:9100/metrics',
      poll_interval_seconds: 15,
      enabled: 1,
      enable_two_way_commands: 1,
      ssh_host: '192.168.1.17',
      ssh_port: 22,
      ssh_username: 'root',
      created_at: now,
      updated_at: now,
    })
    const [plainId] = await db.insertQuery().table('wifi_access_points').insert({
      name: 'plain-ap',
      metrics_url: 'http://192.168.1.18:9100/metrics',
      poll_interval_seconds: 15,
      enabled: 1,
      enable_two_way_commands: 0,
      ssh_port: 22,
      created_at: now,
      updated_at: now,
    })

    const aps = await client.get('/api/v1/wifi/aps').bearerToken(adminToken)
    const ssh = rowsOf(aps.body()).find((row: any) => row.id === sshId)
    const plain = rowsOf(aps.body()).find((row: any) => row.id === plainId)
    assert.equal(ssh.transport, 'scrape')
    assert.isNull(ssh.agentOnline)
    assert.deepEqual(ssh.controls, {
      via: 'ssh',
      online: true,
      kick: true,
      steer: true,
      locate: true,
      reboot: true,
    })
    assert.equal(plain.controls.via, null)

    const refused = await client.post(`/api/v1/wifi/aps/${plainId}/locate`).bearerToken(adminToken)
    refused.assertStatus(400)
    refused.assertBodyContains({ error: 'wifi_commands_not_enabled' })

    const stop = await client
      .post(`/api/v1/wifi/aps/${sshId}/locate`)
      .bearerToken(adminToken)
      .json({ stop: true })
    stop.assertStatus(400)
    stop.assertBodyContains({ error: 'wifi_command_unsupported' })
  })
})
