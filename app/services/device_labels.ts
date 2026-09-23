import db from '@adonisjs/lucid/services/db'
import { DateTime } from 'luxon'

/**
 * Manual device taxonomy. A *fixed* list (rather than free text) so the
 * dashboard can map every value to a stable icon and offer "filter by type",
 * and so a rollup like "bytes by device type" stays meaningful. Personal
 * grouping — "kids", "office", "vlan-iot" — is what `tags` are for.
 *
 * Append-only: existing rows keep whatever value they were given, so removing
 * a member here would orphan stored labels.
 */
export const DEVICE_TYPES = [
  'phone',
  'tablet',
  'laptop',
  'desktop',
  'tv',
  'console',
  'speaker',
  'wearable',
  'camera',
  'iot',
  'printer',
  'nas',
  'server',
  'router',
  'access_point',
  'vehicle',
  'other',
] as const

export type DeviceType = (typeof DEVICE_TYPES)[number]

/**
 * How the device attaches, when the operator says so; null lets Perch work it
 * out (`devicePresence`). Without a mark, a device no Perch AP lists reads
 * "Wired / unknown": a cable, or Wi-Fi Perch does not read. Append-only, like
 * `DEVICE_TYPES`.
 */
export const DEVICE_CONNECTIONS = ['ethernet'] as const

export type DeviceConnection = (typeof DEVICE_CONNECTIONS)[number]

/** Human-readable names for the catalog endpoint; the UI picks the icons. */
const DEVICE_TYPE_LABELS: Record<DeviceType, string> = {
  phone: 'Phone',
  tablet: 'Tablet',
  laptop: 'Laptop',
  desktop: 'Desktop',
  tv: 'TV / streaming box',
  console: 'Game console',
  speaker: 'Speaker / audio',
  wearable: 'Wearable',
  camera: 'Camera',
  iot: 'IoT / smart home',
  printer: 'Printer',
  nas: 'NAS / storage',
  server: 'Server',
  router: 'Router / gateway',
  access_point: 'Access point',
  vehicle: 'Vehicle',
  other: 'Other',
}

export type DeviceLabel = {
  mac: string
  name: string | null
  deviceType: DeviceType | null
  connection: DeviceConnection | null
  tags: string[]
  notes: string | null
  updatedAt: string | null
  updatedByUserId: number | null
}

export type DeviceLabelInput = {
  name?: string | null
  deviceType?: DeviceType | null
  connection?: DeviceConnection | null
  tags?: string[] | null
  notes?: string | null
}

type DeviceLabelRow = {
  mac: string
  name: string | null
  deviceType: string | null
  connection: string | null
  tags: string | null
  notes: string | null
  updatedAt: Date | string | null
  updatedByUserId: number | null
}

const MAC_REGEX = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/
const NAME_MAX_LENGTH = 80
const NOTES_MAX_LENGTH = 2000
export const TAG_MAX_LENGTH = 24
export const MAX_TAGS = 12

/**
 * The whole table is cached in memory: it holds one row per *named* device
 * (tens, on a home LAN), and every device read path joins against it. The TTL
 * covers writes from another process; writes from this one invalidate
 * immediately.
 */
const CACHE_TTL_MS = 30_000
let cache: { map: Map<string, DeviceLabel>; loadedAtMs: number } | null = null
let inFlight: Promise<Map<string, DeviceLabel>> | null = null

/** `AA-BB-…` / `AA:BB:…` → `aa:bb:…`, or null when it isn't a MAC. */
export function normalizeMac(raw: string | null | undefined): string | null {
  if (!raw) return null
  const cleaned = raw.trim().toLowerCase().replace(/-/g, ':')
  return MAC_REGEX.test(cleaned) ? cleaned : null
}

export function isDeviceType(value: string | null | undefined): value is DeviceType {
  return typeof value === 'string' && (DEVICE_TYPES as readonly string[]).includes(value)
}

export function isDeviceConnection(value: string | null | undefined): value is DeviceConnection {
  return typeof value === 'string' && (DEVICE_CONNECTIONS as readonly string[]).includes(value)
}

/** The `{ id, label }` catalog the settings/filter UIs render. */
export function deviceTypeCatalog(): Array<{ id: DeviceType; label: string }> {
  return DEVICE_TYPES.map((id) => ({ id, label: DEVICE_TYPE_LABELS[id] }))
}

/**
 * Tags are lowercased and whitespace-collapsed so "Kids", "kids " and "kids"
 * are one tag (filtering by tag is an exact match). Order is the caller's —
 * it's what the chips render in — but duplicates and blanks are dropped.
 */
export function normalizeTags(tags: string[] | null | undefined): string[] {
  if (!tags) return []
  const out: string[] = []
  for (const raw of tags) {
    if (typeof raw !== 'string') continue
    const cleaned = raw.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, TAG_MAX_LENGTH).trim()
    if (!cleaned || out.includes(cleaned)) continue
    out.push(cleaned)
    if (out.length >= MAX_TAGS) break
  }
  return out
}

function normalizeText(raw: string | null | undefined, maxLength: number): string | null {
  if (raw === null || raw === undefined) return null
  const cleaned = raw.trim().slice(0, maxLength).trim()
  return cleaned.length > 0 ? cleaned : null
}

function parseTags(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed)
      ? parsed.filter((tag): tag is string => typeof tag === 'string')
      : []
  } catch {
    return []
  }
}

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null
  if (value instanceof Date) return DateTime.fromJSDate(value, { zone: 'utc' }).toISO()
  const sql = DateTime.fromSQL(value, { zone: 'utc' })
  if (sql.isValid) return sql.toISO()
  const iso = DateTime.fromISO(value, { setZone: true })
  return iso.isValid ? iso.toUTC().toISO() : String(value)
}

function toLabel(row: DeviceLabelRow): DeviceLabel {
  return {
    mac: row.mac.toLowerCase(),
    name: row.name,
    deviceType: isDeviceType(row.deviceType) ? row.deviceType : null,
    connection: isDeviceConnection(row.connection) ? row.connection : null,
    tags: parseTags(row.tags),
    notes: row.notes,
    updatedAt: toIso(row.updatedAt),
    updatedByUserId: row.updatedByUserId,
  }
}

async function loadAll(): Promise<Map<string, DeviceLabel>> {
  const rows = (await db
    .from('device_labels')
    .select(
      'mac',
      'name',
      'device_type as deviceType',
      'connection',
      'tags',
      'notes',
      'updated_at as updatedAt',
      'updated_by_user_id as updatedByUserId'
    )
    .orderBy('mac', 'asc')) as DeviceLabelRow[]

  const map = new Map<string, DeviceLabel>()
  for (const row of rows) {
    const label = toLabel(row)
    map.set(label.mac, label)
  }
  return map
}

/** Every stored label, keyed by lowercase MAC. Cached; see `CACHE_TTL_MS`. */
export async function getDeviceLabelMap(): Promise<Map<string, DeviceLabel>> {
  const now = Date.now()
  if (cache && now - cache.loadedAtMs < CACHE_TTL_MS) return cache.map

  if (!inFlight) {
    inFlight = loadAll()
      .then((map) => {
        cache = { map, loadedAtMs: Date.now() }
        return map
      })
      .finally(() => {
        inFlight = null
      })
  }

  return inFlight
}

/**
 * Batched lookup for read paths: resolves the label map once and picks the
 * requested MACs out of it, so enriching N devices costs one cached read.
 * Keys are lowercase MACs; MACs without a stored label are absent.
 */
export async function getDeviceLabels(macs: string[]): Promise<Map<string, DeviceLabel>> {
  const out = new Map<string, DeviceLabel>()
  if (macs.length === 0) return out

  const all = await getDeviceLabelMap()
  for (const mac of macs) {
    const key = mac.toLowerCase()
    const label = all.get(key)
    if (label) out.set(key, label)
  }
  return out
}

export async function getDeviceLabel(mac: string): Promise<DeviceLabel | null> {
  const key = normalizeMac(mac) ?? mac.toLowerCase()
  const all = await getDeviceLabelMap()
  return all.get(key) ?? null
}

export async function listDeviceLabels(): Promise<DeviceLabel[]> {
  const all = await getDeviceLabelMap()
  return [...all.values()]
}

/** Every tag in use, sorted — the tag filter's options and the input's autocomplete. */
export async function listDeviceTags(): Promise<string[]> {
  const all = await getDeviceLabelMap()
  const tags = new Set<string>()
  for (const label of all.values()) {
    for (const tag of label.tags) tags.add(tag)
  }
  return [...tags].sort((left, right) => left.localeCompare(right))
}

function isEmptyLabel(label: DeviceLabel): boolean {
  return (
    !label.name && !label.deviceType && !label.connection && label.tags.length === 0 && !label.notes
  )
}

/**
 * Merge `input` onto the device's stored label (omitted keys keep their
 * current value, explicit `null` clears one) and persist it. A label left
 * with nothing in it is deleted rather than stored blank, so "clear all the
 * fields" and "delete the label" converge on the same state.
 *
 * Returns the stored label, or `null` when the row was removed.
 */
export async function saveDeviceLabel(
  mac: string,
  input: DeviceLabelInput,
  updatedByUserId: number | null = null,
  now: DateTime = DateTime.utc()
): Promise<DeviceLabel | null> {
  const key = normalizeMac(mac)
  if (!key) throw new Error(`Not a MAC address: ${mac}`)

  const current = await getDeviceLabel(key)
  const next: DeviceLabel = {
    mac: key,
    name:
      input.name === undefined
        ? (current?.name ?? null)
        : normalizeText(input.name, NAME_MAX_LENGTH),
    deviceType:
      input.deviceType === undefined
        ? (current?.deviceType ?? null)
        : isDeviceType(input.deviceType)
          ? input.deviceType
          : null,
    connection:
      input.connection === undefined
        ? (current?.connection ?? null)
        : isDeviceConnection(input.connection)
          ? input.connection
          : null,
    tags: input.tags === undefined ? (current?.tags ?? []) : normalizeTags(input.tags),
    notes:
      input.notes === undefined
        ? (current?.notes ?? null)
        : normalizeText(input.notes, NOTES_MAX_LENGTH),
    updatedAt: now.toUTC().toISO(),
    updatedByUserId,
  }

  if (isEmptyLabel(next)) {
    await deleteDeviceLabel(key)
    return null
  }

  const nowSql = now.toUTC().toFormat('yyyy-MM-dd HH:mm:ss')
  await db
    .insertQuery()
    .table('device_labels')
    .insert({
      mac: key,
      name: next.name,
      device_type: next.deviceType,
      connection: next.connection,
      tags: JSON.stringify(next.tags),
      notes: next.notes,
      updated_by_user_id: updatedByUserId,
      created_at: nowSql,
      updated_at: nowSql,
    })
    .onConflict(['mac'])
    .merge({
      name: next.name,
      device_type: next.deviceType,
      connection: next.connection,
      tags: JSON.stringify(next.tags),
      notes: next.notes,
      updated_by_user_id: updatedByUserId,
      updated_at: nowSql,
    })

  invalidateDeviceLabelCache()
  return next
}

/** Removes the stored label. Returns whether a row was actually deleted. */
export async function deleteDeviceLabel(mac: string): Promise<boolean> {
  const key = normalizeMac(mac)
  if (!key) return false

  const deleted = await db.from('device_labels').where('mac', key).delete()
  invalidateDeviceLabelCache()
  return Number(deleted) > 0
}

export function invalidateDeviceLabelCache() {
  cache = null
}

/** Test hook: drops memoized state between tests. */
export function resetDeviceLabelCacheForTesting() {
  cache = null
  inFlight = null
}
