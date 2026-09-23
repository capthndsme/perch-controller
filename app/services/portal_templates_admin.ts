import Portal from '#models/portal'
import PortalTemplate from '#models/portal_template'
import PortalTemplateFile from '#models/portal_template_file'
import { type PortalDelivery, sendPortalPushes } from '#services/portal_agent_sender'
import { PortalError, templateNotFound } from '#services/portal_errors'
import { findPortal } from '#services/portal_portals'
import { runInPortalQueue } from '#services/portal_queue'
import { BUILTIN_TEMPLATE_FILES, PORTAL_MESSAGES } from '#services/portal/builtin_template'
import {
  type CheckedTemplateFile,
  LOGIN_PAGE,
  type PreviewPage,
  type TemplateFileInput,
  checkTemplateFile,
  checkTemplateSet,
  renderPreview,
  sha256Hex,
  templateSetSha256,
  usedVariables,
} from '#services/portal/templates'
import { firstOf } from '#services/portal_params'
import db from '@adonisjs/lucid/services/db'

/**
 * Portal templates for the dashboard (docs/gateway/portal.md section 12):
 * stored file sets, admin-only. Uploads are checked file by file and as a
 * set; a builtin template is read-only (duplicate it to customize). Template
 * content is never served as a document by the controller: the preview is
 * JSON (`{html}`) for a sandboxed iframe.
 */

export type TemplateView = {
  id: number
  name: string
  builtin: boolean
  sha256: string
  totalBytes: number
  inUse: number[]
  files: Array<{ name: string; contentType: string; bytes: number; sha256: string }>
  variables: string[]
  createdAt: string | null
  updatedAt: string | null
}

type LoadedFile = { name: string; contentType: string; bytes: number; sha256: string; data: Buffer }

function builtinFiles(): LoadedFile[] {
  return BUILTIN_TEMPLATE_FILES.map((f) => ({
    name: f.name,
    contentType: f.contentType,
    bytes: f.data.length,
    sha256: sha256Hex(f.data),
    data: f.data,
  }))
}

/** A template's files with content (the builtin one's are compiled in). */
async function filesOf(template: PortalTemplate): Promise<LoadedFile[]> {
  if (template.builtin) return builtinFiles()
  const rows = await PortalTemplateFile.query().where('template_id', template.id).orderBy('name')
  return rows.map((r) => ({
    name: r.name,
    contentType: r.contentType,
    bytes: r.bytes,
    sha256: r.sha256,
    data: Buffer.isBuffer(r.content) ? r.content : Buffer.from(r.content ?? ''),
  }))
}

async function inUseBy(templateIds: number[]): Promise<Map<number, number[]>> {
  const map = new Map<number, number[]>()
  if (!templateIds.length) return map
  const portals = await Portal.query()
    .whereIn('template_id', templateIds)
    .whereNull('deleted_at')
    .select(['id', 'template_id'])
    .orderBy('id')
  for (const p of portals) map.set(p.templateId!, [...(map.get(p.templateId!) ?? []), p.id])
  return map
}

async function views(templates: PortalTemplate[]): Promise<TemplateView[]> {
  const used = await inUseBy(templates.map((t) => t.id))
  const out: TemplateView[] = []
  for (const t of templates) {
    const files = await filesOf(t)
    out.push({
      id: t.id,
      name: t.name,
      builtin: Boolean(t.builtin),
      sha256: t.sha256,
      totalBytes: t.builtin ? files.reduce((s, f) => s + f.bytes, 0) : t.totalBytes,
      inUse: used.get(t.id) ?? [],
      files: files.map((f) => ({
        name: f.name,
        contentType: f.contentType,
        bytes: f.bytes,
        sha256: f.sha256,
      })),
      variables: usedVariables(files),
      createdAt: t.createdAt?.toUTC().toISO() ?? null,
      updatedAt: t.updatedAt?.toUTC().toISO() ?? null,
    })
  }
  return out
}

export async function listTemplates(): Promise<TemplateView[]> {
  return views(await PortalTemplate.query().orderBy('builtin', 'desc').orderBy('id'))
}

async function findTemplate(id: number): Promise<PortalTemplate> {
  const template = await PortalTemplate.find(id)
  if (!template) throw templateNotFound(id)
  return template
}

export async function showTemplate(id: number): Promise<TemplateView> {
  return await firstOf(views([await findTemplate(id)]))
}

function refuse(r: {
  status: number
  error: string
  message: string
  detail?: Record<string, unknown>
}): never {
  throw new PortalError(r.status, r.error, r.message, r.detail ?? {})
}

function checkFiles(inputs: TemplateFileInput[]): CheckedTemplateFile[] {
  const checked: CheckedTemplateFile[] = []
  for (const input of inputs) {
    const result = checkTemplateFile(input)
    if (!result.ok) refuse(result.refusal)
    checked.push(result.file)
  }
  return checked
}

function notBuiltin(template: PortalTemplate): void {
  if (template.builtin) {
    throw new PortalError(
      403,
      'builtin_template',
      'The builtin template is read-only; duplicate it to make changes.'
    )
  }
}

/** Writes a complete file set as a new template. */
async function insertTemplate(
  name: string,
  files: Array<{ name: string; contentType: string; bytes: number; sha256: string; data: Buffer }>,
  createdByUserId: number | null
): Promise<PortalTemplate> {
  const setRefusal = checkTemplateSet(files)
  if (setRefusal) refuse(setRefusal)
  return db.transaction(async (trx) => {
    const template = new PortalTemplate()
    template.fill({
      name,
      builtin: false,
      sha256: templateSetSha256(files),
      totalBytes: files.reduce((s, f) => s + f.bytes, 0),
      createdByUserId,
    })
    template.useTransaction(trx)
    await template.save()
    for (const f of files) {
      const row = new PortalTemplateFile()
      row.fill({
        templateId: template.id,
        name: f.name,
        contentType: f.contentType,
        bytes: f.bytes,
        sha256: f.sha256,
      })
      row.content = f.data
      row.useTransaction(trx)
      await row.save()
    }
    return template
  })
}

export async function createTemplate(
  name: string,
  inputs: TemplateFileInput[],
  createdByUserId: number | null
): Promise<TemplateView> {
  const template = await insertTemplate(name, checkFiles(inputs), createdByUserId)
  return await firstOf(views([template]))
}

export async function duplicateTemplate(
  id: number,
  name: string,
  createdByUserId: number | null
): Promise<TemplateView> {
  const source = await findTemplate(id)
  const template = await insertTemplate(name, await filesOf(source), createdByUserId)
  return await firstOf(views([template]))
}

/** Recomputes the set digest and size after a file change; resends it where used. */
async function afterFilesChanged(template: PortalTemplate): Promise<PortalDelivery> {
  const files = await PortalTemplateFile.query()
    .where('template_id', template.id)
    .select(['name', 'sha256', 'bytes'])
  template.sha256 = templateSetSha256(files)
  template.totalBytes = files.reduce((s, f) => s + f.bytes, 0)
  await template.save()
  return pushTemplate(template.id)
}

async function pushTemplate(templateId: number): Promise<PortalDelivery> {
  const portals = await Portal.query().where('template_id', templateId).whereNull('deleted_at')
  let delivery: PortalDelivery = 'applied'
  for (const p of portals) {
    const result = await runInPortalQueue(p.gatewayId, () =>
      sendPortalPushes(p.gatewayId, [{ kind: 'template', portalId: p.id }])
    )
    if (result === 'pending') delivery = 'pending'
  }
  return delivery
}

export async function putTemplateFile(
  id: number,
  name: string,
  data: Buffer
): Promise<TemplateView> {
  const template = await findTemplate(id)
  notBuiltin(template)
  const [file] = checkFiles([{ name, data }])
  const existing = await PortalTemplateFile.query()
    .where('template_id', id)
    .select(['id', 'name', 'bytes'])
  const next = existing
    .filter((f) => f.name !== name)
    .map((f) => ({ name: f.name, bytes: f.bytes }))
  next.push({ name: file.name, bytes: file.bytes })
  const setRefusal = checkTemplateSet(next)
  if (setRefusal) refuse(setRefusal)
  await db.transaction(async (trx) => {
    await trx.from('portal_template_files').where('template_id', id).where('name', name).delete()
    const row = new PortalTemplateFile()
    row.fill({
      templateId: id,
      name: file.name,
      contentType: file.contentType,
      bytes: file.bytes,
      sha256: file.sha256,
    })
    row.content = file.data
    row.useTransaction(trx)
    await row.save()
  })
  await afterFilesChanged(template)
  return await firstOf(views([template]))
}

export async function deleteTemplateFile(id: number, name: string): Promise<TemplateView> {
  const template = await findTemplate(id)
  notBuiltin(template)
  if (name === LOGIN_PAGE) {
    throw new PortalError(422, 'login_page_required', 'A template cannot lose its login.html.')
  }
  const deleted = await db
    .from('portal_template_files')
    .where('template_id', id)
    .where('name', name)
    .delete()
  if (!Number(Array.isArray(deleted) ? deleted[0] : deleted)) {
    throw new PortalError(404, 'template_file_not_found', `Template ${id} has no file "${name}".`)
  }
  await afterFilesChanged(template)
  return await firstOf(views([template]))
}

export async function renameTemplate(id: number, name: string): Promise<TemplateView> {
  const template = await findTemplate(id)
  notBuiltin(template)
  template.name = name
  await template.save()
  return await firstOf(views([template]))
}

export async function deleteTemplate(id: number): Promise<void> {
  const template = await findTemplate(id)
  notBuiltin(template)
  const usage = await inUseBy([id])
  const used = usage.get(id) ?? []
  if (used.length) {
    throw new PortalError(409, 'template_in_use', `Portals ${used.join(', ')} use this template.`, {
      portalIds: used,
    })
  }
  await template.delete()
}

/**
 * `GET /portal/templates/:id/preview`: one page, self-contained, with sample
 * values (or a portal's name, methods and privacy notice with `portalId`).
 */
export async function previewTemplate(
  id: number,
  page: PreviewPage,
  messageCode: string | null,
  portalId: number | null
): Promise<{ html: string; page: PreviewPage; messageCode: string | null }> {
  const template = await findTemplate(id)
  const portal = portalId === null ? null : await findPortal(portalId)
  const code = messageCode && PORTAL_MESSAGES[messageCode] !== undefined ? messageCode : ''
  const methods = portal
    ? { voucher: Boolean(portal.methods?.voucher), password: Boolean(portal.methods?.password) }
    : { voucher: true, password: true }
  const expires = new Date(Date.now() + 90 * 60_000).toISOString()
  const html = renderPreview(
    await filesOf(template),
    page,
    {
      portal_name: portal?.name ?? 'Guest Wi-Fi',
      gateway_name: 'Perch',
      client_mac: '02:00:00:00:00:01',
      client_ip: '192.168.20.23',
      origin_url: 'http://example.com/',
      message_code: code,
      remaining_time: page === 'status' ? '1 h 30 min' : '',
      remaining_data: page === 'status' ? '1.5 GB' : '',
      expires_at: page === 'status' ? expires : '',
      privacy_notice: portal?.privacyNotice ?? '',
      methods: Object.entries(methods)
        .filter(([, on]) => on)
        .map(([m]) => m)
        .join(' '),
      status_json: {
        state: page === 'status' ? 'authorized' : 'preauth',
        mac: '02:00:00:00:00:01',
        methods,
        grant:
          page === 'status'
            ? { secondsRemaining: 5400, bytesRemaining: 1_500_000_000, expiresAt: expires }
            : null,
      },
    },
    methods
  )
  return { html, page, messageCode: code || null }
}
