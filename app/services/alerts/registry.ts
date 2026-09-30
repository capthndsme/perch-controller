import {
  ALERT_KINDS,
  CATEGORIES,
  SEVERITIES,
  SUBJECT_KINDS,
  type AlertTypeDef,
  type DetectorDef,
} from '#services/alerts/model'

export type {
  AlertTypeDef,
  DetectorContext,
  DetectorDef,
  ParamDef,
  RenderContext,
  RenderInput,
  RenderedText,
  Rule,
} from '#services/alerts/model'

/**
 * Registration of alert types and detectors (README §2.2, events.md §1.4–1.5).
 *
 * Each area owns one catalogue file under `app/services/alerts/catalogue/`
 * whose default export is `defineAlertTypes([...])`; `catalogue/index.ts`
 * collects them (a duplicate name throws there, at boot). Detectors call
 * `registerDetector` when their module is imported (`detectors/index.ts`).
 *
 * This module imports nothing but the shared types, so catalogue files can
 * import it without an import cycle.
 */

const TYPE_NAME = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/

/**
 * Checks a list of type definitions and returns it unchanged. A malformed
 * definition is a programming error and throws (the unit suite loads every
 * catalogue file).
 */
export function defineAlertTypes(defs: AlertTypeDef[]): AlertTypeDef[] {
  const seen = new Set<string>()
  for (const def of defs) {
    const where = `alert type "${def.type}"`
    if (!TYPE_NAME.test(def.type) || def.type.length > 64) {
      throw new Error(`${where}: name must be <namespace>.<what> in snake_case, ≤ 64 characters`)
    }
    if (seen.has(def.type)) throw new Error(`${where}: defined twice in one file`)
    seen.add(def.type)
    if (!(CATEGORIES as readonly string[]).includes(def.category)) {
      throw new Error(`${where}: unknown category "${def.category}"`)
    }
    if (!(ALERT_KINDS as readonly string[]).includes(def.kind)) {
      throw new Error(`${where}: unknown kind "${def.kind}"`)
    }
    if (!(SEVERITIES as readonly string[]).includes(def.severity)) {
      throw new Error(`${where}: unknown severity "${def.severity}"`)
    }
    if (def.subjects.length === 0) throw new Error(`${where}: needs at least one subject kind`)
    for (const kind of def.subjects) {
      if (!(SUBJECT_KINDS as readonly string[]).includes(kind)) {
        throw new Error(`${where}: unknown subject kind "${kind}"`)
      }
    }
    const keys = new Set<string>()
    for (const param of def.params ?? []) {
      if (keys.has(param.key)) throw new Error(`${where}: param "${param.key}" declared twice`)
      keys.add(param.key)
      if (param.kind === 'int' && (param.default < param.min || param.default > param.max)) {
        throw new Error(`${where}: param "${param.key}" default outside [min, max]`)
      }
      if (param.kind === 'enum' && !param.options.includes(param.default)) {
        throw new Error(`${where}: param "${param.key}" default is not one of its options`)
      }
    }
  }
  return defs
}

const detectors = new Map<string, DetectorDef>()

/**
 * Registers a detector (level-triggered or a watermark scan). The evaluate
 * task runs every detector whose period is due, one after the other, each in
 * its own try/catch. Registering the same id again replaces it (hot reload).
 */
export function registerDetector(d: DetectorDef): void {
  if (!d.id || d.id.length > 48) throw new Error('registerDetector: id must be 1–48 characters')
  detectors.set(d.id, d)
}

/** Registered detectors, in registration order. */
export function listDetectors(): DetectorDef[] {
  return [...detectors.values()]
}

/** Tests only: forget every registered detector (or one). */
export function _unregisterDetector(id?: string): void {
  if (id === undefined) detectors.clear()
  else detectors.delete(id)
}
