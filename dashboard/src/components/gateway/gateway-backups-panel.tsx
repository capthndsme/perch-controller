import { useState } from 'react'
import { CheckCircle, DownloadSimple } from '@phosphor-icons/react'
import { FormError } from '@/components/setup/form-field'
import { TableScroll } from '@/components/gateway/observation-bits'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Panel } from '@/components/ui/panel'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { downloadGatewayBackup, useCreateGatewayBackup, useGatewayBackups } from '@/hooks/use-gateway-observation'
import { formatLastSeen } from '@/lib/collectors'
import { backupErrorMessage, formatDateTime, formatFileSize } from '@/lib/gateway-observation'
import type { GatewayBackupSummary } from '@/types/api'

type GatewayBackupsPanelProps = {
  gatewayId: number
  /** The session announced `gateway.backup`; null while offline or polled. */
  canBackup: boolean | null
  online: boolean
}

/**
 * Router backups (admin): `sysupgrade -b` taken live on the router, stored
 * encrypted on the controller. Redacted by default (Wi-Fi keys, private keys
 * and passwords removed). Perch never restores one.
 */
export function GatewayBackupsPanel({ gatewayId, canBackup, online }: GatewayBackupsPanelProps) {
  const backups = useGatewayBackups(gatewayId)
  const create = useCreateGatewayBackup(gatewayId)
  const [note, setNote] = useState('')
  const [redact, setRedact] = useState(true)
  const [created, setCreated] = useState<GatewayBackupSummary | null>(null)
  const [downloadError, setDownloadError] = useState<string | null>(null)
  const [downloading, setDownloading] = useState<number | null>(null)

  const unavailable =
    canBackup === false
      ? 'This Gateway agent cannot take backups. Update perch-collector on the router to a release with the gateway observation channel.'
      : !online
        ? 'The Gateway agent is not connected: backups are taken live from the router.'
        : null

  async function onCreate(event: React.FormEvent) {
    event.preventDefault()
    setCreated(null)
    try {
      const backup = await create.mutateAsync({ note: note.trim() || undefined, redact })
      setCreated(backup)
      setNote('')
    } catch {
      // Shown from create.error below.
    }
  }

  async function onDownload(backup: GatewayBackupSummary) {
    setDownloadError(null)
    setDownloading(backup.id)
    try {
      await downloadGatewayBackup(gatewayId, backup)
    } catch (error) {
      setDownloadError(error instanceof Error ? error.message : 'Download failed.')
    } finally {
      setDownloading(null)
    }
  }

  return (
    <Panel
      title="Backups"
      description="The router's configuration (sysupgrade -b), stored encrypted on the controller. Admins only."
      flush
    >
      <form onSubmit={onCreate} className="space-y-3 px-4 pb-4">
        <div className="flex items-start justify-between gap-4 rounded-lg border bg-muted/20 px-3 py-2.5">
          <div className="space-y-1">
            <Label htmlFor="backup-redact" className="text-xs font-medium">
              Remove secrets (recommended)
            </Label>
            <p className="text-xs text-muted-foreground">
              A redacted backup leaves out Wi-Fi keys, private keys and passwords, so the copy on the
              controller holds nothing an attacker could log in with. Restoring it resets those secrets,
              so note them elsewhere. A full backup keeps them and needs the router's permission.
            </p>
          </div>
          <Switch id="backup-redact" checked={redact} onCheckedChange={setRedact} aria-label="Remove secrets" />
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-0 flex-1 space-y-1">
            <Label htmlFor="backup-note" className="text-xs font-medium">
              Note (optional)
            </Label>
            <Input
              id="backup-note"
              value={note}
              maxLength={200}
              placeholder="Before changing the guest network"
              onChange={(event) => setNote(event.target.value)}
              className="h-8 rounded-md"
            />
          </div>
          <Button type="submit" size="sm" disabled={create.isPending || unavailable !== null}>
            {create.isPending ? (
              <>
                <Spinner className="size-3.5" /> Taking backup…
              </>
            ) : (
              'Create backup'
            )}
          </Button>
        </div>
        {unavailable ? <p className="text-xs text-muted-foreground">{unavailable}</p> : null}
        {create.isPending ? (
          <p className="text-xs text-muted-foreground">The router builds the archive; this can take up to a minute.</p>
        ) : null}
        {create.error ? <FormError message={backupErrorMessage(create.error)} /> : null}
        {created ? (
          <Alert className="rounded-lg border-primary/20 bg-primary/5">
            <CheckCircle className="size-4 text-primary" />
            <AlertTitle>Backup stored</AlertTitle>
            <AlertDescription>
              {formatFileSize(created.size)}
              {created.redacted ? `, ${created.redactions.length} secrets removed` : ', secrets kept'}.
            </AlertDescription>
          </Alert>
        ) : null}
        {downloadError ? <FormError message={downloadError} /> : null}
      </form>

      <div className="border-t border-border/70">
        {backups.isPending ? (
          <p className="px-4 py-3 text-xs text-muted-foreground">Loading backups…</p>
        ) : backups.error ? (
          <p className="px-4 py-3 text-xs text-destructive">{backups.error.message}</p>
        ) : !backups.data || backups.data.length === 0 ? (
          <div className="px-4 py-4">
            <EmptyState title="No backups yet" />
          </div>
        ) : (
          <TableScroll>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Taken</th>
                  <th>Size</th>
                  <th>Secrets</th>
                  <th>Release</th>
                  <th>Note</th>
                  <th className="text-right">File</th>
                </tr>
              </thead>
              <tbody>
                {backups.data.map((backup) => (
                  <tr key={backup.id}>
                    <td className="whitespace-nowrap" title={formatDateTime(backup.createdAt)}>
                      {formatDateTime(backup.createdAt)}
                      <span className="block text-[11px] text-muted-foreground">{formatLastSeen(backup.createdAt)}</span>
                    </td>
                    <td className="whitespace-nowrap font-mono text-[12px]">{formatFileSize(backup.size)}</td>
                    <td>
                      {backup.redacted ? (
                        <details>
                          <summary className="cursor-pointer list-none">
                            <Badge variant="outline" className="rounded text-[10px]">
                              removed ({backup.redactions.length})
                            </Badge>
                          </summary>
                          <ul className="mt-1 space-y-0.5 font-mono text-[11px] text-muted-foreground">
                            {backup.redactions.map((r, index) => (
                              <li key={`${r.file}-${r.option ?? ''}-${index}`}>
                                {r.file}
                                {r.option ? ` · ${r.option}` : ''}
                                {r.removed ? ' (file left out)' : ''}
                              </li>
                            ))}
                          </ul>
                        </details>
                      ) : (
                        <Badge variant="outline" className="rounded border-status-warning/50 text-[10px] text-status-warning">
                          kept (full)
                        </Badge>
                      )}
                    </td>
                    <td className="max-w-[12rem] truncate" title={backup.release ?? undefined}>
                      {backup.release ?? '—'}
                    </td>
                    <td className="max-w-[14rem] truncate" title={backup.note ?? undefined}>
                      {backup.note ?? <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="text-right">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-7 px-2 text-xs"
                        title={`SHA-256 ${backup.sha256}`}
                        disabled={downloading === backup.id}
                        onClick={() => void onDownload(backup)}
                      >
                        {downloading === backup.id ? <Spinner className="size-3.5" /> : <DownloadSimple className="size-3.5" />}
                        Download
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
        <p className="border-t border-border/70 px-4 py-2.5 text-[11px] text-muted-foreground">
          Perch never restores a backup. To restore, upload the file in LuCI (System → Backup / Flash
          Firmware) or run <span className="font-mono">sysupgrade -r</span> on the router.
        </p>
      </div>
    </Panel>
  )
}
