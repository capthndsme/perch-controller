import {
  AgentOfflineError,
  AgentRpcError,
  AgentTimeoutError,
  AgentHub,
  type AgentConnection,
} from '#services/ap_agent_hub'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'

class FakeConnection implements AgentConnection {
  sent: any[] = []
  closedWith: { code: number; reason: string } | null = null
  terminated = false

  send(data: string) {
    if (this.closedWith) throw new Error('closed')
    this.sent.push(JSON.parse(data))
  }

  close(code: number, reason: string) {
    this.closedWith = { code, reason }
  }

  terminate() {
    this.terminated = true
  }
}

function register(hub: AgentHub, id = 1) {
  const connection = new FakeConnection()
  const session = hub.register({
    id,
    connection,
    connectedAt: DateTime.utc(),
    address: '192.168.1.20',
    protocol: 'perch-ap.v1',
  })
  return { connection, session }
}

test.group('AgentHub', () => {
  test('correlates a request with its result', async ({ assert }) => {
    const hub = new AgentHub()
    const { connection, session } = register(hub)

    const pending = hub.request(1, 'ping', { a: 1 }, { timeoutMs: 500 })
    assert.lengthOf(connection.sent, 1)
    const [request] = connection.sent
    assert.deepEqual(request, { jsonrpc: '2.0', id: 1, method: 'ping', params: { a: 1 } })

    hub.handleFrame(session, JSON.stringify({ jsonrpc: '2.0', id: 1, result: { pong: true } }))
    assert.deepEqual(await pending, { pong: true })
    assert.isTrue(hub.isOnline(1))
    assert.equal(hub.session(1)?.address, '192.168.1.20')
  })

  test('an error reply becomes AgentRpcError with the code', async ({ assert }) => {
    const hub = new AgentHub()
    const { session } = register(hub)
    const pending = hub.request(1, 'client.kick', {}, { timeoutMs: 500 })
    hub.handleFrame(
      session,
      JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32002, message: 'not associated' } })
    )
    try {
      await pending
      assert.fail('expected a rejection')
    } catch (error) {
      assert.instanceOf(error, AgentRpcError)
      assert.equal((error as AgentRpcError).code, -32002)
      assert.equal((error as AgentRpcError).message, 'not associated')
    }
  })

  test('no answer → AgentTimeoutError; offline → AgentOfflineError', async ({ assert }) => {
    const hub = new AgentHub()
    register(hub)
    await assert.rejects(() => hub.request(1, 'ping', {}, { timeoutMs: 20 }), AgentTimeoutError)
    await assert.rejects(() => hub.request(2, 'ping'), AgentOfflineError)
  })

  test('a new session replaces the old one with 4002 and fails its requests', async ({
    assert,
  }) => {
    const hub = new AgentHub()
    const first = register(hub)
    const pending = hub.request(1, 'ping', {}, { timeoutMs: 500 })

    const second = register(hub)
    assert.deepEqual(first.connection.closedWith, {
      code: 4002,
      reason: 'replaced by a newer session',
    })
    await assert.rejects(() => pending, AgentOfflineError)

    // The old socket's close handler must not take the new session down.
    assert.isFalse(hub.unregister(first.session))
    assert.isTrue(hub.isOnline(1))
    assert.isTrue(hub.unregister(second.session))
    assert.isFalse(hub.isOnline(1))
  })

  test('requests from the agent get -32601; notifications and junk are ignored', ({ assert }) => {
    const hub = new AgentHub()
    const { connection, session } = register(hub)
    hub.handleFrame(session, JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'whoami' }))
    assert.deepEqual(connection.sent, [
      { jsonrpc: '2.0', id: 9, error: { code: -32601, message: 'method not found: whoami' } },
    ])
    hub.handleFrame(session, JSON.stringify({ jsonrpc: '2.0', method: 'locate.ended' }))
    hub.handleFrame(session, 'not json')
    hub.handleFrame(session, '[1,2]')
    hub.handleFrame(session, JSON.stringify({ jsonrpc: '2.0', id: 77, result: {} }))
    assert.lengthOf(connection.sent, 1)
  })

  test('disconnect closes with the code, rejects pending, goes offline', async ({ assert }) => {
    const hub = new AgentHub()
    const { connection } = register(hub)
    const pending = hub.request(1, 'ping', {}, { timeoutMs: 500 })
    assert.isTrue(hub.disconnect(1, 4001, 'agent forgotten'))
    assert.deepEqual(connection.closedWith, { code: 4001, reason: 'agent forgotten' })
    await assert.rejects(() => pending, AgentOfflineError)
    assert.isFalse(hub.isOnline(1))
    assert.isFalse(hub.disconnect(1, 4001, 'again'))
    assert.isFalse(hub.notify(1, 'x'))
  })

  test('the socket closing after disconnect still reports the AP offline', ({ assert }) => {
    const hub = new AgentHub()
    const { session } = register(hub)
    hub.disconnect(1, 4001, 'agent forgotten')
    assert.isTrue(hub.unregister(session))
  })

  test('notifications reach their handler with the AP id', async ({ assert }) => {
    const hub = new AgentHub()
    const { session } = register(hub, 7)
    const seen: Array<[number, unknown]> = []
    hub.onNotification('metrics.push', (apId, params) => {
      seen.push([apId, params])
    })
    hub.handleFrame(
      session,
      JSON.stringify({ jsonrpc: '2.0', method: 'metrics.push', params: { seq: 1 } })
    )
    assert.deepEqual(seen, [[7, { seq: 1 }]])
  })

  test('closeAll closes every session and hands back the connections', ({ assert }) => {
    const hub = new AgentHub()
    const one = register(hub, 1)
    const two = register(hub, 2)
    const connections = hub.closeAll(1001, 'server shutting down')
    assert.lengthOf(connections, 2)
    assert.equal(one.connection.closedWith?.code, 1001)
    assert.equal(two.connection.closedWith?.code, 1001)
    assert.deepEqual(hub.onlineIds(), [])
  })
})
