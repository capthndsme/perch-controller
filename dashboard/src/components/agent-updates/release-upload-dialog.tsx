import { useRef, useState, type RefObject } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { CheckCircle, FileArrowUp, Signature, WarningCircle, XCircle } from '@phosphor-icons/react'
import { ProgressBar } from '@/components/agent-updates/job-state'
import { ChannelBadge } from '@/components/agent-updates/version-badge'
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
import { Spinner } from '@/components/ui/spinner'
import { agentUpdatesQueryKey, base64OfFile, createRelease, uploadArtefact } from '@/hooks/use-agent-updates'
import { formatBytes } from '@/lib/format-bytes'
import { refusalMessage } from '@/lib/agent-updates'
import { cn } from '@/lib/utils'
import type { AgentRelease, Channel } from '@/types/agent-updates'

/** What the page reads from a manifest before sending it (the server validates it in full). */
type ManifestPreview = {
  product: string
  version: string
  channel: Channel
  artefacts: { file: string; kind: string; size: number }[]
}

type FileState =
  | { state: 'waiting' }
  | { state: 'uploading'; sent: number; total: number }
  | { state: 'stored' }
  | { state: 'already' }
  | { state: 'error'; message: string }

function readManifest(text: string): ManifestPreview | string {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return 'This is not JSON.'
  }
  const m = parsed as Partial<ManifestPreview> & { schema?: unknown }
  if (m.schema !== 'perch-release/1') return 'This is not a Perch release manifest (schema perch-release/1).'
  if (typeof m.product !== 'string' || typeof m.version !== 'string' || !Array.isArray(m.artefacts)) {
    return 'The manifest has no product, version or files.'
  }
  const channel: Channel = m.channel === 'stable' || m.channel === 'pre' ? m.channel : 'local'
  return { product: m.product, version: m.version, channel, artefacts: m.artefacts }
}

/**
 * A local build onto this controller: its signed manifest, the signature and
 * the files. The manifest goes first (the server checks the signature), then
 * every chosen file, one request each with its own progress bar; the server
 * checks each against the manifest's size and hash. Sending the same manifest
 * again only adds the files still missing.
 */
export function ReleaseUploadDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const abort = useRef<AbortController | null>(null)
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) abort.current?.abort()
        onOpenChange(next)
      }}
    >
      <DialogContent wide>
        <UploadForm abortRef={abort} onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  )
}

function UploadForm({ abortRef, onClose }: { abortRef: RefObject<AbortController | null>; onClose: () => void }) {
  const queryClient = useQueryClient()
  const input = useRef<HTMLInputElement>(null)
  // Every file picked or dropped so far, by name (a later pick of the same name wins).
  const [picked, setPicked] = useState<Map<string, File>>(() => new Map())
  const [parsed, setParsed] = useState<{ file: File; result: ManifestPreview | string } | null>(null)
  const [dragging, setDragging] = useState(false)
  const [phase, setPhase] = useState<'pick' | 'sending' | 'done'>('pick')
  const [release, setRelease] = useState<AgentRelease | null>(null)
  const [progress, setProgress] = useState<Record<string, FileState>>({})
  const [error, setError] = useState<string | null>(null)

  const all = [...picked.values()]
  const manifestFile = all.findLast((f) => f.name.endsWith('.json')) ?? null
  const signature = all.findLast((f) => f.name.endsWith('.sig')) ?? null
  const files = new Map(all.filter((f) => !f.name.endsWith('.json') && !f.name.endsWith('.sig')).map((f) => [f.name, f]))
  const manifest = parsed && parsed.file === manifestFile ? parsed.result : null
  const preview = typeof manifest === 'object' ? manifest : null
  const extra = preview ? [...files.keys()].filter((name) => !preview.artefacts.some((a) => a.file === name)) : []

  /** Adds files (several picks and drops add up); a new manifest is read once. */
  function take(list: FileList | File[]) {
    const incoming = Array.from(list)
    setError(null)
    setPicked((current) => {
      const next = new Map(current)
      for (const f of incoming) {
        next.delete(f.name)
        next.set(f.name, f)
      }
      return next
    })
    const json = incoming.findLast((f) => f.name.endsWith('.json'))
    if (json) {
      json.text().then(
        (text) => setParsed({ file: json, result: readManifest(text) }),
        (e: unknown) => setParsed({ file: json, result: `Could not read it (${e instanceof Error ? e.message : String(e)}).` }),
      )
    }
  }

  const rows = (preview?.artefacts ?? []).map((a) => {
    const file = files.get(a.file) ?? null
    const sizeOk = file ? file.size === a.size : null
    return { ...a, file: a.file, chosen: file, sizeOk }
  })
  const sendable = rows.filter((r) => r.chosen && r.sizeOk)
  const ready = preview !== null && signature !== null && phase === 'pick'

  async function send() {
    if (!preview || !manifestFile || !signature) return
    setPhase('sending')
    setError(null)
    const controller = new AbortController()
    abortRef.current = controller
    try {
      const created = await createRelease(await base64OfFile(manifestFile), await signature.text())
      setRelease(created)
      const stored = new Set(created.artefacts.filter((a) => a.stored).map((a) => a.file))
      const initial: Record<string, FileState> = {}
      for (const r of sendable) initial[r.file] = stored.has(r.file) ? { state: 'already' } : { state: 'waiting' }
      setProgress(initial)
      for (const r of sendable) {
        if (controller.signal.aborted) break
        if (stored.has(r.file)) continue
        const file = r.chosen!
        setProgress((p) => ({ ...p, [r.file]: { state: 'uploading', sent: 0, total: file.size } }))
        try {
          await uploadArtefact(
            created.id,
            file,
            (sent, total) => setProgress((p) => ({ ...p, [r.file]: { state: 'uploading', sent, total } })),
            controller.signal,
          )
          setProgress((p) => ({ ...p, [r.file]: { state: 'stored' } }))
        } catch (e) {
          setProgress((p) => ({ ...p, [r.file]: { state: 'error', message: refusalMessage(e) } }))
        }
      }
      setPhase('done')
    } catch (e) {
      setError(refusalMessage(e))
      setPhase('pick')
    } finally {
      abortRef.current = null
      void queryClient.invalidateQueries({ queryKey: agentUpdatesQueryKey })
    }
  }

  const states = Object.values(progress)
  const storedNow = states.filter((s) => s.state === 'stored' || s.state === 'already').length
  const failed = states.filter((s) => s.state === 'error').length

  return (
    <>
      <DialogHeader>
        <DialogTitle>Upload a local build</DialogTitle>
        <DialogDescription>
          Pick the release’s <span className="font-mono">perch-manifest.json</span>, its <span className="font-mono">.sig</span>{' '}
          and the files devices need. Only builds signed with a key this controller trusts are accepted.
        </DialogDescription>
      </DialogHeader>
      <DialogBody>
        {phase === 'pick' ? (
          <div
            onDragOver={(event) => {
              event.preventDefault()
              setDragging(true)
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault()
              setDragging(false)
              take(event.dataTransfer.files)
            }}
            className={cn(
              'flex flex-col items-center gap-2 rounded-md border border-dashed px-4 py-5 text-center transition-colors duration-base',
              dragging ? 'border-brand bg-brand/5' : 'border-border',
            )}
          >
            <FileArrowUp className="size-6 text-muted-foreground" />
            <p>Drop the files here, or</p>
            <Button type="button" size="sm" variant="outline" onClick={() => input.current?.click()}>
              Choose files
            </Button>
            <input
              ref={input}
              type="file"
              multiple
              className="sr-only"
              tabIndex={-1}
              // The value is left alone: clearing it aborts reading the files just picked (Firefox).
              onChange={(event) => {
                if (event.target.files) take(event.target.files)
              }}
            />
          </div>
        ) : null}

        <ul className="space-y-1.5">
          <li className="flex items-center gap-2">
            {preview ? (
              <CheckCircle weight="fill" className="size-4 shrink-0 text-status-good" />
            ) : typeof manifest === 'string' ? (
              <XCircle weight="fill" className="size-4 shrink-0 text-status-critical" />
            ) : (
              <span aria-hidden className="size-4 shrink-0 rounded-full border border-muted-foreground/50" />
            )}
            <span className="min-w-0 flex-1">
              {preview ? (
                <span className="flex flex-wrap items-center gap-1.5">
                  <span className="font-medium">
                    {preview.product} <span className="font-mono">{preview.version}</span>
                  </span>
                  <ChannelBadge channel={preview.channel} />
                  <span className="text-muted-foreground">{preview.artefacts.length} files listed</span>
                </span>
              ) : typeof manifest === 'string' ? (
                <span className="text-status-critical">
                  {manifestFile?.name}: {manifest}
                </span>
              ) : (
                <span className="text-muted-foreground">Manifest (perch-manifest.json)</span>
              )}
            </span>
          </li>
          <li className="flex items-center gap-2">
            {signature ? (
              <CheckCircle weight="fill" className="size-4 shrink-0 text-status-good" />
            ) : (
              <span aria-hidden className="size-4 shrink-0 rounded-full border border-muted-foreground/50" />
            )}
            <span className={cn('flex items-center gap-1.5', !signature && 'text-muted-foreground')}>
              <Signature className="size-3.5" />
              {signature ? <span className="font-mono">{signature.name}</span> : 'Signature (perch-manifest.json.sig)'}
            </span>
          </li>
        </ul>

        {preview ? (
          <section className="space-y-2">
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="section-label">Files</h3>
              <span className="text-[11px] text-muted-foreground tabular-nums">
                {phase === 'pick' ? `${sendable.length} of ${rows.length} chosen` : `${storedNow} of ${sendable.length} stored`}
              </span>
            </div>
            <ul className="divide-y divide-border/70 rounded-md border border-border">
              {rows.map((r) => {
                const p = progress[r.file]
                return (
                  <li key={r.file} className="space-y-1 px-2.5 py-2">
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate font-mono text-[11px]" title={r.file}>
                        {r.file}
                      </span>
                      <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">{formatBytes(r.size)}</span>
                      <FileBadge chosen={r.chosen !== null} sizeOk={r.sizeOk} state={p} />
                    </div>
                    {p?.state === 'uploading' ? (
                      <ProgressBar fraction={p.total > 0 ? p.sent / p.total : null} label={`Uploading ${r.file}`} />
                    ) : null}
                    {p?.state === 'error' ? <p className="text-[11px] text-status-critical">{p.message}</p> : null}
                    {r.chosen && r.sizeOk === false && phase === 'pick' ? (
                      <p className="text-[11px] text-status-critical">
                        {formatBytes(r.chosen.size)} here, {formatBytes(r.size)} in the manifest: not this build’s file.
                      </p>
                    ) : null}
                  </li>
                )
              })}
            </ul>
            {extra.length > 0 ? (
              <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
                <WarningCircle className="mt-px size-3.5 shrink-0 text-status-warning" />
                Not in the manifest, so not sent: {extra.join(', ')}
              </p>
            ) : null}
            {phase === 'pick' && sendable.length < rows.length ? (
              <p className="text-[11px] text-muted-foreground">
                Files you leave out stay missing; devices that need them cannot take this release until you upload them
                (the same manifest again adds only what is missing).
              </p>
            ) : null}
          </section>
        ) : null}

        {error ? (
          <p className="rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-destructive">{error}</p>
        ) : null}

        {phase === 'done' && release ? (
          <p
            className={cn(
              'rounded-md border px-2.5 py-2',
              failed > 0 ? 'border-status-warning/40 bg-status-warning/10' : 'border-status-good/40 bg-status-good/10',
            )}
          >
            {release.product} {release.version} is on this controller with {storedNow} of {rows.length} files stored
            {failed > 0 ? `; ${failed} failed (see above)` : ''}.
          </p>
        ) : null}
      </DialogBody>
      <DialogFooter>
        {phase === 'done' ? (
          <Button type="button" onClick={onClose}>
            Done
          </Button>
        ) : (
          <Button type="button" onClick={send} disabled={!ready}>
            {phase === 'sending' ? <Spinner className="size-3.5 text-current" /> : null}
            {phase === 'sending'
              ? 'Uploading…'
              : `Upload${preview ? ` ${preview.version}` : ''}${sendable.length ? ` with ${sendable.length} file${sendable.length === 1 ? '' : 's'}` : ''}`}
          </Button>
        )}
      </DialogFooter>
    </>
  )
}

function FileBadge({ chosen, sizeOk, state }: { chosen: boolean; sizeOk: boolean | null; state: FileState | undefined }) {
  const base = 'w-20 shrink-0 text-right text-[11px]'
  if (state?.state === 'stored') {
    return (
      <span className={cn(base, 'inline-flex items-center justify-end gap-1 text-status-good')}>
        <CheckCircle
          weight="fill"
          className="size-3.5 transition-[scale,opacity] duration-base ease-out starting:opacity-0 motion-safe:starting:scale-90"
        />
        Verified
      </span>
    )
  }
  if (state?.state === 'already') return <span className={cn(base, 'text-status-good')}>Already stored</span>
  if (state?.state === 'error') return <span className={cn(base, 'text-status-critical')}>Refused</span>
  if (state?.state === 'uploading') {
    return (
      <span className={cn(base, 'text-brand tabular-nums')}>
        {state.total > 0 ? `${Math.floor((state.sent / state.total) * 100)} %` : '…'}
      </span>
    )
  }
  if (state?.state === 'waiting') return <span className={cn(base, 'text-muted-foreground')}>Waiting</span>
  if (!chosen) return <span className={cn(base, 'text-muted-foreground')}>Not chosen</span>
  if (sizeOk === false) return <span className={cn(base, 'text-status-critical')}>Wrong size</span>
  return <span className={cn(base, 'text-foreground')}>Ready</span>
}
