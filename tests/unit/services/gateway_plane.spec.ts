import collectorHub from '#services/collector_agent_hub'
import { checkRoundTrip, type SyncedSection } from '#services/gateway_config/domain'
import {
  dnsRecordsDomain,
  isReservedName,
  slugifyLabel,
} from '#services/gateway_config/domains/dns_records'
import { parseRead, ReadRefusedError } from '#services/gateway_config/gateway_agent'
import {
  _resetGatewaySessions,
  isGatewayCapability,
  parseApplyResult,
  parseHelloGatewayConfig,
  rememberGatewaySession,
  writeAccess,
} from '#services/gateway_config/gateway_registry'
import {
  commitmentMatches,
  derivePairingKey,
  pairingCommitment,
  pairingKeyId,
  pairingSas,
  x25519PublicKey,
  x25519Shared,
} from '#services/gateway_config/pairing_crypto'
import { signatureMessage, signParams } from '#services/gateway_config/rpc_signing'
import { isSecretOption, secretFingerprint } from '#services/gateway_config/secrets'
import { GatewaySerialQueue, QueueFullError } from '#services/gateway_config/serial_queue'
import { test } from '@japa/runner'
import { createHash } from 'node:crypto'
import { DateTime } from 'luxon'

/**
 * Pure parts of the config plane's agent wiring (docs/gateway/config-plane.md
 * sections 4 and 6): the serial queue, the wire vectors shared with
 * perch-collector (fingerprints, the signed envelope, pairing), read
 * validation, hello parsing, the write-access rule and the DNS domain.
 */

const KEY = 'collector-key-0123456789abcdef'

test.group('gateway plane | serial queue', () => {
  test('one gateway runs in order, others in parallel', async ({ assert }) => {
    const q = new GatewaySerialQueue()
    const log: string[] = []
    const slow = (tag: string, ms: number) => async () => {
      log.push(`${tag}:start`)
      await new Promise((r) => setTimeout(r, ms))
      log.push(`${tag}:end`)
      return tag
    }
    const results = await Promise.all([
      q.run(1, slow('a1', 30)),
      q.run(1, slow('a2', 1)),
      q.run(2, slow('b1', 1)),
    ])
    assert.deepEqual(results, ['a1', 'a2', 'b1'])
    assert.isBelow(log.indexOf('b1:end'), log.indexOf('a1:end'))
    assert.isBelow(log.indexOf('a1:end'), log.indexOf('a2:start'))
    assert.equal(q.size(), 0)
  })

  test('re-entrant for the gateway it holds; a failure does not block the queue', async ({
    assert,
  }) => {
    const q = new GatewaySerialQueue()
    const inner = await q.run(1, () => q.run(1, async () => 'inner'))
    assert.equal(inner, 'inner')
    await assert.rejects(() => q.run(1, async () => Promise.reject(new Error('boom'))), 'boom')
    assert.equal(await q.run(1, async () => 'after'), 'after')
  })

  test('bounded per gateway and in gateways', async ({ assert }) => {
    const q = new GatewaySerialQueue(2, 1)
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const first = q.run(1, () => gate)
    const second = q.run(1, async () => undefined)
    await assert.rejects(() => q.run(1, async () => undefined))
    await q.run(2, async () => undefined).catch((e) => assert.instanceOf(e, QueueFullError))
    release()
    await Promise.all([first, second])
    await q.drainAll()
    assert.equal(q.size(), 0)
  })
})

test.group('gateway plane | wire vectors shared with perch-collector', () => {
  test('secret fingerprints match the kit (scalar and list)', ({ assert }) => {
    // Computed with perch-agentkit openwrt/uci Fingerprint.
    const where = { config: 'network', section: 'wg0', option: 'private_key' }
    assert.equal(secretFingerprint(KEY, where, 'abc'), 'hmac:52e8d42265ed32ca')
    assert.equal(secretFingerprint(KEY, where, ['a', 'b']), 'hmac:149d63c5d9fe86fa')
    assert.notEqual(secretFingerprint(KEY, where, ['abc']), secretFingerprint(KEY, where, 'abc'))
  })

  test('secret option names follow the kit', ({ assert }) => {
    for (const name of [
      'key',
      'faskey',
      'api_key',
      'acct_secret',
      'priv_key_pwd',
      'key3',
      'r0kh',
    ]) {
      assert.isTrue(isSecretOption('x', name), name)
    }
    for (const name of ['keyring', 'key5', 'name', 'ip']) {
      assert.isFalse(isSecretOption('x', name), name)
    }
  })

  test('signed envelope: the agent test vector (sign.go)', ({ assert }) => {
    const payload = '{"applyId":"a1"}'
    assert.equal(
      createHash('sha256').update(payload).digest('hex'),
      '275ffaf62583a907a897eaad357b77010508dbaed674bbbd8819b344ceba30e8'
    )
    const env = signParams(
      'k',
      'gateway.config.confirm',
      'c0ffee',
      { applyId: 'a1' },
      {
        ts: 1790000000,
        nonce: 'nonce-0000000001',
      }
    )
    assert.equal(env.payload, payload)
    assert.equal(env.sig.mac, '2ae21083603b5bf27157bf935395c42b2d4c607e8d6b93cf3abe9ba59d7b7e9e')
    assert.deepInclude(env.sig, { v: 1, ts: 1790000000, challenge: 'c0ffee' })
    assert.include(signatureMessage('m', 'c', 1, 'n', '{}'), 'perch-config-sig-v1\nm\nc\n1\nn\n')
  })

  test('pairing: RFC 7748 keys, derived key, SAS, key id and commitment (pinned)', ({ assert }) => {
    const controllerPriv = '77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a'
    const routerPriv = '5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb'
    const controllerPub = x25519PublicKey(controllerPriv)
    const routerPub = x25519PublicKey(routerPriv)
    assert.equal(controllerPub, '8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a')
    assert.equal(routerPub, 'de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f')
    const shared = x25519Shared(controllerPriv, routerPub)
    assert.equal(
      shared.toString('hex'),
      '4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742'
    )
    assert.deepEqual(x25519Shared(routerPriv, controllerPub), shared)
    const t = {
      gatewayId: 7,
      controllerPub,
      routerPub,
      controllerNonce: '11'.repeat(32),
      routerNonce: '22'.repeat(32),
    }
    // Cross-checked with an independent Go implementation (crypto/ecdh + HKDF).
    const key = derivePairingKey(shared, t)
    assert.equal(
      key.toString('hex'),
      '6ab9f1d40416ea38eb9b448cecef75bc2ab631a5940225c5fd80df386f1edacb'
    )
    assert.equal(pairingSas(t), '331510')
    assert.equal(pairingKeyId(key), '38545dab8f16e8a2')
    const commitment = pairingCommitment(t.routerNonce, routerPub, controllerPub)
    assert.equal(commitment, 'ff24b3e804967019f7662f53a2499f330b0c5fc227540479bcecea5dc678e9c4')
    assert.isTrue(commitmentMatches(commitment, t.routerNonce, routerPub, controllerPub))
    assert.isFalse(commitmentMatches(commitment, '33'.repeat(32), routerPub, controllerPub))
    assert.notEqual(pairingSas({ ...t, gatewayId: 8 }), '331510')
  })

  test('pairing refuses a low-order peer key', ({ assert }) => {
    assert.throws(() =>
      x25519Shared(
        '77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a',
        '00'.repeat(32)
      )
    )
  })
})

test.group('gateway plane | parsing agent data', () => {
  test('a read is validated whole; limits refuse, never truncate', ({ assert }) => {
    const ok = parseRead({
      readAt: '2026-09-23T10:00:00Z',
      configs: [
        {
          name: 'network',
          hash: 'h',
          sections: [
            {
              name: 'cfg0a',
              type: 'bridge-vlan',
              anonymous: true,
              index: 0,
              options: { vlan: '1' },
            },
            {
              name: 'wg0',
              type: 'interface',
              options: { proto: 'wireguard' },
              secrets: { private_key: 'hmac:0123456789abcdef' },
            },
          ],
        },
      ],
      ledger: [
        { perchId: 'k2', config: 'network', section: 'wg0', domain: 'networks' },
        { bad: 1 },
      ],
      uncommitted: ['dhcp'],
      luciPending: true,
    })
    assert.equal(ok.configs[0].sections[1].index, 1)
    assert.deepEqual(ok.configs[0].sections[1].secrets, { private_key: 'hmac:0123456789abcdef' })
    assert.lengthOf(ok.ledger, 1)
    assert.isTrue(ok.luciPending)

    const big = 'x'.repeat(4097)
    assert.throws(
      () =>
        parseRead({
          configs: [
            { name: 'dhcp', sections: [{ name: 'a', type: 'host', options: { name: big } }] },
          ],
        }),
      /4 KiB/
    )
    const many = Array.from({ length: 2001 }, (_, i) => ({
      name: `s${i}`,
      type: 'host',
      options: {},
    }))
    try {
      parseRead({ configs: [{ name: 'dhcp', sections: many }] })
      assert.fail('should refuse')
    } catch (error) {
      assert.instanceOf(error, ReadRefusedError)
      assert.equal((error as ReadRefusedError).code, 'read_too_large')
    }
    assert.throws(() =>
      parseRead({ configs: [{ name: 'dhcp', sections: [{ name: 'a b', type: 'host' }] }] })
    )
    assert.throws(() => parseRead({ nope: true }))
  })

  test('hello block and results parse tolerantly', ({ assert }) => {
    const hello = parseHelloGatewayConfig({
      protocol: 1,
      access: 'write',
      transportOk: false,
      hashes: { network: 'aa', bad: 3 },
      apply: {
        state: 'pending_confirm',
        applyId: 'g1-x',
        deadline: '2026-09-23T10:01:30Z',
        protected: true,
      },
      results: [
        {
          applyId: 'g1-w',
          outcome: 'rolled_back',
          reason: 'reboot',
          discarded: {
            dhcp: [{ name: 'lan', type: 'dhcp', options: { start: '100' }, change: 'changed' }],
          },
        },
        'junk',
      ],
      signing: {
        required: true,
        challenge: 'c0ffee',
        key: 'paired',
        keyId: 'abcd',
        windowSeconds: 300,
      },
      management: { network: 'lan', device: 'br-lan', controllerAddress: '192.168.1.5' },
      future: { anything: true },
    })!
    assert.deepEqual(hello.hashes, { network: 'aa' })
    assert.equal(hello.apply.applyId, 'g1-x')
    assert.lengthOf(hello.results, 1)
    assert.equal(hello.results[0].discarded!.dhcp[0].change, 'changed')
    assert.deepInclude(hello.signing!, { key: 'paired', keyId: 'abcd', required: true })
    assert.deepInclude(hello.management!, { network: 'lan', device: 'br-lan' })
    assert.isNull(parseHelloGatewayConfig('nope'))
    assert.isNull(parseApplyResult({ applyId: 1 }))
  })

  test('gateway capabilities', ({ assert }) => {
    for (const c of [
      'gateway_config',
      'gateway_stats',
      'observe.dhcp',
      'gateway.backup',
      'net.conntrack_flush',
    ]) {
      assert.isTrue(isGatewayCapability(c), c)
    }
    assert.isFalse(isGatewayCapability('ports'))
  })
})

test.group('gateway plane | write access (README 7.1, decision 29)', (group) => {
  group.each.setup(() => {
    _resetGatewaySessions()
    collectorHub.register({
      id: 901,
      connection: { send() {}, close() {}, terminate() {} },
      connectedAt: DateTime.utc(),
      address: null,
      protocol: 'perch-collector.v1',
    })
    return () => {
      collectorHub.disconnect(901, 1000, 'test')
      _resetGatewaySessions()
    }
  })

  function session(hello: Record<string, unknown>, secure: boolean | null) {
    rememberGatewaySession(901, parseHelloGatewayConfig(hello)!, {
      connectedAt: DateTime.utc(),
      secure,
      capabilities: ['gateway_config'],
    })
  }

  const gateway = (extra: Record<string, unknown> = {}) => ({
    collectorId: 901,
    agentAccess: 'write',
    capabilities: { capable: true, allowInsecure: true },
    configSignKey: null,
    pairing: null,
    pairingKey: null,
    ...extra,
  })

  test('verified TLS on both ends writes unsigned', ({ assert }) => {
    session(
      { access: 'write', transportOk: true, signing: { required: false, key: 'api_key' } },
      true
    )
    assert.deepEqual(writeAccess(gateway() as any, { allowInsecureTransport: false }), {
      writable: true,
      signed: false,
      secure: true,
    })
  })

  test('a trusted proxy without X-Forwarded-Proto is not secure', ({ assert }) => {
    session(
      {
        access: 'write',
        transportOk: true,
        signing: { required: false, key: 'api_key', challenge: 'c' },
      },
      null
    )
    assert.deepInclude(writeAccess(gateway() as any, { allowInsecureTransport: false }), {
      writable: false,
      reason: 'insecure_transport',
    })
  })

  test('plain HTTP: both opt-ins and a pairing; the api_key never signs', ({ assert }) => {
    session(
      {
        access: 'write',
        transportOk: false,
        signing: { required: true, key: 'api_key', challenge: 'c' },
      },
      false
    )
    assert.deepInclude(writeAccess(gateway() as any, { allowInsecureTransport: false }), {
      reason: 'insecure_transport',
    })
    assert.deepInclude(
      writeAccess(gateway({ capabilities: { capable: true, allowInsecure: false } }) as any, {
        allowInsecureTransport: true,
      }),
      { reason: 'insecure_transport' }
    )
    assert.deepInclude(writeAccess(gateway() as any, { allowInsecureTransport: true }), {
      reason: 'not_paired',
    })
    session(
      {
        access: 'write',
        transportOk: false,
        signing: { required: true, key: 'paired', keyId: 'k1', challenge: 'c' },
      },
      false
    )
    const paired = gateway({
      pairing: { state: 'paired', keyId: 'k1' },
      pairingKey: '11'.repeat(32),
    })
    assert.deepInclude(writeAccess(paired as any, { allowInsecureTransport: true }), {
      writable: true,
      signed: true,
      key: 'paired',
      challenge: 'c',
    })
    const otherKey = gateway({
      pairing: { state: 'paired', keyId: 'k2' },
      pairingKey: '11'.repeat(32),
    })
    assert.deepInclude(writeAccess(otherKey as any, { allowInsecureTransport: true }), {
      reason: 'not_paired',
    })
  })

  test('router access below write, and offline', ({ assert }) => {
    session({ access: 'read', transportOk: true }, true)
    assert.deepInclude(writeAccess(gateway() as any, { allowInsecureTransport: true }), {
      reason: 'router_access',
    })
    assert.deepInclude(
      writeAccess({ ...gateway(), collectorId: 902 } as any, { allowInsecureTransport: true }),
      {
        reason: 'offline',
      }
    )
  })
})

test.group('gateway plane | DNS records domain', () => {
  const sections: SyncedSection[] = [
    {
      perchId: 'd1',
      config: 'dhcp',
      name: 'cfg0d',
      type: 'domain',
      anonymous: true,
      options: { name: 'NAS.lan', ip: '192.168.1.10', comment: 'kept' },
    },
    {
      perchId: 'c1',
      config: 'dhcp',
      name: 'cfg0e',
      type: 'cname',
      anonymous: true,
      options: { cname: 'files.lan', target: 'nas.lan' },
    },
  ]

  test('claims domain and cname records, round-trips verbatim', ({ assert }) => {
    const claim = (s: SyncedSection) =>
      dnsRecordsDomain.claims(
        {
          name: s.name,
          type: s.type,
          anonymous: s.anonymous,
          options: s.options,
          index: 0,
          config: 'dhcp',
        },
        {}
      )
    assert.isTrue(claim(sections[0]))
    assert.isTrue(claim(sections[1]))
    assert.isFalse(claim({ ...sections[0], options: { name: 'x' } }))
    // Gateway sync (domains.md 6): a MAC-less host is a DNS name (record type `host`);
    // a host with a MAC stays a reservation (`dhcp_hosts`).
    assert.isTrue(claim({ ...sections[0], type: 'host' }))
    assert.isFalse(
      claim({
        ...sections[0],
        type: 'host',
        options: { ...sections[0].options, mac: '02:00:00:00:00:09' },
      })
    )
    assert.isTrue(checkRoundTrip(dnsRecordsDomain, sections).ok)
    const [a] = dnsRecordsDomain.parse(sections)
    assert.deepEqual(a.extra, { comment: 'kept' })
  })

  test('validation: names, values, alias collisions', ({ assert }) => {
    const bad: SyncedSection[] = [
      {
        perchId: 'x1',
        config: 'dhcp',
        name: 'a',
        type: 'domain',
        anonymous: false,
        options: { name: 'bad name', ip: '192.168.1.1' },
      },
      {
        perchId: 'x2',
        config: 'dhcp',
        name: 'b',
        type: 'domain',
        anonymous: false,
        options: { name: 'ok.lan', ip: 'nope' },
      },
      {
        perchId: 'x3',
        config: 'dhcp',
        name: 'c',
        type: 'cname',
        anonymous: false,
        options: { cname: 'nas.lan', target: 'ok.lan' },
      },
    ]
    const issues = dnsRecordsDomain.validate(bad, {
      capabilities: null,
      all: [...bad, sections[0]],
      unmanaged: [],
    })
    const codes = issues.map((i) => `${i.perchId}:${i.code}`)
    assert.include(codes, 'x1:dns_name_invalid')
    assert.include(codes, 'x2:dns_value_invalid')
    assert.include(codes, 'x3:dns_name_taken')
  })

  test('reserved names and label slugs (README 7.10)', ({ assert }) => {
    assert.isTrue(isReservedName('wpad'))
    assert.isTrue(isReservedName('WPAD.lan'))
    assert.isTrue(isReservedName('localhost'))
    assert.isTrue(isReservedName('perch-box', ['perch-box']))
    assert.isFalse(isReservedName('printer'))
    assert.equal(slugifyLabel('Living Room TV'), 'living-room-tv')
    assert.equal(slugifyLabel('Café  Printer!!'), 'cafe-printer')
    assert.equal(slugifyLabel('---'), '')
    assert.lengthOf(slugifyLabel('x'.repeat(100)), 63)
  })
})
