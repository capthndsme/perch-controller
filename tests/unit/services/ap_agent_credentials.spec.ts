import {
  JOIN_TOKEN_PREFIX,
  agentSecretMatches,
  generateAgentCredentials,
  generateJoinToken,
  joinTokenDisplayPrefix,
  parseAgentBearer,
  sha256Hex,
} from '#services/ap_agent_credentials'
import { test } from '@japa/runner'

test.group('ap_agent_credentials', () => {
  test('join tokens are mlap_ + 32 base64url chars and never repeat', ({ assert }) => {
    const first = generateJoinToken()
    const second = generateJoinToken()
    assert.match(first, /^mlap_[A-Za-z0-9_-]{32}$/)
    assert.notEqual(first, second)
    assert.isTrue(first.startsWith(JOIN_TOKEN_PREFIX))
  })

  test('display prefix is mlap_ plus four chars', ({ assert }) => {
    assert.equal(joinTokenDisplayPrefix('mlap_AbCdEfGhIjKl'), 'mlap_AbCd')
  })

  test('agent credentials: 32 hex id, 43-char secret, stored as its sha256', ({ assert }) => {
    const credentials = generateAgentCredentials()
    assert.match(credentials.agentId, /^[0-9a-f]{32}$/)
    assert.match(credentials.agentSecret, /^[A-Za-z0-9_-]{43}$/)
    assert.equal(credentials.secretHash, sha256Hex(credentials.agentSecret))
    assert.notEqual(generateAgentCredentials().agentId, credentials.agentId)
  })

  test('parseAgentBearer accepts only Bearer <32 hex>.<base64url>', ({ assert }) => {
    const { agentId, agentSecret } = generateAgentCredentials()
    assert.deepEqual(parseAgentBearer(`Bearer ${agentId}.${agentSecret}`), { agentId, agentSecret })
    assert.deepEqual(parseAgentBearer(`bearer  ${agentId}.${agentSecret} `), {
      agentId,
      agentSecret,
    })
    assert.deepEqual(parseAgentBearer([`Bearer ${agentId}.${agentSecret}`]), {
      agentId,
      agentSecret,
    })

    assert.isNull(parseAgentBearer(undefined))
    assert.isNull(parseAgentBearer(''))
    assert.isNull(parseAgentBearer(`Basic ${agentId}.${agentSecret}`))
    assert.isNull(parseAgentBearer(`Bearer ${agentId}`))
    assert.isNull(parseAgentBearer(`Bearer ${agentId.toUpperCase()}.${agentSecret}`))
    assert.isNull(parseAgentBearer(`Bearer abc.${agentSecret}`))
    assert.isNull(parseAgentBearer(`Bearer ${agentId}.short`))
    assert.isNull(parseAgentBearer(`Bearer ${agentId}.${agentSecret}!`))
  })

  test('agentSecretMatches compares against the stored digest', ({ assert }) => {
    const { agentSecret, secretHash } = generateAgentCredentials()
    assert.isTrue(agentSecretMatches(secretHash, agentSecret))
    assert.isFalse(agentSecretMatches(secretHash, `${agentSecret}x`))
    assert.isFalse(agentSecretMatches(secretHash, ''))
    assert.isFalse(agentSecretMatches(null, agentSecret))
    assert.isFalse(agentSecretMatches('not-a-digest', agentSecret))
    assert.isFalse(agentSecretMatches(secretHash.toUpperCase(), agentSecret))
  })
})
