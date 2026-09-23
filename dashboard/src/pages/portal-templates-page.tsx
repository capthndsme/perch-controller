import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Copy, FileArrowUp, FileHtml } from '@phosphor-icons/react'
import { PageHeader } from '@/components/layout/page-header'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { PageSpinner } from '@/components/ui/spinner'
import { TemplateNameDialog, TemplateUploadDialog } from '@/components/portal/template-dialogs'
import { AdminOnlyNotice, ErrorNote, PortalSectionNav } from '@/components/portal/portal-ui'
import { useIsPortalAdmin, usePortals, usePortalTemplates } from '@/hooks/use-portal'
import { formatBytes } from '@/lib/format-bytes'
import { formatDateTime } from '@/lib/portal'
import type { PortalTemplate } from '@/types/api'

/** `/portal/templates`: the sign-in page sets, built-in first. */
export function PortalTemplatesPage() {
  const { isAdmin, isPending } = useIsPortalAdmin()
  const templates = usePortalTemplates({ enabled: isAdmin })
  const portals = usePortals({ enabled: isAdmin })
  const [uploading, setUploading] = useState(false)
  const [duplicating, setDuplicating] = useState<PortalTemplate | null>(null)

  if (isPending) return <PageSpinner label="Loading templates" />

  return (
    <div className="flex w-full flex-col gap-5">
      <PageHeader
        title="Templates"
        crumbs={[{ label: 'Guest portal', to: '/portal' }, { label: 'Templates' }]}
        description="What guests see: the sign-in and status pages. Start from a copy of the built-in one."
        actions={
          isAdmin ? (
            <Button size="sm" onClick={() => setUploading(true)}>
              <FileArrowUp className="size-3.5" />
              Upload template
            </Button>
          ) : null
        }
      />
      <PortalSectionNav />
      {!isAdmin ? (
        <AdminOnlyNotice what="templates" />
      ) : (
        <>
          {templates.isPending ? <p className="text-xs text-muted-foreground">Loading templates…</p> : null}
          {templates.error ? <ErrorNote error={templates.error} /> : null}
          {templates.data && templates.data.length === 0 ? <EmptyState title="No templates" /> : null}
          <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
            {(templates.data ?? []).map((template) => {
              const users = template.inUse.map((id) => portals.data?.find((p) => p.id === id)?.name ?? `Portal ${id}`)
              return (
                <article key={template.id} className="card-surface flex flex-col gap-3 p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 space-y-0.5">
                      <Link to={`/portal/templates/${template.id}`} className="flex items-center gap-1.5 text-sm font-semibold hover:underline">
                        <FileHtml className="size-4 shrink-0 text-muted-foreground" />
                        <span className="truncate">{template.name}</span>
                      </Link>
                      <p className="text-[11px] text-muted-foreground">
                        {template.builtin
                          ? 'Compiled into the gateway’s collector'
                          : `${template.files.length} file${template.files.length === 1 ? '' : 's'} · ${formatBytes(template.totalBytes)} · ${formatDateTime(template.updatedAt)}`}
                      </p>
                    </div>
                    {template.builtin ? (
                      <Badge variant="outline" className="rounded-sm text-muted-foreground">
                        Built-in
                      </Badge>
                    ) : null}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {users.length ? `Used by ${users.join(', ')}` : 'Not used by any portal'}
                  </p>
                  <div className="mt-auto flex flex-wrap gap-1.5">
                    <Button asChild size="sm" variant="outline">
                      <Link to={`/portal/templates/${template.id}`}>{template.builtin ? 'Preview' : 'Open'}</Link>
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setDuplicating(template)}>
                      <Copy className="size-3.5" />
                      Duplicate
                    </Button>
                  </div>
                </article>
              )
            })}
          </div>
        </>
      )}
      {uploading ? <TemplateUploadDialog onClose={() => setUploading(false)} /> : null}
      {duplicating ? <TemplateNameDialog template={duplicating} mode="duplicate" onClose={() => setDuplicating(null)} /> : null}
    </div>
  )
}
