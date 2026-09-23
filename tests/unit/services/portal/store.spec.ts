import Gateway from '#models/gateway'
import Portal from '#models/portal'
import PortalAuthorization from '#models/portal_authorization'
import PortalEvent from '#models/portal_event'
import PortalGatewayState from '#models/portal_gateway_state'
import PortalGrant from '#models/portal_grant'
import PortalSession from '#models/portal_session'
import PortalUser from '#models/portal_user'
import Voucher from '#models/voucher'
import VoucherBatch from '#models/voucher_batch'
import { normalizeVoucherCode, voucherHint } from '#services/portal/codes'
import { reconcile, type RouterPortalReport } from '#services/portal/reconcile'
import { bindInsertedGrantIds } from '#services/portal/messages'
import { hashVoucherCode, voucherVerifierFor } from '#services/portal_keys'
import { prunePortalHistory } from '#services/portal_retention'
import { updatePortalSettings } from '#services/portal_settings'
import {
  applyPortalDbChanges,
  ensurePortalGatewayState,
  loadServerPortalState,
} from '#services/portal_store'
import testUtils from '@adonisjs/core/services/test_utils'
import db from '@adonisjs/lucid/services/db'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'

const MAC_A = '02:00:00:00:00:0a'
const MAC_B = '02:00:00:00:00:0b'
const NOW = Date.UTC(2026, 8, 23, 12, 0, 0)
const HOUR = 3_600_000
const at = (millis: number) => DateTime.fromMillis(millis, { zone: 'utc' })

async function gateway() {
  return Gateway.create({ collectorId: null })
}

async function portal(gatewayId: number, network = 'net1', patch: Partial<Portal> = {}) {
  return Portal.create({
    gatewayId,
    name: `Guest ${network}`,
    networkPerchId: network,
    methods: { voucher: true, password: false },
    ...patch,
  })
}

async function batch(portalId: number | null, patch: Partial<VoucherBatch> = {}) {
  return VoucherBatch.create({
    portalId,
    name: 'Day passes',
    count: 1,
    codeLength: 10,
    durationMinutes: 120,
    durationMode: 'wall_clock',
    startMode: 'first_use',
    maxDevices: 1,
    ...patch,
  })
}

async function voucher(batchId: number, code: string, patch: Partial<Voucher> = {}) {
  return Voucher.create({
    batchId,
    codeHash: hashVoucherCode(code)!,
    code: normalizeVoucherCode(code)!,
    hint: voucherHint(code),
    ...patch,
  })
}

async function voucherIn(
  portalId: number | null,
  code: string,
  batchPatch: Partial<VoucherBatch> = {}
) {
  const b = await batch(portalId, batchPatch)
  return voucher(b.id, code)
}

test.group('portal store: schema', (group) => {
  group.each.setup(() => testUtils.db().truncate())

  test('several portals per gateway, one live portal per network (decision 19)', async ({
    assert,
  }) => {
    const gw = await gateway()
    const first = await portal(gw.id, 'net1')
    await portal(gw.id, 'net2')
    await assert.rejects(() => portal(gw.id, 'net1'), /Duplicate entry/)
    // Soft-deleting frees the network.
    first.deletedAt = DateTime.utc()
    await first.save()
    await portal(gw.id, 'net1')
    // Another gateway may use the same network id.
    const gw2 = await gateway()
    await portal(gw2.id, 'net1')
    assert.equal(
      await Portal.query()
        .where('gateway_id', gw.id)
        .count('* as n')
        .first()
        .then((r) => Number(r!.$extras.n)),
      3
    )
  })

  test('deleting a gateway removes its portals and their data', async ({ assert }) => {
    const gw = await gateway()
    const p = await portal(gw.id)
    const b = await batch(p.id)
    await voucher(b.id, 'K7Q2M9XH4D')
    await PortalGrant.create({
      portalId: p.id,
      mac: MAC_A,
      source: 'admin',
      groupKey: 'g:1',
      state: 'active',
    })
    await ensurePortalGatewayState(gw.id)
    await gw.delete()
    for (const table of [
      'portals',
      'voucher_batches',
      'vouchers',
      'portal_grants',
      'portal_gateway_states',
    ]) {
      const [rows] = await db.rawQuery(`SELECT COUNT(*) AS n FROM ${table}`)
      assert.equal(Number(rows[0].n), 0, table)
    }
  })

  test('voucher codes are stored hashed and encrypted, never serialized', async ({ assert }) => {
    const gw = await gateway()
    const p = await portal(gw.id)
    const b = await batch(p.id)
    const v = await voucher(b.id, 'k7q2m-9xh4d')
    const [raw] = await db.rawQuery(
      'SELECT code_hash, code_encrypted, hint FROM vouchers WHERE id = ?',
      [v.id]
    )
    assert.equal(raw[0].code_hash, hashVoucherCode('K7Q2M9XH4D'))
    assert.notInclude(raw[0].code_encrypted, 'K7Q2M9XH4D')
    assert.equal(raw[0].hint, 'XH4D')
    const fresh = await Voucher.findOrFail(v.id)
    assert.equal(fresh.code, 'K7Q2M9XH4D')
    assert.notProperty(fresh.serialize(), 'code')
    assert.notProperty(fresh.serialize(), 'codeHash')
  })

  test('portal user passwords are hashed and verified, never serialized', async ({ assert }) => {
    const u = await PortalUser.create({
      username: 'guest.one',
      password: 'correct horse',
      enabled: true,
      maxDevices: 2,
    })
    const fresh = await PortalUser.findOrFail(u.id)
    assert.notEqual(fresh.password, 'correct horse')
    assert.isTrue(await fresh.verifyPassword('correct horse'))
    assert.isFalse(await fresh.verifyPassword('wrong'))
    assert.notProperty(fresh.serialize(), 'password')
    // Saving without touching the password does not re-hash it.
    const hashBefore = fresh.password
    fresh.displayName = 'Guest One'
    await fresh.save()
    const reread = await PortalUser.findOrFail(u.id)
    assert.equal(reread.password, hashBefore)
  })
})

test.group('portal store: load, reconcile, apply', (group) => {
  group.each.setup(() => testUtils.db().truncate())

  test('a full round trip is idempotent through the database', async ({ assert }) => {
    const gw = await gateway()
    const p = await portal(gw.id)
    const b = await batch(p.id)
    const running = await voucher(b.id, 'AAAAA-BBBBB', {
      boundPortalId: p.id,
      firstUsedAt: at(NOW - HOUR),
      startsAt: at(NOW - HOUR),
      expiresAt: at(NOW + HOUR),
      bytesUsed: 100,
    })
    const unused = await voucher(b.id, 'CCCCC-DDDDD')
    const grant = await PortalGrant.create({
      portalId: p.id,
      mac: MAC_A,
      source: 'voucher',
      groupKey: `v:${running.id}`,
      voucherId: running.id,
      state: 'pending_device',
      delivery: 'pending',
      revision: 1,
      bytesDown: 100,
      createdAt: at(NOW - HOUR),
    })
    await ensurePortalGatewayState(gw.id)

    const report: RouterPortalReport = {
      lastEventSeq: 3,
      truncated: false,
      events: [
        {
          seq: 1,
          at: NOW - 60_000,
          type: 'offline_redeemed',
          portalId: p.id,
          mac: MAC_B,
          voucherId: unused.id,
          localRef: 'o1',
          placement: 'current',
          startsAt: NOW - 60_000,
          expiresAt: NOW - 60_000 + 2 * HOUR,
        },
        {
          seq: 2,
          at: NOW - 59_000,
          type: 'grant_active',
          portalId: p.id,
          mac: MAC_B,
          grantId: null,
          localRef: 'o1',
        },
        {
          seq: 3,
          at: NOW - 30_000,
          type: 'external_auth',
          portalId: p.id,
          mac: '02:00:00:00:00:ee',
        },
      ],
      grants: [
        {
          grantId: Number(grant.id),
          localRef: null,
          portalId: p.id,
          mac: MAC_A,
          ip: '192.168.20.10',
          bytesUp: 50,
          bytesDown: 400,
          activeSeconds: 0,
          state: 'active',
          lastSeenAt: NOW - 1000,
          revision: 1,
        },
        {
          grantId: null,
          localRef: 'o1',
          portalId: p.id,
          mac: MAC_B,
          ip: '192.168.20.11',
          bytesUp: 5,
          bytesDown: 20,
          activeSeconds: 0,
          state: 'active',
          lastSeenAt: NOW - 1000,
          revision: 1,
        },
      ],
      externals: [
        {
          portalId: p.id,
          mac: '02:00:00:00:00:ee',
          ip: null,
          since: null,
          bytesUp: 0,
          bytesDown: 0,
        },
      ],
    }

    const server = await loadServerPortalState(gw.id, { now: NOW, report })
    assert.deepEqual(server.portals, [{ id: p.id, enabled: true }])
    assert.lengthOf(server.grants, 1)
    assert.equal(server.grants[0].createdAt, NOW - HOUR)
    const loadedRunning = server.vouchers.find((v) => v.id === running.id)!
    assert.equal(loadedRunning.limits.expiresAt, NOW + HOUR)
    assert.equal(loadedRunning.limits.durationSeconds, 7200)
    assert.equal(loadedRunning.verifier, voucherVerifierFor(gw.id, 1, 'AAAAABBBBB'))

    const { dbChanges, desired } = reconcile(server, report, false)
    const ids = await applyPortalDbChanges(gw.id, dbChanges, { now: NOW })
    const offlineId = ids.get('o1')!
    assert.isNumber(offlineId)

    const g1 = await PortalGrant.findOrFail(grant.id)
    assert.include(g1.$attributes, { state: 'active', delivery: 'applied', ip: '192.168.20.10' })
    assert.equal(Number(g1.bytesDown), 400)
    assert.equal(g1.startedAt!.toMillis(), NOW)
    const g2 = await PortalGrant.findOrFail(offlineId)
    assert.include(g2.$attributes, {
      state: 'active',
      localRef: 'o1',
      mac: MAC_B,
      groupKey: `v:${unused.id}`,
    })

    const v1 = await Voucher.findOrFail(running.id)
    assert.equal(Number(v1.bytesUsed), 100 + 50 + 300)
    const v2 = await Voucher.findOrFail(unused.id)
    assert.equal(v2.boundPortalId, p.id)
    assert.equal(v2.firstUsedAt!.toMillis(), NOW - 60_000)
    assert.equal(v2.expiresAt!.toMillis(), NOW - 60_000 + 2 * HOUR)
    assert.equal(Number(v2.bytesUsed), 25)
    assert.equal(v2.revision, 2)

    const sessions = await PortalSession.query().orderBy('id')
    assert.lengthOf(sessions, 2)
    assert.isNull(sessions[0].endedAt)
    const events = await PortalEvent.query().orderBy('id')
    assert.deepEqual(
      events.map((e) => e.type),
      ['offline_redeemed', 'external_auth_reverted']
    )
    assert.equal(Number(events[0].grantId), offlineId)
    assert.deepEqual(events[1].detail, { ip: null, authoritative: false, seq: 3 })
    const gwState = await PortalGatewayState.findOrFail(gw.id)
    assert.equal(Number(gwState.ackedEventSeq), 3)

    // What goes to the router: the new grant gets its id.
    const bound = bindInsertedGrantIds(desired, ids)
    assert.sameMembers(
      bound.grants.map((g) => g.grantId),
      [Number(grant.id), offlineId]
    )
    assert.deepEqual(bound.revertExternals, [{ portalId: p.id, mac: '02:00:00:00:00:ee' }])

    // Second pass: the router now reports the id. Nothing changes.
    const report2: RouterPortalReport = {
      ...report,
      grants: report.grants.map((u) => (u.localRef === 'o1' ? { ...u, grantId: offlineId } : u)),
    }
    const again = reconcile(
      await loadServerPortalState(gw.id, { now: NOW, report: report2 }),
      report2,
      false
    )
    assert.deepEqual(again.dbChanges.grantUpdates, [])
    assert.deepEqual(again.dbChanges.grantInserts, [])
    assert.deepEqual(again.dbChanges.sessions, [])
    assert.deepEqual(again.dbChanges.voucherUpdates, [])
    assert.deepEqual(again.dbChanges.events, [])
  })

  test('closing a session stores its own bytes', async ({ assert }) => {
    const gw = await gateway()
    const p = await portal(gw.id)
    const b = await batch(p.id)
    const v = await voucher(b.id, 'EEEEE-FFFFF', {
      boundPortalId: p.id,
      firstUsedAt: at(NOW - HOUR),
      expiresAt: at(NOW + HOUR),
    })
    const grant = await PortalGrant.create({
      portalId: p.id,
      mac: MAC_A,
      source: 'voucher',
      groupKey: `v:${v.id}`,
      voucherId: v.id,
      state: 'active',
      delivery: 'applied',
      bytesDown: 1000,
      startedAt: at(NOW - HOUR),
    })
    await PortalSession.create({
      grantId: grant.id,
      portalId: p.id,
      mac: MAC_A,
      startedAt: at(NOW - HOUR),
      startBytesDown: 200,
    })
    const report: RouterPortalReport = {
      lastEventSeq: 1,
      truncated: false,
      events: [
        {
          seq: 1,
          at: NOW - 1000,
          type: 'grant_ended',
          portalId: p.id,
          mac: MAC_A,
          grantId: Number(grant.id),
          reason: 'logout',
          bytesDown: 1500,
        },
      ],
      grants: [],
      externals: [],
    }
    const { dbChanges } = reconcile(
      await loadServerPortalState(gw.id, { now: NOW, report }),
      report,
      false
    )
    await applyPortalDbChanges(gw.id, dbChanges, { now: NOW })
    const s = await PortalSession.query().firstOrFail()
    assert.equal(s.endedAt!.toMillis(), NOW - 1000)
    assert.equal(Number(s.bytesDown), 1300)
    assert.equal(s.endReason, 'logout')
    const g = await PortalGrant.findOrFail(grant.id)
    assert.include(g.$attributes, { state: 'ended', endReason: 'logout' })
  })

  test('offline list: only this gateway’s eligible vouchers, with verifiers', async ({
    assert,
  }) => {
    const gw = await gateway()
    const other = await gateway()
    const p = await portal(gw.id)
    const q = await portal(other.id)
    const mine = await voucherIn(p.id, 'GGGGG-HHHHH')
    await voucherIn(null, 'JJJJJ-KKKKK') // any portal
    await voucherIn(q.id, 'MMMMM-NNNNN') // other gateway
    await voucherIn(p.id, 'PPPPP-QQQQQ', { revokedAt: DateTime.utc() })
    await voucherIn(p.id, 'RRRRR-SSSSS', { redeemBy: at(NOW - 1) })
    const state = await loadServerPortalState(gw.id, { now: NOW })
    const { desired } = reconcile(
      state,
      { lastEventSeq: 0, truncated: false, events: [], grants: [], externals: [] },
      false
    )
    assert.deepEqual(
      desired.offlineVouchers!.map((v) => v.voucherId),
      [mine.id]
    )
    assert.equal(desired.offlineVouchers![0].verifier, voucherVerifierFor(gw.id, 1, 'GGGGGHHHHH'))

    await updatePortalSettings({ offlineRedemption: false })
    const off = await loadServerPortalState(gw.id, { now: NOW })
    assert.isFalse(off.offline.enabled)
    assert.isNull(
      reconcile(
        off,
        { lastEventSeq: 0, truncated: false, events: [], grants: [], externals: [] },
        false
      ).desired.offlineVouchers
    )
  })

  test('an event naming a foreign portal is kept without the key', async ({ assert }) => {
    const gw = await gateway()
    const otherGateway = await gateway()
    const other = await portal(otherGateway.id)
    await applyPortalDbChanges(gw.id, {
      ackedEventSeq: 1,
      grantInserts: [],
      grantUpdates: [],
      grantClocks: [],
      sessions: [],
      voucherUpdates: [],
      events: [
        {
          at: NOW,
          type: 'external_deauth',
          portalId: other.id,
          grant: null,
          mac: MAC_A,
          detail: {},
        },
      ],
    })
    const e = await PortalEvent.query().firstOrFail()
    assert.isNull(e.portalId)
    assert.equal(e.gatewayId, gw.id)
  })
})

test.group('portal store: retention', (group) => {
  group.each.setup(() => testUtils.db().truncate())

  test('old sessions, ended grants and events go; live grants stay', async ({ assert }) => {
    const gw = await gateway()
    const p = await portal(gw.id)
    const old = at(NOW - 40 * 24 * HOUR)
    const recent = at(NOW - 2 * 24 * HOUR)
    const endedOld = await PortalGrant.create({
      portalId: p.id,
      mac: MAC_A,
      source: 'admin',
      groupKey: 'g:1',
      state: 'ended',
      endedAt: old,
    })
    const endedRecent = await PortalGrant.create({
      portalId: p.id,
      mac: MAC_A,
      source: 'admin',
      groupKey: 'g:2',
      state: 'ended',
      endedAt: recent,
    })
    const live = await PortalGrant.create({
      portalId: p.id,
      mac: MAC_B,
      source: 'admin',
      groupKey: 'g:3',
      state: 'active',
      createdAt: old,
    })
    await PortalSession.create({
      grantId: live.id,
      portalId: p.id,
      mac: MAC_B,
      startedAt: old,
      endedAt: old,
    })
    await PortalSession.create({ grantId: live.id, portalId: p.id, mac: MAC_B, startedAt: old })
    await PortalEvent.create({ gatewayId: gw.id, type: 'grant_lost', createdAt: old })
    await PortalEvent.create({ gatewayId: gw.id, type: 'grant_lost', createdAt: recent })
    for (const [ref, when] of [
      ['old', old],
      ['new', recent],
    ] as const) {
      await PortalAuthorization.create({
        principal: 'u:1',
        externalRef: ref,
        portalId: p.id,
        mac: MAC_B,
        outcome: 'created',
        requestSha: 'a'.repeat(64),
        via: 'http',
        createdAt: when,
      })
    }

    const result = await prunePortalHistory(30, new Date(NOW))
    assert.deepInclude(result, { sessions: 1, grants: 1, events: 1, authorizations: 1 })
    assert.lengthOf(await PortalAuthorization.all(), 1)
    assert.isNull(await PortalGrant.find(endedOld.id))
    assert.isNotNull(await PortalGrant.find(endedRecent.id))
    assert.isNotNull(await PortalGrant.find(live.id))
    assert.lengthOf(await PortalSession.all(), 1)
    assert.lengthOf(await PortalEvent.all(), 1)
  })
})
