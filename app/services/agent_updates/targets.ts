import type AgentArtefact from '#models/agent_artefact'
import {
  PRODUCT_PACKAGES,
  type AgentProduct,
  type InstallKind,
  type ReleaseManifest,
} from '#services/agent_updates/manifest'
import type { UpdateMethod, UpdateReport } from '#services/agent_updates/report'

/**
 * Which artefacts of a release fit a device (agent-updates controller.md
 * section 5.4, protocol.md 1.3 rule 6). The device checks again; this decides
 * what the controller offers and sends.
 *
 * - binary: `arch` equal, `variant` equal (perch-apd: none; the collector's
 *   static build: `ndpi-static`), plus the `files` bundle when one of its
 *   members is meant for the device's install kind;
 * - package: `manager`, OpenWrt series and `pkgArch` equal, the product's own
 *   package first (perch-collector: `perch-qos` too when the release has it).
 */

export type DeviceTarget = {
  product: AgentProduct
  arch: string | null
  variant: string | null
  installKind: InstallKind | null
  methods: UpdateMethod[]
  packageManager: 'opkg' | 'apk' | null
  series: string | null
  pkgArch: string | null
}

/** A device's target from its report; `fallbackArch` for agents that send none. */
export function deviceTarget(
  product: AgentProduct,
  report: UpdateReport | null,
  fallbackArch: string | null
): DeviceTarget {
  return {
    product,
    arch: report?.arch ?? fallbackArch,
    // Without a report, a collector is taken to be the hand-installed static build.
    variant: report ? report.variant : product === 'perch-collector' ? 'ndpi-static' : null,
    installKind: report?.installKind ?? null,
    methods: report?.methods ?? [],
    packageManager: report?.packageManager ?? null,
    series: report?.openwrt?.series ?? null,
    pkgArch: report?.openwrt?.pkgArch ?? null,
  }
}

export function binaryArtefactFor(
  artefacts: AgentArtefact[],
  target: DeviceTarget
): AgentArtefact | null {
  if (!target.arch) return null
  return (
    artefacts.find(
      (artefact) =>
        artefact.kind === 'binary' &&
        artefact.arch === target.arch &&
        (artefact.variant ?? null) === (target.variant ?? null)
    ) ?? null
  )
}

export function packageArtefactsFor(
  artefacts: AgentArtefact[],
  target: DeviceTarget
): AgentArtefact[] {
  if (!target.packageManager || !target.series || !target.pkgArch) return []
  const fitting = artefacts.filter(
    (artefact) =>
      artefact.kind === 'package' &&
      artefact.manager === target.packageManager &&
      artefact.openwrtSeries === target.series &&
      artefact.pkgArch === target.pkgArch &&
      PRODUCT_PACKAGES[target.product].includes(artefact.packageName ?? '')
  )
  const own = fitting.find((artefact) => artefact.packageName === target.product)
  if (!own) return []
  return [own, ...fitting.filter((artefact) => artefact !== own)]
}

export function filesArtefactFor(
  artefacts: AgentArtefact[],
  manifest: ReleaseManifest,
  target: DeviceTarget
): AgentArtefact | null {
  if (!target.installKind) return null
  const entry = manifest.artefacts.find(
    (candidate) =>
      candidate.kind === 'files' &&
      candidate.members.some((member) => member.installKinds.includes(target.installKind!))
  )
  if (!entry) return null
  return artefacts.find((artefact) => artefact.fileName === entry.file) ?? null
}

export type Selection =
  | { ok: true; method: UpdateMethod; artefacts: AgentArtefact[]; downloadBytes: number }
  | { ok: false; error: 'no_matching_artefact' | 'method_unsupported'; method: UpdateMethod }

/**
 * The method (the requested one, else package when the device is a package
 * install and the release has its package, else binary) and the files to
 * download for it.
 */
export function selectArtefacts(
  artefacts: AgentArtefact[],
  manifest: ReleaseManifest,
  target: DeviceTarget,
  requested?: UpdateMethod | null
): Selection {
  const packages = packageArtefactsFor(artefacts, target)
  const method: UpdateMethod =
    requested ?? (target.installKind === 'package' && packages.length > 0 ? 'package' : 'binary')
  if (target.methods.length > 0 && !target.methods.includes(method)) {
    return { ok: false, error: 'method_unsupported', method }
  }
  let chosen: AgentArtefact[]
  if (method === 'package') {
    if (packages.length === 0) return { ok: false, error: 'no_matching_artefact', method }
    chosen = packages
  } else {
    const binary = binaryArtefactFor(artefacts, target)
    if (!binary) return { ok: false, error: 'no_matching_artefact', method }
    const files = filesArtefactFor(artefacts, manifest, target)
    chosen = files ? [binary, files] : [binary]
  }
  return {
    ok: true,
    method,
    artefacts: chosen,
    downloadBytes: chosen.reduce((sum, artefact) => sum + artefact.sizeBytes, 0),
  }
}

/** What `no_matching_artefact` names so the admin sees why. */
export function targetDescription(target: DeviceTarget, method: UpdateMethod) {
  return {
    method,
    arch: target.arch,
    pkgArch: target.pkgArch,
    manager: target.packageManager,
    series: target.series,
  }
}
