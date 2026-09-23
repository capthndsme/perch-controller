import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { FileArrowUp, Warning } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { ErrorNote, FormField } from '@/components/portal/portal-ui'
import { useCreatePortalTemplate, useDuplicatePortalTemplate, useRenamePortalTemplate } from '@/hooks/use-portal'
import { formatBytes } from '@/lib/format-bytes'
import {
  TEMPLATE_EXTENSIONS,
  TEMPLATE_LIMITS,
  precheckTemplateFiles,
  templateIssueFromError,
  vineFieldErrors,
  type TemplateIssue,
} from '@/lib/portal'
import { cn } from '@/lib/utils'
import type { PortalTemplate } from '@/types/api'

/** Problems per file (and line), then those of the whole set. */
export function TemplateIssues({ issues }: { issues: TemplateIssue[] }) {
  if (issues.length === 0) return null
  return (
    <ul role="alert" className="space-y-1 rounded-md border border-destructive/30 bg-destructive/5 p-2.5 text-xs">
      {issues.map((issue, index) => (
        <li key={index} className="flex items-start gap-1.5">
          <Warning className="mt-0.5 size-3.5 shrink-0 text-destructive" />
          <span>
            {issue.file ? (
              <span className="font-mono font-medium">
                {issue.file}
                {issue.line ? `:${issue.line}` : ''}
              </span>
            ) : (
              <span className="font-medium">Template</span>
            )}
            <span className="text-muted-foreground"> — {issue.message}</span>
          </span>
        </li>
      ))}
    </ul>
  )
}

/** Upload a new template: a name and its files (login.html required). */
export function TemplateUploadDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate()
  const create = useCreatePortalTemplate()
  const [name, setName] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [issues, setIssues] = useState<TemplateIssue[]>([])
  const [checking, setChecking] = useState(false)
  const fieldErrors = vineFieldErrors(create.error)
  const serverIssue = create.error && !fieldErrors.name ? templateIssueFromError(create.error) : null

  async function choose(list: FileList | null) {
    const chosen = list ? [...list] : []
    setFiles(chosen)
    create.reset()
    setChecking(true)
    setIssues(await precheckTemplateFiles(chosen.map((file) => ({ name: file.name, file })), { requireLogin: true }))
    setChecking(false)
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault()
            create.mutate({ name: name.trim(), files }, { onSuccess: (template) => { onClose(); navigate(`/portal/templates/${template.id}`) } })
          }}
        >
          <DialogHeader>
            <DialogTitle>Upload a template</DialogTitle>
            <DialogDescription>
              The sign-in pages guests see. HTML may use portal variables like <code className="font-mono">{'{{portal_name}}'}</code>{' '}
              and <code className="font-mono">{'{{voucher_form}}'}</code>; images, styles and scripts go alongside.
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <FormField label="Name" htmlFor="tpl-name" error={fieldErrors.name}>
              <Input id="tpl-name" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} className="rounded-md" />
            </FormField>
            <FormField
              label="Files"
              htmlFor="tpl-files"
              hint={`login.html is required, status.html optional. ${TEMPLATE_EXTENSIONS.join(', ')}; up to ${TEMPLATE_LIMITS.maxFiles} files, ${formatBytes(TEMPLATE_LIMITS.maxTotalBytes, 0)} in total. No folders.`}
            >
              <label
                htmlFor="tpl-files"
                className="flex cursor-pointer flex-col items-center gap-1.5 rounded-md border border-dashed border-border px-3 py-5 text-center text-muted-foreground transition-colors hover:bg-muted/40"
              >
                <FileArrowUp className="size-5" />
                <span>{files.length ? `${files.length} file${files.length === 1 ? '' : 's'} chosen` : 'Choose files'}</span>
              </label>
              <input
                id="tpl-files"
                type="file"
                multiple
                className="sr-only"
                accept={TEMPLATE_EXTENSIONS.map((e) => `.${e}`).join(',')}
                onChange={(e) => void choose(e.target.files)}
              />
            </FormField>
            {files.length ? (
              <ul className="space-y-0.5 text-[11px]">
                {files.map((file) => {
                  const bad = issues.some((i) => i.file === file.name) || serverIssue?.file === file.name
                  return (
                    <li key={file.name} className={cn('flex justify-between gap-2 font-mono', bad && 'text-destructive')}>
                      <span className="truncate">{file.name}</span>
                      <span className="shrink-0 text-muted-foreground">{formatBytes(file.size)}</span>
                    </li>
                  )
                })}
              </ul>
            ) : null}
            <TemplateIssues issues={serverIssue ? [...issues, serverIssue] : issues} />
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending || checking || files.length === 0 || issues.length > 0}>
              {create.isPending ? 'Uploading…' : 'Upload'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** Name a copy (the built-in's files are copied from the compiled-in set) or rename. */
export function TemplateNameDialog({
  template,
  mode,
  onClose,
}: {
  template: PortalTemplate
  mode: 'duplicate' | 'rename'
  onClose: () => void
}) {
  const navigate = useNavigate()
  const duplicate = useDuplicatePortalTemplate()
  const rename = useRenamePortalTemplate()
  const mutation = mode === 'duplicate' ? duplicate : rename
  const [name, setName] = useState(mode === 'duplicate' ? `${template.name} (copy)` : template.name)
  const fieldErrors = vineFieldErrors(mutation.error)

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault()
            if (mode === 'duplicate') {
              duplicate.mutate({ id: template.id, name: name.trim() }, { onSuccess: (copy) => { onClose(); navigate(`/portal/templates/${copy.id}`) } })
            } else {
              rename.mutate({ id: template.id, name: name.trim() }, { onSuccess: onClose })
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>{mode === 'duplicate' ? `Duplicate ${template.name}` : `Rename ${template.name}`}</DialogTitle>
            {mode === 'duplicate' ? <DialogDescription>The copy is yours to edit; portals keep using the original until you switch them.</DialogDescription> : null}
          </DialogHeader>
          <DialogBody>
            <FormField label="Name" htmlFor="tpl-new-name" error={fieldErrors.name}>
              <Input id="tpl-new-name" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} className="rounded-md" />
            </FormField>
            <ErrorNote error={mutation.error && !fieldErrors.name ? mutation.error : null} />
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mode === 'duplicate' ? 'Duplicate' : 'Rename'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
