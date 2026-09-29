import { useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ArrowsClockwise, Copy, DeviceMobile, Desktop, FilePlus, PencilSimple, Trash } from '@phosphor-icons/react'
import { PageHeader } from '@/components/layout/page-header'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Panel } from '@/components/ui/panel'
import { Segmented } from '@/components/ui/segmented'
import { PageSpinner } from '@/components/ui/spinner'
import { TemplateIssues, TemplateNameDialog } from '@/components/portal/template-dialogs'
import { AdminOnlyNotice, ConfirmDialog, ErrorNote } from '@/components/portal/portal-ui'
import {
  useDeletePortalTemplate,
  useDeletePortalTemplateFile,
  useIsPortalAdmin,
  usePortals,
  usePortalTemplate,
  usePortalTemplatePreview,
  usePutPortalTemplateFile,
} from '@/hooks/use-portal'
import { useRetained } from '@/hooks/use-retained'
import { ApiError, apiErrorCode } from '@/lib/api'
import { formatBytes } from '@/lib/format-bytes'
import {
  PORTAL_MESSAGE_CODES,
  errorDetail,
  precheckTemplateFiles,
  selectClassName,
  templateIssueFromError,
  type TemplateIssue,
} from '@/lib/portal'
import { cn } from '@/lib/utils'
import type { PortalTemplate } from '@/types/api'

/** `/portal/templates/:id`: a template's files, and its preview in a sandboxed frame. */
export function PortalTemplatePage() {
  const params = useParams()
  const id = Number(params.id)
  const { isAdmin, isPending } = useIsPortalAdmin()
  const template = usePortalTemplate(isAdmin && Number.isInteger(id) && id > 0 ? id : null)
  const [naming, setNaming] = useState<'duplicate' | 'rename' | null>(null)
  const [deleting, setDeleting] = useState(false)

  if (isPending || (isAdmin && template.isPending)) return <PageSpinner label="Loading template" />
  if (!isAdmin) return <AdminOnlyNotice what="templates" />
  if (!template.data) {
    return (
      <div className="flex w-full flex-col gap-5">
        <PageHeader title="Template" crumbs={[{ label: 'Guest portal', to: '/portal' }, { label: 'Templates', to: '/portal/templates' }, { label: 'Template' }]} />
        {template.error instanceof ApiError && template.error.status === 404 ? (
          <p className="text-sm text-muted-foreground">This template does not exist (any more).</p>
        ) : (
          <ErrorNote error={template.error} />
        )}
      </div>
    )
  }
  const data = template.data

  return (
    <div className="flex w-full flex-col gap-5">
      <PageHeader
        title={data.name}
        crumbs={[{ label: 'Guest portal', to: '/portal' }, { label: 'Templates', to: '/portal/templates' }, { label: data.name }]}
        description={data.builtin ? 'The pages compiled into the gateway’s collector. Read-only: duplicate it to make your own.' : `${data.files.length} files · ${formatBytes(data.totalBytes)}`}
        actions={
          <>
            <Button size="sm" variant="outline" onClick={() => setNaming('duplicate')}>
              <Copy className="size-3.5" />
              Duplicate
            </Button>
            {!data.builtin ? (
              <>
                <Button size="sm" variant="outline" onClick={() => setNaming('rename')}>
                  <PencilSimple className="size-3.5" />
                  Rename
                </Button>
                <Button size="sm" variant="destructive" onClick={() => setDeleting(true)}>
                  <Trash className="size-3.5" />
                  Delete
                </Button>
              </>
            ) : null}
          </>
        }
      >
        <div className="flex flex-wrap gap-1.5">
          {data.builtin ? (
            <Badge variant="outline" className="rounded-sm text-muted-foreground">
              Built-in
            </Badge>
          ) : null}
          <Badge variant="outline" className="rounded-sm font-mono text-muted-foreground" title={data.sha256}>
            {data.sha256.slice(0, 12)}
          </Badge>
        </div>
      </PageHeader>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
        <div className="flex flex-col gap-5">
          {!data.builtin ? <TemplateFilesPanel template={data} /> : null}
          <Panel title="Variables used" description="Filled in by the gateway for each guest.">
            {data.variables.length ? (
              <div className="flex flex-wrap gap-1">
                {data.variables.map((name) => (
                  <code key={name} className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[11px]">
                    {`{{${name}}}`}
                  </code>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">None.</p>
            )}
          </Panel>
        </div>
        <TemplatePreviewPanel template={data} />
      </div>

      {naming ? <TemplateNameDialog template={data} mode={naming} onClose={() => setNaming(null)} /> : null}
      {deleting ? <DeleteTemplateDialog template={data} onClose={() => setDeleting(false)} /> : null}
    </div>
  )
}

function TemplateFilesPanel({ template }: { template: PortalTemplate }) {
  const put = usePutPortalTemplateFile()
  const remove = useDeletePortalTemplateFile()
  const [issues, setIssues] = useState<TemplateIssue[]>([])
  const [confirmFile, setConfirmFile] = useState<string | null>(null)
  const shownConfirmFile = useRetained(confirmFile)
  const replaceInput = useRef<HTMLInputElement>(null)
  const addInput = useRef<HTMLInputElement>(null)
  const [replacing, setReplacing] = useState<string | null>(null)

  async function upload(name: string, file: File) {
    setIssues([])
    // The file is stored under `name`: check it under that name.
    const found = await precheckTemplateFiles([{ name, file }], { requireLogin: false })
    if (found.length) {
      setIssues(found)
      return
    }
    put.mutate({ id: template.id, name, file }, { onError: (error) => setIssues([templateIssueFromError(error)]) })
  }

  return (
    <Panel
      title="Files"
      description="Replacing a file sends the new set to every portal that uses it."
      updating={put.isPending || remove.isPending}
      actions={
        <Button size="sm" variant="outline" onClick={() => addInput.current?.click()}>
          <FilePlus className="size-3.5" />
          Add files
        </Button>
      }
    >
      <ul className="divide-y divide-border rounded-md border border-border">
        {template.files.map((file) => (
          <li key={file.name} className="flex items-center gap-2 px-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="truncate font-mono text-xs font-medium">{file.name}</p>
              <p className="text-[11px] text-muted-foreground">
                {file.contentType.split(';')[0]} · {formatBytes(file.bytes)}
              </p>
            </div>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={`Replace ${file.name}`}
              title="Replace"
              onClick={() => {
                setReplacing(file.name)
                replaceInput.current?.click()
              }}
            >
              <ArrowsClockwise className="size-3.5" />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              className="text-muted-foreground hover:text-destructive"
              aria-label={`Delete ${file.name}`}
              title={file.name === 'login.html' ? 'login.html is required' : 'Delete'}
              disabled={file.name === 'login.html'}
              onClick={() => {
                remove.reset()
                setConfirmFile(file.name)
              }}
            >
              <Trash className="size-3.5" />
            </Button>
          </li>
        ))}
      </ul>
      <input
        ref={replaceInput}
        type="file"
        className="sr-only"
        tabIndex={-1}
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file && replacing) void upload(replacing, file)
          e.target.value = ''
        }}
      />
      <input
        ref={addInput}
        type="file"
        multiple
        className="sr-only"
        tabIndex={-1}
        onChange={async (e) => {
          const files = [...(e.target.files ?? [])]
          e.target.value = ''
          const found = await precheckTemplateFiles(files.map((file) => ({ name: file.name, file })), { requireLogin: false })
          if (found.length) {
            setIssues(found)
            return
          }
          setIssues([])
          for (const file of files) {
            try {
              await put.mutateAsync({ id: template.id, name: file.name, file })
            } catch (error) {
              setIssues((current) => [...current, templateIssueFromError(error)])
              break
            }
          }
        }}
      />
      <TemplateIssues issues={issues} />
      <ConfirmDialog
        open={confirmFile !== null}
        onOpenChange={(open) => !open && setConfirmFile(null)}
        title={`Delete ${shownConfirmFile ?? ''}?`}
        confirmLabel="Delete file"
        destructive
        pending={remove.isPending}
        error={remove.error}
        onConfirm={() => {
          if (confirmFile) remove.mutate({ id: template.id, name: confirmFile }, { onSuccess: () => setConfirmFile(null) })
        }}
      />
    </Panel>
  )
}

type Frame = 'phone' | 'desktop'

/**
 * The preview comes as JSON and renders in `<iframe sandbox="allow-scripts
 * allow-forms" srcdoc>`: its scripts run in an opaque origin, never with the
 * dashboard's (no allow-same-origin, no top navigation, no popups;
 * portal.md §12.1).
 */
function TemplatePreviewPanel({ template }: { template: PortalTemplate }) {
  const portals = usePortals()
  const [page, setPage] = useState<'login' | 'status'>('login')
  const [message, setMessage] = useState('')
  const [portalId, setPortalId] = useState('')
  const [frame, setFrame] = useState<Frame>('phone')
  const preview = usePortalTemplatePreview(template.id, {
    page,
    message: message || undefined,
    portalId: portalId ? Number(portalId) : undefined,
  })

  return (
    <Panel
      title="Preview"
      description="With sample values, or a portal’s name, methods and privacy notice."
      updating={preview.isPlaceholderData}
      actions={
        <Segmented
          ariaLabel="Preview width"
          size="xs"
          value={frame}
          onChange={setFrame}
          options={[
            { id: 'phone', label: 'Phone' },
            { id: 'desktop', label: 'Desktop' },
          ]}
        />
      }
    >
      <div className="mb-3 grid gap-2 sm:grid-cols-3">
        <select aria-label="Page" className={selectClassName} value={page} onChange={(e) => setPage(e.target.value as 'login' | 'status')}>
          <option value="login">Sign-in page</option>
          <option value="status">Status page (signed in)</option>
        </select>
        <select aria-label="Message" className={selectClassName} value={message} onChange={(e) => setMessage(e.target.value)}>
          <option value="">No message</option>
          {PORTAL_MESSAGE_CODES.map((code) => (
            <option key={code} value={code}>
              {code.replaceAll('_', ' ')}
            </option>
          ))}
        </select>
        <select aria-label="Portal" className={selectClassName} value={portalId} onChange={(e) => setPortalId(e.target.value)}>
          <option value="">Sample portal</option>
          {(portals.data ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
      {preview.error ? <ErrorNote error={preview.error} /> : null}
      <div className="flex justify-center rounded-md border border-border bg-muted/40 p-3">
        {preview.data ? (
          <iframe
            title={`Preview of ${template.name}`}
            sandbox="allow-scripts allow-forms"
            referrerPolicy="no-referrer"
            srcDoc={preview.data.html}
            className={cn(
              'h-[36rem] rounded-md border border-border bg-white shadow-sm',
              frame === 'phone' ? 'w-[375px] max-w-full' : 'w-full',
            )}
          />
        ) : (
          <div className="flex h-[36rem] items-center text-xs text-muted-foreground">
            {preview.isPending ? 'Rendering…' : null}
          </div>
        )}
      </div>
      <p className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
        {frame === 'phone' ? <DeviceMobile className="size-3.5" /> : <Desktop className="size-3.5" />}
        Links and forms do nothing here; scripts run isolated from the dashboard.
      </p>
    </Panel>
  )
}

function DeleteTemplateDialog({ template, onClose }: { template: PortalTemplate; onClose: () => void }) {
  const navigate = useNavigate()
  const remove = useDeletePortalTemplate()
  const portals = usePortals()
  const inUse = apiErrorCode(remove.error) === 'template_in_use'
  const ids = errorDetail<number[]>(remove.error, 'portalIds') ?? template.inUse
  const names = ids.map((id) => portals.data?.find((p) => p.id === id)?.name ?? `Portal ${id}`)
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={`Delete ${template.name}?`}
      description={template.inUse.length ? `Used by ${names.join(', ')}: switch those portals to another template first.` : 'Its files go too.'}
      confirmLabel="Delete template"
      destructive
      pending={remove.isPending}
      error={inUse ? null : remove.error}
      onConfirm={() => remove.mutate(template.id, { onSuccess: () => { onClose(); navigate('/portal/templates') } })}
    >
      {inUse ? <p className="text-destructive">Still used by {names.join(', ')}.</p> : null}
    </ConfirmDialog>
  )
}
