/**
 * The core stability contract (wifi design README section 4, W0; build plan
 * agreement 2): the Wi-Fi plane imports the pure config-plane core of
 * `app/services/gateway_config/` unchanged. gateway-sync may change the
 * core's internals but keeps every export and signature (optional params
 * may be added). This file imports every core symbol the AP plane uses and
 * pins its call shape at compile time (`npm run typecheck` covers tests)
 * and its behaviour the Wi-Fi plane relies on at run time, so a breaking
 * rename or signature change fails in either lane.
 *
 * Function signatures are pinned by assignment to the call shape the Wi-Fi
 * plane uses: adding an optional parameter, widening a parameter or
 * narrowing a result keeps compiling; removing, renaming or narrowing does
 * not. Input types are pinned by sample literals of every field the plane
 * sets: a new required field (or a removed one) breaks them.
 */
import {
  canonicalText,
  cloneContent,
  contentsEqual,
  DEFAULT_RULES,
  diffEntry,
  diffOptions,
  entriesOf,
  itemsOf,
  ownedProjection,
  valueKey,
  type ListSemantics,
  type MergeRules,
} from '#services/gateway_config/canonical'
import {
  applySectionEdits,
  checkRoundTrip,
  compareConfigs,
  CONFIG_APPLY_ORDER,
  contentOf,
  DomainRegistry,
  EXCLUDED_CONFIGS,
  LEDGER_CONFIG,
  roundTripsSection,
  rulesFor,
  SectionEditError,
  syncedFromRouter,
  validateDesired,
  type ConfigDomain,
  type DomainClaim,
  type RoundTripReport,
  type SecretEdit,
  type SectionEdit,
  type SyncedSection,
  type ValidationCtx,
} from '#services/gateway_config/domain'
import {
  controllerSecretSlot,
  DEFAULT_SECRET_OPTIONS,
  FINGERPRINT_PREFIX,
  isFingerprint,
  isSecretOption,
  newSecretRef,
  redactOptions,
  routerSecretSlots,
  secretFingerprint,
  wireOptions,
} from '#services/gateway_config/secrets'
import {
  acceptDrift,
  applyControllerEdit,
  checkEnableAuthoritative,
  checkModeChange,
  computeSyncStatus,
  computeUnledgered,
  deriveStatus,
  diffBases,
  enforcementAfterFailure,
  FINISHED_APPLY_STATES,
  isEcho,
  isGone,
  markConfirmed,
  markInFlight,
  markRolledBack,
  mergeSection,
  nextApplyState,
  reconcileRead,
  resolveConflict,
  revertDueAt,
  rollupSyncState,
  sectionsDueForRevert,
  type ApplyEvent,
  type ConflictResolution,
  type EnableAuthoritativeCheck,
  type EngineEvent,
  type InFlight,
  type MergeInput,
  type MergeResult,
  type ModeChangeError,
  type ReconcileReadInput,
  type ReconcileReadResult,
  type SectionChange,
  type SectionState,
  type SyncBlocker,
  type SyncStatus,
  type SyncStatusInput,
} from '#services/gateway_config/sync_engine'
import {
  EditRefusedError,
  planApply,
  planSectionEdits,
  touchesManagementPath,
  type ApplyPlan,
  type EditSectionsInput,
  type EditSectionsResult,
  type PlanApplyInput,
  type PlannedJob,
} from '#services/gateway_config/apply_plan'
import {
  buildSnapshot,
  diffSnapshots,
  planRestore,
  rejoinOffer,
  revisionsToPrune,
  summarizeDiff,
} from '#services/gateway_config/revisions'
import { GatewaySerialQueue, QueueFullError } from '#services/gateway_config/serial_queue'
import {
  commitmentMatches,
  derivePairingKey,
  generatePairingKeyPair,
  isHex32,
  newPairingNonce,
  PAIRING_KEY_BYTES,
  pairingCommitment,
  pairingKeyId,
  pairingSas,
  pairingSubject,
  x25519PublicKey,
  x25519Shared,
  type PairingSubject,
  type PairingTranscript,
  type X25519KeyPair,
} from '#services/gateway_config/pairing_crypto'
import {
  parseSigning,
  signatureMessage,
  signParams,
  SIGNATURE_VERSION,
  type AgentSigning,
  type SignedEnvelope,
} from '#services/gateway_config/rpc_signing'
import {
  actorColumns,
  APPLY_STATES,
  CONFIRM_MODES,
  GATEWAY_MODES,
  SECTION_SCOPES,
  SECTION_STATUSES,
  WHOLE_SECTION,
  type AgentAccess,
  type ApplyKind,
  type ApplyOp,
  type ApplyState,
  type ConfigDiffEntry,
  type ConfirmMode,
  type GatewayEnforcement,
  type GatewayMode,
  type GatewaySyncState,
  type Issue,
  type LedgerChange,
  type LedgerEntry,
  type ManagementPath,
  type PlaneActor,
  type RevisionSource,
  type RouterAuthor,
  type SecretSlot,
  type SectionConflict,
  type SectionContent,
  type SectionOwnership,
  type SectionScope,
  type SectionStatus,
  type SystemActor,
  type UciConfig,
  type UciConfigSet,
  type UciOptions,
  type UciSection,
  type UciValue,
  type WireValue,
} from '#services/gateway_config/types'
import type { RevisionSnapshotEntry } from '#models/gateway_revision'
import { test } from '@japa/runner'

// ── compile-time pins: the call shapes the Wi-Fi plane uses ──────────────

type Ctx = { authoritative: boolean; rules?: MergeRules }

/** Every core function the Wi-Fi plane calls, as it calls it. */
const CORE_FUNCTIONS: {
  // canonical.ts
  canonicalText: (content: SectionContent | null) => string
  cloneContent: (content: SectionContent | null) => SectionContent | null
  contentsEqual: (
    a: SectionContent | null,
    b: SectionContent | null,
    rules?: MergeRules,
    ownership?: SectionOwnership | null
  ) => boolean
  diffEntry: (
    where: { perchId: string | null; config: string; section: string; domain: string | null },
    before: SectionContent | null,
    after: SectionContent | null,
    rules?: MergeRules
  ) => ConfigDiffEntry | null
  diffOptions: (
    before: SectionContent | null,
    after: SectionContent | null,
    rules?: MergeRules
  ) => ConfigDiffEntry['options']
  entriesOf: (content: SectionContent | null) => Map<string, unknown>
  itemsOf: (value: UciValue | undefined | null) => string[]
  ownedProjection: (
    content: SectionContent | null,
    ownership: SectionOwnership | null | undefined
  ) => SectionContent | null
  valueKey: (type: string, option: string, value: UciValue, rules: MergeRules) => string
  // domain.ts
  applySectionEdits: (
    current: SyncedSection[],
    edits: SectionEdit[],
    newPerchId?: () => string
  ) => SyncedSection[]
  checkRoundTrip: (domain: ConfigDomain, sections: SyncedSection[]) => RoundTripReport
  roundTripsSection: (domain: ConfigDomain, section: SyncedSection) => boolean
  compareConfigs: (a: string, b: string) => number
  contentOf: (section: SyncedSection) => SectionContent
  rulesFor: (domain: ConfigDomain | null | undefined) => MergeRules
  syncedFromRouter: (config: string, section: UciSection, perchId?: string | null) => SyncedSection
  validateDesired: (
    registry: DomainRegistry,
    desired: Array<SyncedSection & { domain: string | null }>,
    ctx: Omit<ValidationCtx, 'all'>
  ) => Issue[]
  // secrets.ts
  secretFingerprint: (
    apiKey: string,
    where: { config: string; section: string; option: string },
    value: UciValue
  ) => string
  isFingerprint: (value: unknown) => boolean
  isSecretOption: (type: string, option: string, extra?: readonly string[]) => boolean
  redactOptions: (
    apiKey: string,
    where: { config: string; section: string; type: string },
    options: UciOptions,
    extra?: readonly string[]
  ) => { options: UciOptions; secrets: Record<string, string> }
  newSecretRef: () => string
  controllerSecretSlot: (
    apiKey: string,
    where: { config: string; section: string; option: string },
    ref: string,
    value: UciValue
  ) => SecretSlot
  wireOptions: (content: SectionContent) => { options: Record<string, WireValue>; refs: string[] }
  routerSecretSlots: (
    secrets: Record<string, string> | undefined
  ) => Record<string, SecretSlot> | undefined
  // sync_engine.ts
  reconcileRead: (input: ReconcileReadInput) => ReconcileReadResult
  mergeSection: (input: MergeInput) => MergeResult
  resolveConflict: (
    state: SectionState,
    resolution: ConflictResolution,
    ctx: Ctx
  ) => SectionState | null
  acceptDrift: (state: SectionState, ctx?: { rules?: MergeRules }) => SectionState | null
  computeSyncStatus: (input: SyncStatusInput) => SyncStatus
  checkEnableAuthoritative: (status: SyncStatus, expectRevision: number) => EnableAuthoritativeCheck
  checkModeChange: (
    from: GatewayMode,
    to: GatewayMode,
    ctx: {
      hasCapability: boolean
      routerAccess: 'none' | 'read' | 'write' | null
      transportOk: boolean
      passwordVerified: boolean
    }
  ) => ModeChangeError | null
  nextApplyState: (state: ApplyState, event: ApplyEvent) => ApplyState | null
  sectionsDueForRevert: (
    states: SectionState[],
    ctx: {
      now: string
      delaySeconds: number
      enforcement: GatewayEnforcement
      authoritative: boolean
    }
  ) => string[]
  enforcementAfterFailure: (
    failureTimes: string[],
    ctx: { now: string; maxFailures: number; windowMinutes: number }
  ) => GatewayEnforcement
  markConfirmed: (state: SectionState, written: SectionContent | null, ctx: Ctx) => SectionState
  markRolledBack: (
    state: SectionState,
    ctx: Ctx & { now: string; discarded?: SectionContent | null }
  ) => SectionState
  markInFlight: (state: SectionState, kind: 'apply' | 'revert') => SectionState
  applyControllerEdit: (
    state: SectionState,
    desired: SectionContent | null,
    ctx: Ctx & { ownership?: SectionOwnership | null }
  ) => SectionState
  deriveStatus: (
    state: Pick<SectionState, 'scope' | 'base' | 'router' | 'desired' | 'conflict' | 'ownership'>,
    ctx: { authoritative: boolean; inFlight?: InFlight; rules?: MergeRules }
  ) => SectionStatus
  rollupSyncState: (input: {
    mode: GatewayMode
    observedAt: string | null
    applyInFlight: boolean
    statuses: Iterable<SectionStatus>
  }) => GatewaySyncState
  computeUnledgered: (rows: SectionState[], ledger: LedgerEntry[]) => string[]
  revertDueAt: (
    state: Pick<SectionState, 'status' | 'driftSince'>,
    delaySeconds: number
  ) => string | null
  isGone: (state: Pick<SectionState, 'base' | 'router' | 'desired'>) => boolean
  isEcho: (
    observed: SectionContent | null,
    inFlightDesired: SectionContent | null,
    rules?: MergeRules
  ) => boolean
  diffBases: (
    before: SectionState[],
    after: SectionState[],
    registry: DomainRegistry | null
  ) => ConfigDiffEntry[]
  // apply_plan.ts
  planApply: (input: PlanApplyInput) => ApplyPlan
  planSectionEdits: (input: EditSectionsInput) => EditSectionsResult
  touchesManagementPath: (
    config: string,
    name: string,
    content: SectionContent | null,
    path: ManagementPath | null,
    registry?: DomainRegistry | null,
    domainKey?: string | null
  ) => boolean
  // revisions.ts
  buildSnapshot: (sections: SectionState[]) => RevisionSnapshotEntry[]
  diffSnapshots: (
    before: RevisionSnapshotEntry[],
    after: RevisionSnapshotEntry[],
    registry?: DomainRegistry | null
  ) => ConfigDiffEntry[]
  summarizeDiff: (diff: ConfigDiffEntry[]) => string
  rejoinOffer: (revisions: Array<{ number: number; confirmedAt: string | null }>) => number | null
  revisionsToPrune: (
    revisions: Array<{ number: number; confirmedAt: string | null }>,
    keep: number
  ) => number[]
  planRestore: (
    sections: SectionState[],
    snapshot: RevisionSnapshotEntry[]
  ) => {
    updates: Array<{ perchId: string; desired: SectionContent | null }>
    creates: RevisionSnapshotEntry[]
  }
  // pairing_crypto.ts (W0: the subject)
  pairingSubject: (t: PairingTranscript) => string
  derivePairingKey: (shared: Buffer, t: PairingTranscript) => Buffer
  pairingSas: (t: PairingTranscript) => string
  pairingKeyId: (key: Buffer) => string
  pairingCommitment: (routerNonce: string, routerPub: string, controllerPub: string) => string
  commitmentMatches: (
    commitment: string,
    routerNonce: string,
    routerPub: string,
    controllerPub: string
  ) => boolean
  generatePairingKeyPair: () => X25519KeyPair
  x25519PublicKey: (privateKey: string) => string
  x25519Shared: (privateKey: string, peerPublicKey: string) => Buffer
  newPairingNonce: () => string
  isHex32: (value: unknown) => boolean
  // rpc_signing.ts
  signParams: (
    key: string | Buffer,
    method: string,
    challenge: string,
    params: Record<string, unknown>,
    options?: { ts?: number; nonce?: string }
  ) => SignedEnvelope
  parseSigning: (value: unknown) => AgentSigning | null
  signatureMessage: (
    method: string,
    challenge: string,
    ts: number,
    nonce: string,
    payload: string
  ) => string
  // types.ts
  actorColumns: (actor: PlaneActor | null | undefined) => {
    userId: number | null
    systemActor: SystemActor | null
  }
} = {
  canonicalText,
  cloneContent,
  contentsEqual,
  diffEntry,
  diffOptions,
  entriesOf,
  itemsOf,
  ownedProjection,
  valueKey,
  applySectionEdits,
  checkRoundTrip,
  roundTripsSection,
  compareConfigs,
  contentOf,
  rulesFor,
  syncedFromRouter,
  validateDesired,
  secretFingerprint,
  isFingerprint,
  isSecretOption,
  redactOptions,
  newSecretRef,
  controllerSecretSlot,
  wireOptions,
  routerSecretSlots,
  reconcileRead,
  mergeSection,
  resolveConflict,
  acceptDrift,
  computeSyncStatus,
  checkEnableAuthoritative,
  checkModeChange,
  nextApplyState,
  sectionsDueForRevert,
  enforcementAfterFailure,
  markConfirmed,
  markRolledBack,
  markInFlight,
  applyControllerEdit,
  deriveStatus,
  rollupSyncState,
  computeUnledgered,
  revertDueAt,
  isGone,
  isEcho,
  diffBases,
  planApply,
  planSectionEdits,
  touchesManagementPath,
  buildSnapshot,
  diffSnapshots,
  summarizeDiff,
  rejoinOffer,
  revisionsToPrune,
  planRestore,
  pairingSubject,
  derivePairingKey,
  pairingSas,
  pairingKeyId,
  pairingCommitment,
  commitmentMatches,
  generatePairingKeyPair,
  x25519PublicKey,
  x25519Shared,
  newPairingNonce,
  isHex32,
  signParams,
  parseSigning,
  signatureMessage,
  actorColumns,
}

/** Classes and constants the plane uses. */
const CORE_VALUES = {
  DomainRegistry,
  SectionEditError,
  EditRefusedError,
  GatewaySerialQueue,
  QueueFullError,
  DEFAULT_RULES,
  EXCLUDED_CONFIGS,
  LEDGER_CONFIG,
  CONFIG_APPLY_ORDER,
  DEFAULT_SECRET_OPTIONS,
  FINGERPRINT_PREFIX,
  FINISHED_APPLY_STATES,
  PAIRING_KEY_BYTES,
  SIGNATURE_VERSION,
  WHOLE_SECTION,
  APPLY_STATES,
  CONFIRM_MODES,
  GATEWAY_MODES,
  SECTION_SCOPES,
  SECTION_STATUSES,
}

// Type-only exports the plane names (a removal or rename fails typecheck).
export type WifiCoreTypes = [
  ListSemantics,
  DomainClaim,
  SecretEdit,
  SyncBlocker,
  SectionChange,
  EngineEvent,
  PlannedJob,
  AgentAccess,
  ApplyKind,
  ApplyOp,
  ConfirmMode,
  LedgerChange,
  RevisionSource,
  RouterAuthor,
  SectionConflict,
  SectionScope,
  UciConfig,
  UciConfigSet,
  PairingSubject,
]

// ── sample inputs: every field the Wi-Fi plane sets ──────────────────────

const NOW = '2026-10-02T10:00:00.000Z'

function row(partial: Partial<SectionState> & { perchId: string }): SectionState {
  return {
    config: 'wireless',
    name: partial.perchId,
    type: 'wifi-iface',
    anonymous: false,
    scope: 'synced',
    domain: 'test_ifaces',
    ownership: null,
    issue: null,
    base: null,
    baseRevision: null,
    router: null,
    desired: null,
    status: 'in_sync',
    conflict: null,
    driftSince: null,
    position: null,
    ...partial,
  }
}

/** A domain using every hook the Wi-Fi domains use (`domains/*.ts`). */
const testDomain: ConfigDomain<SyncedSection> = {
  key: 'test_ifaces',
  configs: ['wireless'],
  types: ['wifi-iface'],
  claims: (section, all) =>
    section.options.mode !== 'sta' &&
    (all.wireless?.sections ?? []).some((s) => s.name === section.options.device),
  ownership: () => ({ kind: 'options', options: ['device', 'ssid', 'encryption', 'key'] }),
  listSemantics: { 'wifi-iface.network': 'set' },
  secretOptions: ['key', 'sae_password'],
  normalize: (_type, option, value) =>
    option === 'encryption' && value === 'psk2+ccmp' ? 'psk2' : value,
  identityKeys: (section) => [
    `iface:${String(section.options.device)}:${String(section.options.ssid)}`,
  ],
  touchesManagement: (section, path) => path.device === section.name,
  parse: (sections) => sections.map((s) => ({ ...s, options: { ...s.options } })),
  render: (obj) => [
    {
      op: 'put',
      perchId: obj.perchId,
      config: obj.config,
      type: obj.type,
      options: { ...obj.options },
      ...(obj.secrets ? { secrets: { key: { keep: true } } } : {}),
    },
  ],
  validate: () => [],
}

test.group('wifi core contract | exports', () => {
  test('every core function and value the Wi-Fi plane imports exists', ({ assert }) => {
    for (const [name, fn] of Object.entries(CORE_FUNCTIONS)) assert.isFunction(fn, name)
    for (const [name, value] of Object.entries(CORE_VALUES)) assert.exists(value, name)
  })

  test('the AP configs are allowed, the agent’s own config never is', ({ assert }) => {
    assert.notInclude(EXCLUDED_CONFIGS, 'wireless')
    assert.notInclude(EXCLUDED_CONFIGS, 'network')
    assert.include(EXCLUDED_CONFIGS, 'perch-apd')
    assert.include(EXCLUDED_CONFIGS, LEDGER_CONFIG)
    assert.throws(
      () => new DomainRegistry([{ ...testDomain, key: 'bad', configs: ['perch-apd'] }]),
      /excluded/
    )
    // Apply order: VLAN plumbing (network) before the SSIDs on it (wireless).
    assert.isBelow(compareConfigs('network', 'wireless'), 0)
    assert.notInclude(CONFIG_APPLY_ORDER, 'wireless')
  })

  test('a second serial queue instance is independent and bounded', async ({ assert }) => {
    const apQueue = new GatewaySerialQueue(64, 1024)
    assert.equal(await apQueue.run(4, async () => 'ok'), 'ok')
    const tiny = new GatewaySerialQueue(1, 1)
    let release!: () => void
    const held = tiny.run(1, () => new Promise<void>((resolve) => (release = resolve)))
    await assert.rejects(() => tiny.run(1, async () => null), QueueFullError)
    await assert.rejects(() => tiny.run(2, async () => null), QueueFullError)
    release()
    await held
  })
})

test.group('wifi core contract | W0 pairing subject', () => {
  const controllerPriv = '77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a'
  const routerPriv = '5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb'
  const base = {
    controllerPub: '8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a',
    routerPub: 'de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f',
    controllerNonce: '11'.repeat(32),
    routerNonce: '22'.repeat(32),
  }

  test('the pinned gateway vector is unchanged (gatewayId 7, or subject 7)', ({ assert }) => {
    const shared = x25519Shared(controllerPriv, base.routerPub)
    assert.equal(x25519PublicKey(routerPriv), base.routerPub)
    for (const t of [
      { ...base, gatewayId: 7 },
      { ...base, subject: 7 },
      { ...base, subject: '7' },
    ] satisfies PairingTranscript[]) {
      assert.equal(pairingSubject(t), '7')
      const key = derivePairingKey(shared, t)
      assert.equal(
        key.toString('hex'),
        '6ab9f1d40416ea38eb9b448cecef75bc2ab631a5940225c5fd80df386f1edacb'
      )
      assert.equal(pairingSas(t), '331510')
      assert.equal(pairingKeyId(key), '38545dab8f16e8a2')
    }
  })

  test('new vector: subject "ap:4" (cross-checked with an independent HKDF)', ({ assert }) => {
    const shared = x25519Shared(controllerPriv, base.routerPub)
    const t: PairingTranscript = { ...base, subject: 'ap:4' }
    const key = derivePairingKey(shared, t)
    assert.equal(
      key.toString('hex'),
      '2a847a9e11f88501bfd244f672107ff35f647be7784cc6e8e222a6ace0fa478d'
    )
    assert.equal(pairingSas(t), '498561')
    assert.equal(pairingKeyId(key), 'e2654ff239b23319')
    // The commitment does not depend on the subject.
    assert.equal(
      pairingCommitment(base.routerNonce, base.routerPub, base.controllerPub),
      'ff24b3e804967019f7662f53a2499f330b0c5fc227540479bcecea5dc678e9c4'
    )
    // An AP key never verifies for the gateway with the same number.
    const gatewayKey = derivePairingKey(shared, { ...base, gatewayId: 4 })
    assert.notEqual(key.toString('hex'), gatewayKey.toString('hex'))
    assert.notEqual(pairingSas(t), pairingSas({ ...base, gatewayId: 4 }))
  })

  test('a transcript without a subject is refused', ({ assert }) => {
    assert.throws(() => pairingSubject({ ...base, subject: '' }))
  })
})

test.group('wifi core contract | behaviour the AP plane relies on', () => {
  test('unbound fingerprints: the core formula with section "*" gives the shared vector', ({
    assert,
  }) => {
    // protocol.md 3.2: key = 32 × 0x44 (the ASCII string "DDD…"), option `key`.
    const fleetKey = 'D'.repeat(32)
    const where = { config: 'wireless', section: '*', option: 'key' }
    assert.equal(
      secretFingerprint(fleetKey, where, 'correct horse battery'),
      'hmac:ac349a3eb980336c'
    )
    assert.equal(secretFingerprint(fleetKey, where, ['a', 'b']), 'hmac:afe901da1eba8775')
    assert.isTrue(isFingerprint('hmac:ac349a3eb980336c'))
    assert.isTrue(isSecretOption('wifi-iface', 'key'))
    assert.isTrue(isSecretOption('wifi-iface', 'sae_password'))
  })

  test('reconcileRead imports a claimed section with option ownership and secrets', ({
    assert,
  }) => {
    const registry = new DomainRegistry([testDomain as ConfigDomain])
    const read: UciConfig = {
      name: 'wireless',
      hash: 'w1',
      sections: [
        {
          name: 'radio0',
          type: 'wifi-device',
          anonymous: false,
          index: 0,
          options: { band: '2g' },
        },
        {
          name: 'wifinet1',
          type: 'wifi-iface',
          anonymous: false,
          index: 1,
          options: { device: 'radio0', mode: 'ap', ssid: 'Home', encryption: 'psk2+ccmp' },
          secrets: { key: 'hmac:0000000000000001' },
        },
      ],
    }
    let n = 0
    const input: ReconcileReadInput = {
      rows: [],
      read: { configs: [read], ledger: [] },
      registry,
      mode: 'observe',
      authoritative: false,
      now: NOW,
      newPerchId: () => `p${++n}`,
      inFlight: new Map<string, InFlight>(),
      initialScope: () => null,
    }
    const result = reconcileRead(input)
    const iface = result.changes.find((c) => c.after?.name === 'wifinet1')!.after!
    assert.equal(iface.scope, 'synced')
    assert.equal(iface.domain, 'test_ifaces')
    assert.deepEqual(iface.ownership, {
      kind: 'options',
      options: ['device', 'ssid', 'encryption', 'key'],
    })
    assert.deepEqual(iface.router?.secrets, { key: { fingerprint: 'hmac:0000000000000001' } })
    const radio = result.changes.find((c) => c.after?.name === 'radio0')!.after!
    assert.equal(radio.scope, 'unmodeled')
    assert.equal(result.revisionSource, 'import')
  })

  test('editSections core: a new section gets the requested name and the domain', ({ assert }) => {
    const registry = new DomainRegistry([testDomain as ConfigDomain])
    const input: EditSectionsInput = {
      rows: [],
      edits: [
        {
          op: 'put',
          perchId: null,
          config: 'wireless',
          type: 'wifi-iface',
          name: 'perch_n12_radio1',
          options: { device: 'radio1', mode: 'ap', ssid: 'Kids', encryption: 'sae-mixed' },
          secrets: { key: { ref: 's1', fingerprint: 'hmac:0000000000000002' } },
        },
      ],
      domain: 'test_ifaces',
      registry,
      authoritative: false,
      newPerchId: () => 'q1',
    }
    const out = planSectionEdits(input)
    assert.lengthOf(out.upserts, 1)
    assert.equal(out.upserts[0].name, 'perch_n12_radio1')
    assert.equal(out.upserts[0].status, 'ahead')
    assert.deepEqual(out.upserts[0].desired?.secrets, {
      key: { ref: 's1', fingerprint: 'hmac:0000000000000002' },
    })
    const plan = planApply({
      sections: out.upserts,
      kind: 'apply',
      ledger: [],
      hashes: { wireless: 'w1', network: 'n1' },
      management: { network: 'lan', device: 'br-lan.1' },
      registry,
      orders: [],
    })
    assert.lengthOf(plan.jobs, 1)
    const put = plan.jobs[0].ops.find((o) => o.op === 'put')
    assert.deepEqual(put && put.op === 'put' ? put.options.key : null, { $secret: 's1' })
    assert.deepEqual(plan.jobs[0].secretRefs, ['s1'])
    assert.deepEqual(plan.jobs[0].base, { wireless: 'w1' })
  })

  test('management path: the built-in network rules fit an AP uplink', ({ assert }) => {
    const path: ManagementPath = { network: 'lan', device: 'br-lan.1' }
    const iface = { type: 'interface', options: { device: 'br-lan.1', proto: 'static' } }
    const bridge = { type: 'device', options: { name: 'br-lan', type: 'bridge' } }
    const vlan = { type: 'bridge-vlan', options: { device: 'br-lan', vlan: '1' } }
    const guest = { type: 'interface', options: { device: 'br-lan.30', proto: 'none' } }
    assert.isTrue(touchesManagementPath('network', 'lan', iface, path))
    assert.isTrue(touchesManagementPath('network', 'cfg030f15', bridge, path))
    assert.isTrue(touchesManagementPath('network', 'cfg040f15', vlan, path))
    assert.isFalse(touchesManagementPath('network', 'perch_nv30', guest, path))
  })

  test('section lifecycle helpers used by the AP apply lifecycle', ({ assert }) => {
    const rules = rulesFor(testDomain as ConfigDomain)
    const c = { type: 'wifi-iface', options: { device: 'radio0', ssid: 'A', encryption: 'psk2' } }
    const r = row({ perchId: 'p1', base: c, router: c, desired: c })
    const edited = applyControllerEdit(
      r,
      { ...c, options: { ...c.options, ssid: 'B' } },
      {
        authoritative: false,
        rules,
      }
    )
    assert.equal(edited.status, 'ahead')
    assert.equal(markInFlight(edited, 'apply').status, 'pending')
    const confirmed = markConfirmed(edited, edited.desired, { authoritative: false, rules })
    assert.equal(confirmed.status, 'in_sync')
    const rolledBack = markRolledBack(edited, { authoritative: false, now: NOW, rules })
    assert.equal(rolledBack.status, 'ahead')
    assert.equal(nextApplyState('queued', 'send'), 'sending')
    assert.equal(nextApplyState('sending', 'committed'), 'pending_confirm')
    assert.equal(nextApplyState('pending_confirm', 'confirmed'), 'confirmed')
    assert.include(FINISHED_APPLY_STATES, 'rolled_back')
    const merge = mergeSection({
      base: c,
      router: { ...c, options: { ...c.options, encryption: 'psk2+ccmp' } },
      desired: c,
      ownership: { kind: 'options', options: ['ssid', 'encryption'] },
      rules,
    })
    assert.equal(merge.kind, 'unchanged', 'normalised equality: psk2+ccmp = psk2')
    const status = computeSyncStatus({
      mode: 'managed',
      online: true,
      enforcement: 'active',
      headRevision: 3,
      observedAt: NOW,
      applyInFlight: false,
      luciPending: false,
      uncommitted: [],
      sections: [r],
      unledgered: [],
      registry: null,
      orders: [],
      features: [
        { feature: 'fleet', objectId: '9', code: 'divergence_open', message: 'open divergence' },
      ],
    })
    assert.isFalse(status.inSync)
    assert.deepInclude(status.blockers, {
      kind: 'feature',
      feature: 'fleet',
      objectId: '9',
      code: 'divergence_open',
      message: 'open divergence',
    })
    assert.deepEqual(checkEnableAuthoritative(status, 2), {
      ok: false,
      error: 'sync_changed',
      blockers: status.blockers,
      headRevision: 3,
    })
    assert.equal(
      checkModeChange('off', 'managed', {
        hasCapability: true,
        routerAccess: 'write',
        transportOk: false,
        passwordVerified: true,
      }),
      'insecure_transport'
    )
    assert.deepEqual(
      sectionsDueForRevert([row({ perchId: 'p2', status: 'drift', driftSince: NOW })], {
        now: '2026-10-02T10:01:31.000Z',
        delaySeconds: 90,
        enforcement: 'active',
        authoritative: true,
      }),
      ['p2']
    )
    assert.equal(
      enforcementAfterFailure([NOW, NOW], { now: NOW, maxFailures: 2, windowMinutes: 60 }),
      'suspended'
    )
    assert.equal(
      rollupSyncState({ mode: 'off', observedAt: NOW, applyInFlight: false, statuses: [] }),
      'unknown'
    )
    const snapshot = buildSnapshot([r])
    assert.equal(summarizeDiff(diffSnapshots([], snapshot)), '1 added (wireless)')
    assert.equal(
      rejoinOffer([
        { number: 1, confirmedAt: NOW },
        { number: 2, confirmedAt: null },
      ]),
      1
    )
    assert.deepEqual(planRestore([r], snapshot).updates, [{ perchId: 'p1', desired: c }])
  })

  test('signing envelope vector (shared with the agents)', ({ assert }) => {
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
    assert.equal(env.sig.mac, '2ae21083603b5bf27157bf935395c42b2d4c607e8d6b93cf3abe9ba59d7b7e9e')
    assert.equal(env.sig.v, SIGNATURE_VERSION)
    assert.deepEqual(parseSigning({ required: false, key: 'none', challenge: 'c' }), {
      required: false,
      challenge: 'c',
      key: 'none',
      keyId: undefined,
      windowSeconds: undefined,
    })
  })
})
