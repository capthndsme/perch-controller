import { createHash } from 'node:crypto'
import {
  BUILTIN_TEMPLATE_FILES,
  PORTAL_MESSAGES,
  portalSnippets,
} from '#services/portal/builtin_template'

/**
 * Guest portal page templates (docs/gateway/portal.md section 12): the upload
 * rules, the variables, the digest of a file set and the renderer the
 * controller uses for previews. Pure; the router (WP4) implements the same
 * renderer for the real pages.
 *
 * HTML is not sanitised (the admin is trusted and a Piso WiFi-style page
 * needs scripts). It is isolated instead: on the router it runs on the
 * portal's own origin under a strict CSP, and on the controller it is never
 * served as a document (previews are JSON for a sandboxed iframe).
 */

export const TEMPLATE_LIMITS = {
  maxFiles: 24,
  maxFileBytes: 512 * 1024,
  maxHtmlBytes: 256 * 1024,
  maxTotalBytes: 2 * 1024 * 1024,
} as const

export const TEMPLATE_FILE_NAME_REGEX = /^[a-z0-9][a-z0-9._-]{0,63}$/

export const LOGIN_PAGE = 'login.html'
export const STATUS_PAGE = 'status.html'

/** Accepted types by extension. Text types must be UTF-8 without NUL bytes. */
const TYPES: Record<string, { contentType: string; kind: 'text' | 'binary' }> = {
  html: { contentType: 'text/html; charset=utf-8', kind: 'text' },
  css: { contentType: 'text/css; charset=utf-8', kind: 'text' },
  js: { contentType: 'text/javascript; charset=utf-8', kind: 'text' },
  txt: { contentType: 'text/plain; charset=utf-8', kind: 'text' },
  svg: { contentType: 'image/svg+xml', kind: 'text' },
  png: { contentType: 'image/png', kind: 'binary' },
  jpg: { contentType: 'image/jpeg', kind: 'binary' },
  jpeg: { contentType: 'image/jpeg', kind: 'binary' },
  webp: { contentType: 'image/webp', kind: 'binary' },
  gif: { contentType: 'image/gif', kind: 'binary' },
  ico: { contentType: 'image/x-icon', kind: 'binary' },
  woff2: { contentType: 'font/woff2', kind: 'binary' },
}

export const TEMPLATE_EXTENSIONS = Object.keys(TYPES)

/**
 * The `{{name}}` variables a template may use. All are HTML-escaped except
 * `status_json` (JSON with `<`, `>` and `&` escaped, for
 * `<script type="application/json">`) and the three Perch-rendered snippets,
 * inserted as they are.
 */
export const TEMPLATE_VARIABLES = [
  'portal_name',
  'gateway_name',
  'client_mac',
  'client_ip',
  'origin_url',
  'message',
  'message_code',
  'assets',
  'remaining_time',
  'remaining_data',
  'expires_at',
  'privacy_notice',
  'methods',
  'status_json',
  'voucher_form',
  'login_form',
  'logout_form',
] as const
export type TemplateVariable = (typeof TEMPLATE_VARIABLES)[number]

const VARIABLE_SET = new Set<string>(TEMPLATE_VARIABLES)
const RAW_VARIABLES = new Set<string>(['voucher_form', 'login_form', 'logout_form'])
const VARIABLE_PATTERN = /\{\{\s*([^{}]*?)\s*\}\}/g

export type TemplateFileInput = { name: string; data: Buffer }
export type CheckedTemplateFile = {
  name: string
  contentType: string
  bytes: number
  sha256: string
  data: Buffer
}

export type TemplateRefusal = {
  status: 413 | 422
  error:
    | 'template_too_large'
    | 'missing_login_page'
    | 'unknown_variable'
    | 'bad_file_name'
    | 'unsupported_type'
    | 'too_many_files'
    | 'duplicate_file'
  message: string
  detail?: Record<string, unknown>
}

export type CheckFileResult =
  | { ok: true; file: CheckedTemplateFile }
  | { ok: false; refusal: TemplateRefusal }

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot + 1)
}

function startsWith(data: Buffer, bytes: number[], offset = 0): boolean {
  if (data.length < offset + bytes.length) return false
  return bytes.every((b, i) => data[offset + i] === b)
}

function ascii(text: string): number[] {
  return [...text].map((c) => c.charCodeAt(0))
}

const decoder = new TextDecoder('utf-8', { fatal: true })

function isUtf8Text(data: Buffer): boolean {
  if (data.includes(0)) return false
  try {
    decoder.decode(data)
    return true
  } catch {
    return false
  }
}

/** Magic bytes of the binary types (the extension alone is never trusted). */
function magicMatches(ext: string, data: Buffer): boolean {
  switch (ext) {
    case 'png':
      return startsWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    case 'jpg':
    case 'jpeg':
      return startsWith(data, [0xff, 0xd8, 0xff])
    case 'gif':
      return startsWith(data, ascii('GIF87a')) || startsWith(data, ascii('GIF89a'))
    case 'webp':
      return startsWith(data, ascii('RIFF')) && startsWith(data, ascii('WEBP'), 8)
    case 'ico':
      return startsWith(data, [0x00, 0x00, 0x01, 0x00])
    case 'woff2':
      return startsWith(data, ascii('wOF2'))
    default:
      return false
  }
}

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * Checks one file: name, type (extension + content), size, and for HTML the
 * variables. Does not check the set (count, total, login page).
 */
export function checkTemplateFile(input: TemplateFileInput): CheckFileResult {
  const { name, data } = input
  const refuse = (refusal: TemplateRefusal): CheckFileResult => ({ ok: false, refusal })
  if (!TEMPLATE_FILE_NAME_REGEX.test(name)) {
    return refuse({
      status: 422,
      error: 'bad_file_name',
      message: `"${name}" is not an allowed file name (a-z, 0-9, ".", "_", "-"; no directories; at most 64 characters).`,
      detail: { file: name },
    })
  }
  const ext = extensionOf(name)
  const type = TYPES[ext]
  if (!type) {
    return refuse({
      status: 422,
      error: 'unsupported_type',
      message: `"${name}": only ${TEMPLATE_EXTENSIONS.join(', ')} files are accepted.`,
      detail: { file: name },
    })
  }
  const limit = ext === 'html' ? TEMPLATE_LIMITS.maxHtmlBytes : TEMPLATE_LIMITS.maxFileBytes
  if (data.length > limit) {
    return refuse({
      status: 413,
      error: 'template_too_large',
      message: `"${name}" is ${data.length} bytes; the limit is ${limit}.`,
      detail: { file: name, bytes: data.length, limit },
    })
  }
  const contentOk =
    type.kind === 'text'
      ? isUtf8Text(data) && (ext !== 'svg' || /<svg[\s>]/i.test(data.toString('utf8')))
      : magicMatches(ext, data)
  if (!contentOk) {
    return refuse({
      status: 422,
      error: 'unsupported_type',
      message: `"${name}" does not contain what its extension says (.${ext}).`,
      detail: { file: name },
    })
  }
  if (ext === 'html') {
    const unknown = unknownVariables(data.toString('utf8'))
    if (unknown.length) {
      const first = unknown[0]
      return refuse({
        status: 422,
        error: 'unknown_variable',
        message: `"${name}" line ${first.line}: {{${first.name}}} is not a portal variable.`,
        detail: { file: name, line: first.line, name: first.name, variables: TEMPLATE_VARIABLES },
      })
    }
  }
  return {
    ok: true,
    file: {
      name,
      contentType: type.contentType,
      bytes: data.length,
      sha256: sha256Hex(data),
      data,
    },
  }
}

/** `{{name}}` occurrences with a name outside `TEMPLATE_VARIABLES`, with their line. */
export function unknownVariables(text: string): Array<{ line: number; name: string }> {
  const out: Array<{ line: number; name: string }> = []
  for (const match of text.matchAll(VARIABLE_PATTERN)) {
    const name = match[1]
    if (VARIABLE_SET.has(name)) continue
    const line = text.slice(0, match.index).split('\n').length
    out.push({ line, name })
  }
  return out
}

/** Variables used by the HTML files of a set, sorted. */
export function usedVariables(files: ReadonlyArray<{ name: string; data: Buffer }>): string[] {
  const used = new Set<string>()
  for (const f of files) {
    if (extensionOf(f.name) !== 'html') continue
    for (const match of f.data.toString('utf8').matchAll(VARIABLE_PATTERN)) {
      if (VARIABLE_SET.has(match[1])) used.add(match[1])
    }
  }
  return [...used].sort()
}

/**
 * Checks a complete set (after an upload or a file replacement): count,
 * total size, and `login.html` present.
 */
export function checkTemplateSet(
  files: ReadonlyArray<{ name: string; bytes: number }>
): TemplateRefusal | null {
  if (files.length > TEMPLATE_LIMITS.maxFiles) {
    return {
      status: 422,
      error: 'too_many_files',
      message: `A template holds at most ${TEMPLATE_LIMITS.maxFiles} files.`,
      detail: { files: files.length, limit: TEMPLATE_LIMITS.maxFiles },
    }
  }
  const names = new Set<string>()
  for (const f of files) {
    if (names.has(f.name)) {
      return {
        status: 422,
        error: 'duplicate_file',
        message: `"${f.name}" appears twice.`,
        detail: { file: f.name },
      }
    }
    names.add(f.name)
  }
  const total = files.reduce((sum, f) => sum + f.bytes, 0)
  if (total > TEMPLATE_LIMITS.maxTotalBytes) {
    return {
      status: 413,
      error: 'template_too_large',
      message: `The template is ${total} bytes; the limit is ${TEMPLATE_LIMITS.maxTotalBytes}.`,
      detail: { bytes: total, limit: TEMPLATE_LIMITS.maxTotalBytes },
    }
  }
  if (!names.has(LOGIN_PAGE)) {
    return {
      status: 422,
      error: 'missing_login_page',
      message: 'A template needs a login.html.',
    }
  }
  return null
}

/**
 * Digest of a file set, what `portal.configure` / `portal.template` compare
 * with the router's copy: SHA-256 over `name "\n" sha256(content) "\n"` per
 * file, sorted by name (byte order). The empty set (the builtin template:
 * the collector's compiled-in pages) is SHA-256 of the empty string.
 */
export function templateSetSha256(files: ReadonlyArray<{ name: string; sha256: string }>): string {
  const sorted = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return sha256Hex(sorted.map((f) => `${f.name}\n${f.sha256}\n`).join(''))
}

export const EMPTY_SET_SHA256 = sha256Hex('')

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** JSON safe inside `<script type="application/json">`. */
export function scriptSafeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
}

/** Values of the plain variables (the snippets are rendered from `methods`). */
export type TemplateValues = {
  portal_name: string
  gateway_name: string
  client_mac: string
  client_ip: string
  origin_url: string
  message: string
  message_code: string
  assets: string
  remaining_time: string
  remaining_data: string
  expires_at: string
  privacy_notice: string
  methods: string
  status_json: unknown
}

/** Substitutes the variables of one HTML page. Unknown names render empty. */
export function renderTemplateHtml(
  html: string,
  values: TemplateValues,
  methods: { voucher: boolean; password: boolean }
): string {
  const snippets = portalSnippets(methods)
  return html.replace(VARIABLE_PATTERN, (_whole, name: string) => {
    if (RAW_VARIABLES.has(name)) return snippets[name as keyof typeof snippets]
    if (name === 'status_json') return scriptSafeJson(values.status_json)
    if (!VARIABLE_SET.has(name)) return ''
    return escapeHtml(String(values[name as keyof TemplateValues] ?? ''))
  })
}

/** An `origin_url` is only ever http(s); anything else renders empty. */
export function safeOriginUrl(url: string): string {
  return /^https?:\/\//i.test(url) ? url : ''
}

export type PreviewPage = 'login' | 'status'

/**
 * A self-contained preview of one page (docs/gateway/portal.md section 12.3):
 * sample values, and every `{{assets}}/<file>` reference replaced by a data
 * URI of that file, so the page renders inside `<iframe sandbox srcdoc>`
 * without any request to the controller. `status` falls back to the builtin
 * status page when the set has none.
 */
export function renderPreview(
  files: ReadonlyArray<{ name: string; contentType: string; data: Buffer }>,
  page: PreviewPage,
  sample: Omit<TemplateValues, 'assets' | 'message'> & { message_code: string },
  methods: { voucher: boolean; password: boolean }
): string {
  const byName = new Map(files.map((f) => [f.name, f]))
  const builtin = new Map(BUILTIN_TEMPLATE_FILES.map((f) => [f.name, f]))
  const pageName = page === 'login' ? LOGIN_PAGE : STATUS_PAGE
  // A custom set without status.html uses the builtin one with the builtin assets.
  const source = byName.get(pageName) ? byName : builtin
  const file = source.get(pageName)!
  const marker = `perch-assets-${sha256Hex(pageName).slice(0, 12)}`
  const message = sample.message_code ? (PORTAL_MESSAGES[sample.message_code] ?? '') : ''
  let html = renderTemplateHtml(
    file.data.toString('utf8'),
    { ...sample, message, assets: marker },
    methods
  )
  html = html.replace(new RegExp(`${marker}/([a-z0-9][a-z0-9._-]{0,63})`, 'g'), (_whole, name) => {
    const asset = source.get(name)
    if (!asset) return 'data:,'
    const type = asset.contentType.split(';')[0]
    return `data:${type};base64,${asset.data.toString('base64')}`
  })
  return html.replaceAll(marker, 'data:,')
}
