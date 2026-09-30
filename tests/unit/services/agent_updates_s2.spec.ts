import AgentArtefact from '#models/agent_artefact'
import AgentRelease from '#models/agent_release'
import AgentUpdateDevice from '#models/agent_update_device'
import type { DeviceHandle } from '#services/agent_updates/devices'
import { offersFor, type FleetContext } from '#services/agent_updates/fleet'
import { parseManifest } from '#services/agent_updates/manifest'
import { sanitizePreflight, sanitizeUpdateReport } from '#services/agent_updates/report'
import { AGENT_UPDATE_DEFAULTS } from '#services/agent_updates/settings'
import { deviceKey, parseDeviceKey } from '#services/agent_updates/state'
import { deviceTarget, selectArtefacts } from '#services/agent_updates/targets'
import { versionSortKey } from '#services/agent_updates/versions'
import {
  currentWindow,
  isWindowOpen,
  nextWindowStart,
  windowNotBefore,
} from '#services/agent_updates/window'
import { buildManifest, updateBlock, type TestArtefact } from '#tests/helpers/agent_updates'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'

let nextId = 1

/** An in-memory release with its artefacts (nothing touches the database). */
function release(options: Parameters<typeof buildManifest>[0] = {}) {
  const built = buildManifest(options)
  const manifest = parseManifest(built.bytes)
  const row = new AgentRelease()
  row.id = nextId++
  row.product = manifest.product
  row.version = manifest.version
  row.versionSort = versionSortKey(manifest.version)
  row.channel = manifest.channel
  row.manifest = built.bytes.toString('utf8')
  row.minVersion = manifest.minVersion
  row.minFromVersion = manifest.minFromVersion
  row.minControllerVersion = manifest.minControllerVersion
  row.withdrawnAt = null
  const artefacts = manifest.artefacts.map((entry) => {
    const artefact = new AgentArtefact()
    artefact.id = nextId++
    artefact.releaseId = row.id
    artefact.fileName = entry.file
    artefact.kind = entry.kind
    artefact.arch = entry.kind === 'binary' ? entry.arch : null
    artefact.variant = entry.kind === 'binary' ? entry.variant : null
    artefact.manager = entry.kind === 'package' ? entry.manager : null
    artefact.openwrtSeries = entry.kind === 'package' ? entry.openwrt : null
    artefact.pkgArch = entry.kind === 'package' ? entry.pkgArch : null
    artefact.packageName = entry.kind === 'package' ? entry.package : null
    artefact.sizeBytes = entry.size
    artefact.sha256 = entry.sha256
    artefact.storedPath = 'x'
    return artefact
  })
  return { row, artefacts }
}

function device(
  version: string,
  report: Record<string, unknown> | null,
  settings: Partial<Pick<AgentUpdateDevice, 'channel' | 'pinnedVersion'>> = {}
): DeviceHandle {
  const row = new AgentUpdateDevice()
  row.report = report ? sanitizeUpdateReport(report) : null
  row.channel = settings.channel ?? null
  row.pinnedVersion = settings.pinnedVersion ?? null
  row.autoUpdate = 'inherit'
  return {
    kind: 'ap',
    id: 4,
    key: 'ap:4',
    name: 'ap',
    product: 'perch-apd',
    role: 'ap',
    version,
    capabilities: ['agent_update'],
    transport: 'agent',
    arch: 'mipsle',
    online: true,
    secure: null,
    settings: row,
  }
}

function context(releases: ReturnType<typeof release>[]): FleetContext {
  return {
    settings: { ...AGENT_UPDATE_DEFAULTS, windowDays: [...AGENT_UPDATE_DEFAULTS.windowDays] },
    releases: releases.map((entry) => entry.row),
    artefacts: new Map(releases.map((entry) => [entry.row.id, entry.artefacts])),
    controllerUrl: null,
    now: DateTime.utc(),
  }
}

const versions = (offers: ReturnType<typeof offersFor>) => offers.map((o) => o.release.version)

test.group('agent updates: availability', () => {
  test('channels: stable sees stable, pre adds pre, local sees everything', ({ assert }) => {
    const all = [
      release({ version: '1.2.0' }),
      release({ version: '1.3.0-rc.1', channel: 'pre' }),
      release({ version: '1.3.0-pre.5', channel: 'local' }),
    ]
    const ctx = context(all)
    assert.deepEqual(versions(offersFor(device('1.1.0', updateBlock()), ctx)), ['1.2.0'])
    assert.deepEqual(versions(offersFor(device('1.1.0', updateBlock(), { channel: 'pre' }), ctx)), [
      '1.3.0-rc.1',
      '1.2.0',
    ])
    assert.deepEqual(
      versions(offersFor(device('1.1.0', updateBlock(), { channel: 'local' }), ctx)),
      ['1.3.0-rc.1', '1.3.0-pre.5', '1.2.0']
    )
  })

  test('floor, minFromVersion, minControllerVersion, pinned, older, withdrawn', ({ assert }) => {
    const ctx = context([
      release({ version: '1.2.0' }),
      release({ version: '1.4.0', minFromVersion: '1.2.0' }),
      release({ version: '1.5.0', minControllerVersion: '99.0.0' }),
      release({ version: '1.0.0' }),
    ])
    assert.deepEqual(versions(offersFor(device('1.1.0', updateBlock()), ctx)), ['1.2.0'])
    assert.deepEqual(versions(offersFor(device('1.2.0', updateBlock()), ctx)), ['1.4.0'])
    assert.deepEqual(versions(offersFor(device('1.1.0', updateBlock({ floor: '1.3.0' })), ctx)), [])
    assert.deepEqual(
      versions(offersFor(device('1.1.0', updateBlock(), { pinnedVersion: '1.1.0' }), ctx)),
      []
    )
    const withdrawn = release({ version: '1.2.5' })
    withdrawn.row.withdrawnAt = DateTime.utc()
    assert.deepEqual(versions(offersFor(device('1.2.0', updateBlock()), context([withdrawn]))), [])
  })

  test('no report, self_update off, or no artefact for the arch: nothing offered', ({ assert }) => {
    const ctx = context([release({ version: '1.2.0' })])
    assert.lengthOf(offersFor(device('1.1.0', null), ctx), 0)
    assert.lengthOf(offersFor(device('1.1.0', updateBlock({ enabled: false })), ctx), 0)
    assert.lengthOf(offersFor(device('1.1.0', updateBlock({ arch: 'armv5' })), ctx), 0)
    assert.lengthOf(offersFor(device('dev', updateBlock()), ctx), 1)
  })
})

test.group('agent updates: artefact selection', () => {
  const artefacts: TestArtefact[] = [
    { file: 'perch-apd-linux-mipsle', kind: 'binary', arch: 'mipsle' },
    {
      file: 'perch-apd_1.2.0-r1_mipsel_24kc.ipk',
      kind: 'package',
      manager: 'opkg',
      openwrt: '24.10',
      pkgArch: 'mipsel_24kc',
    },
    {
      file: 'perch-apd-files.tar.gz',
      kind: 'files',
      paths: ['/etc/init.d/perch-apd', '/etc/init.d/perch-apd-guard'],
    },
  ]

  test('a package install gets the package; a swapped one the binary and files bundle', ({
    assert,
  }) => {
    const { row, artefacts: rows } = release({ version: '1.2.0', artefacts })
    const manifest = parseManifest(row.manifest)
    const packaged = deviceTarget(
      'perch-apd',
      sanitizeUpdateReport(
        updateBlock({
          installKind: 'package',
          methods: ['package', 'binary'],
          packageManager: 'opkg',
          openwrt: { release: '24.10.2', series: '24.10', pkgArch: 'mipsel_24kc' },
        })
      ),
      null
    )
    const byPackage = selectArtefacts(rows, manifest, packaged)
    assert.isTrue(byPackage.ok)
    assert.deepEqual(byPackage.ok ? byPackage.artefacts.map((a) => a.fileName) : [], [
      'perch-apd_1.2.0-r1_mipsel_24kc.ipk',
    ])
    const byBinary = selectArtefacts(rows, manifest, packaged, 'binary')
    assert.deepEqual(byBinary.ok ? byBinary.artefacts.map((a) => a.fileName) : [], [
      'perch-apd-linux-mipsle',
    ])

    const swapped = deviceTarget('perch-apd', sanitizeUpdateReport(updateBlock()), null)
    const selection = selectArtefacts(rows, manifest, swapped)
    assert.deepEqual(selection.ok ? selection.artefacts.map((a) => a.fileName) : [], [
      'perch-apd-linux-mipsle',
      'perch-apd-files.tar.gz',
    ])
    const refused = selectArtefacts(rows, manifest, swapped, 'package')
    assert.deepEqual(refused, { ok: false, error: 'method_unsupported', method: 'package' })
  })
})

test.group('agent updates: maintenance window', () => {
  const settings = {
    windowEnabled: true,
    windowDays: [1], // Monday
    windowStart: '23:00',
    windowEnd: '02:00',
  }

  test('a window crossing midnight, in the instance time zone', ({ assert }) => {
    const zone = 'Asia/Manila'
    // Monday 23:30 Manila = Monday 15:30 UTC.
    const mondayLate = DateTime.fromISO('2026-10-05T23:30', { zone }).toUTC()
    assert.isTrue(isWindowOpen(settings, zone, mondayLate))
    // Tuesday 01:30 Manila: still Monday's window.
    const tuesdayEarly = DateTime.fromISO('2026-10-06T01:30', { zone }).toUTC()
    assert.isTrue(isWindowOpen(settings, zone, tuesdayEarly))
    assert.equal(
      currentWindow(settings, zone, tuesdayEarly)!.start.toISO(),
      DateTime.fromISO('2026-10-05T23:00', { zone }).toUTC().toISO()
    )
    // Tuesday 23:30 Manila: Tuesday is not a window day.
    const tuesdayLate = DateTime.fromISO('2026-10-06T23:30', { zone }).toUTC()
    assert.isFalse(isWindowOpen(settings, zone, tuesdayLate))
    assert.equal(
      nextWindowStart(settings, zone, tuesdayLate)!.toISO(),
      DateTime.fromISO('2026-10-12T23:00', { zone }).toUTC().toISO()
    )
    assert.equal(
      windowNotBefore(settings, zone, tuesdayLate).toISO(),
      DateTime.fromISO('2026-10-12T23:00', { zone }).toUTC().toISO()
    )
    assert.equal(windowNotBefore(settings, zone, mondayLate).toISO(), mondayLate.toISO())
  })

  test('switched off: always open, no next start', ({ assert }) => {
    const off = { ...settings, windowEnabled: false }
    assert.isTrue(isWindowOpen(off, 'UTC'))
    assert.isNull(nextWindowStart(off, 'UTC'))
  })
})

test.group('agent updates: reports', () => {
  test('the update block is sanitised field by field', ({ assert }) => {
    const report = sanitizeUpdateReport({
      ...updateBlock(),
      installKind: 'rootkit',
      methods: ['binary', 'curl|sh', 'binary'],
      keyIds: ['0123456789abcdef', 'nope'],
      binarySha256: 'not a hash',
      active: { updateId: 'u-0123456789abcdef', phase: 'probation', extra: 1 },
      results: Array.from({ length: 12 }, (_, i) => ({
        updateId: `u-${String(i).padStart(16, '0')}`,
        outcome: 'rolled_back',
        reason: 'crash_loop',
      })),
      injected: '<script>',
    })!
    assert.isNull(report.installKind)
    assert.deepEqual(report.methods, ['binary'])
    assert.deepEqual(report.keyIds, ['0123456789abcdef'])
    assert.isNull(report.binarySha256)
    assert.equal(report.active?.phase, 'probation')
    assert.lengthOf(report.results, 10)
    assert.notProperty(report, 'injected')
    assert.isNull(sanitizeUpdateReport('garbage'))
    const preflight = sanitizePreflight({ ok: true, problems: [{ code: 'x' }, 'y'] })!
    assert.deepEqual(preflight.problems, [{ code: 'x', message: 'x' }])
  })

  test('device keys', ({ assert }) => {
    assert.equal(deviceKey('collector', 1), 'collector:1')
    assert.deepEqual(parseDeviceKey('ap:4'), { kind: 'ap', id: 4 })
    assert.isNull(parseDeviceKey('ap:0'))
    assert.isNull(parseDeviceKey('switch:1'))
  })
})
