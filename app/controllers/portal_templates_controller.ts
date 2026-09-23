import { PortalError, idParam, templateNotFound } from '#services/portal_errors'
import {
  createTemplate,
  deleteTemplate,
  deleteTemplateFile,
  duplicateTemplate,
  listTemplates,
  previewTemplate,
  putTemplateFile,
  renameTemplate,
  showTemplate,
} from '#services/portal_templates_admin'
import { TEMPLATE_LIMITS, type TemplateFileInput } from '#services/portal/templates'
import {
  previewQueryValidator,
  templateFileNameRegex,
  templateNameValidator,
} from '#validators/portal'
import type { HttpContext } from '@adonisjs/core/http'
import type { MultipartFile } from '@adonisjs/core/bodyparser'
import { readFile } from 'node:fs/promises'

/**
 * Portal templates (docs/gateway/portal.md section 12), admin-only. Uploads
 * are multipart; file content is never served back as a document (the
 * preview is `{html}` JSON for `<iframe sandbox srcdoc>`).
 */
export default class PortalTemplatesController {
  /** GET /api/v1/portal/templates */
  async index() {
    return { data: await listTemplates() }
  }

  /** GET /api/v1/portal/templates/:id */
  async show({ params }: HttpContext) {
    return { data: await showTemplate(idParam(params.id, templateNotFound)) }
  }

  /** POST /api/v1/portal/templates (multipart: `name`, `files[]`) */
  async store({ auth, request, response }: HttpContext) {
    const { name } = await templateNameValidator.validate({ name: request.input('name') })
    const uploads = request.files('files')
    if (!uploads.length) {
      throw new PortalError(422, 'missing_login_page', 'Upload at least a login.html.')
    }
    if (uploads.length > TEMPLATE_LIMITS.maxFiles) {
      throw new PortalError(
        422,
        'too_many_files',
        `A template holds at most ${TEMPLATE_LIMITS.maxFiles} files.`
      )
    }
    const files: TemplateFileInput[] = []
    for (const upload of uploads) files.push(await readUpload(upload, upload.clientName))
    const template = await createTemplate(name, files, auth.user?.id ?? null)
    response.status(201)
    return { data: template }
  }

  /** POST /api/v1/portal/templates/:id/duplicate {name} */
  async duplicate({ auth, params, request, response }: HttpContext) {
    const id = idParam(params.id, templateNotFound)
    const { name } = await request.validateUsing(templateNameValidator)
    response.status(201)
    return { data: await duplicateTemplate(id, name, auth.user?.id ?? null) }
  }

  /** PATCH /api/v1/portal/templates/:id {name} */
  async update({ params, request }: HttpContext) {
    const id = idParam(params.id, templateNotFound)
    const { name } = await request.validateUsing(templateNameValidator)
    return { data: await renameTemplate(id, name) }
  }

  /** DELETE /api/v1/portal/templates/:id */
  async destroy({ params, response }: HttpContext) {
    await deleteTemplate(idParam(params.id, templateNotFound))
    return response.noContent()
  }

  /** PUT /api/v1/portal/templates/:id/files/:name (multipart: `file`) */
  async putFile({ params, request }: HttpContext) {
    const id = idParam(params.id, templateNotFound)
    const name = fileName(params.name)
    const upload = request.file('file')
    if (!upload)
      throw new PortalError(422, 'file_required', 'Send the file as multipart field `file`.')
    const { data } = await readUpload(upload, name)
    return { data: await putTemplateFile(id, name, data) }
  }

  /** DELETE /api/v1/portal/templates/:id/files/:name */
  async destroyFile({ params }: HttpContext) {
    const id = idParam(params.id, templateNotFound)
    return { data: await deleteTemplateFile(id, fileName(params.name)) }
  }

  /** GET /api/v1/portal/templates/:id/preview?page=login|status&message=<code>&portalId= */
  async preview({ params, request, response }: HttpContext) {
    const id = idParam(params.id, templateNotFound)
    const qs = await previewQueryValidator.validate(request.qs())
    response.header('Cache-Control', 'no-store')
    return {
      data: await previewTemplate(id, qs.page ?? 'login', qs.message ?? null, qs.portalId ?? null),
    }
  }
}

function fileName(value: unknown): string {
  const name = String(value ?? '')
  if (!templateFileNameRegex.test(name)) {
    throw new PortalError(422, 'bad_file_name', `"${name}" is not an allowed file name.`, {
      file: name,
    })
  }
  return name
}

async function readUpload(upload: MultipartFile, name: string): Promise<TemplateFileInput> {
  if (upload.size > TEMPLATE_LIMITS.maxFileBytes) {
    throw new PortalError(
      413,
      'template_too_large',
      `"${name}" is ${upload.size} bytes; the limit is ${TEMPLATE_LIMITS.maxFileBytes}.`,
      {
        file: name,
        bytes: upload.size,
        limit: TEMPLATE_LIMITS.maxFileBytes,
      }
    )
  }
  if (!upload.tmpPath) {
    throw new PortalError(422, 'file_required', `"${name}" was not received.`)
  }
  return { name, data: await readFile(upload.tmpPath) }
}
