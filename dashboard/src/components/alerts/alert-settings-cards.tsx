import { useId, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { CheckCircle, Key, Moon, PaperPlaneTilt } from '@phosphor-icons/react'
import { NumberField } from '@/components/alerts/number-field'
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
import { Panel } from '@/components/ui/panel'
import { Segmented } from '@/components/ui/segmented'
import { Switch } from '@/components/ui/switch'
import { useRotateVapidKeys, useSendTestAlert, useUpdateAlertSettings } from '@/hooks/use-alert-settings'
import { fieldErrorsFromApi } from '@/lib/api'
import { intProblem, originProblem, settingLimits, vapidSubjectProblem } from '@/lib/alert-settings'
import { formatAgo, formatWhen } from '@/lib/alerts'
import type { AlertSettingsPatch, AlertSettingsView, Severity } from '@/types/alerts'

function Saved({ show }: { show: boolean }) {
  return show ? (
    <span role="status" className="flex items-center gap-1 text-xs text-muted-foreground">
      <CheckCircle weight="fill" className="size-3.5 text-status-good" />
      Saved
    </span>
  ) : null
}

function Toggle({ id, label, hint, checked, onChange }: { id: string; label: string; hint?: ReactNode; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <label htmlFor={id} className="flex items-start justify-between gap-4">
      <span className="space-y-0.5">
        <span className="block text-xs font-medium">{label}</span>
        {hint ? <span className="block text-xs text-muted-foreground">{hint}</span> : null}
      </span>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </label>
  )
}

// ── Quiet hours ──────────────────────────────────────────────────────────

/** Quiet hours (design delivery.md §4): held messages arrive as one digest when the window ends. */
export function QuietHoursCard({ view }: { view: AlertSettingsView }) {
  const update = useUpdateAlertSettings()
  const id = useId()
  const initial = view.settings.quietHours
  const [enabled, setEnabled] = useState(initial.enabled)
  const [start, setStart] = useState(initial.start)
  const [end, setEnd] = useState(initial.end)
  const [breakThrough, setBreakThrough] = useState(initial.breakThrough)
  const [saved, setSaved] = useState(false)
  const dirty =
    enabled !== initial.enabled || start !== initial.start || end !== initial.end || breakThrough !== initial.breakThrough
  const valid = /^\d{2}:\d{2}$/.test(start) && /^\d{2}:\d{2}$/.test(end) && start !== end

  return (
    <Panel
      title="Quiet hours"
      description={`Hold notifications at night; they arrive as one summary when quiet hours end. Times in ${view.timezone}.`}
      actions={<Saved show={saved && !dirty} />}
    >
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault()
          setSaved(false)
          update.mutate({ quietHours: { enabled, start, end, breakThrough } }, { onSuccess: () => setSaved(true) })
        }}
      >
        <Toggle id={`${id}-on`} label="Quiet hours" checked={enabled} onChange={setEnabled} />
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <label htmlFor={`${id}-start`} className="text-xs font-medium">
              From
            </label>
            <Input id={`${id}-start`} type="time" value={start} onChange={(e) => setStart(e.target.value)} className="h-9 w-32 rounded-md" />
          </div>
          <div className="space-y-1.5">
            <label htmlFor={`${id}-end`} className="text-xs font-medium">
              Until
            </label>
            <Input id={`${id}-end`} type="time" value={end} onChange={(e) => setEnd(e.target.value)} className="h-9 w-32 rounded-md" />
          </div>
          {valid && end < start ? <p className="pb-2 text-xs text-muted-foreground">until the next morning</p> : null}
        </div>
        <div className="space-y-1.5">
          <p className="text-xs font-medium">During quiet hours</p>
          <Segmented
            size="xs"
            ariaLabel="What breaks through quiet hours"
            value={breakThrough}
            onChange={setBreakThrough}
            options={[
              { id: 'critical', label: 'Critical still comes through' },
              { id: 'none', label: 'Hold everything' },
            ]}
            className="w-fit flex-wrap"
          />
          <p className="text-xs text-muted-foreground">
            Each device and webhook can ignore quiet hours in its own filter. The inbox always shows everything at once.
          </p>
        </div>
        {!valid ? <p className="text-xs text-destructive">Start and end must be two different times.</p> : null}
        {update.error ? <p className="text-xs text-destructive">{update.error.message}</p> : null}
        <div className="flex justify-end">
          <Button type="submit" disabled={!dirty || !valid || update.isPending}>
            {update.isPending ? 'Saving…' : 'Save quiet hours'}
          </Button>
        </div>
      </form>
    </Panel>
  )
}

// ── Test alert ───────────────────────────────────────────────────────────

/** A test alert through the whole pipeline (rules, filters, quiet hours), unlike per-destination tests. */
export function TestAlertCard({ deliveryEnabled }: { deliveryEnabled: boolean }) {
  const send = useSendTestAlert()
  const [severity, setSeverity] = useState<Severity>('warning')
  return (
    <Panel
      title="Try it"
      description="Sends a test alert through the rules, filters and quiet hours, like a real one, to every device and webhook that takes it."
    >
      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          size="xs"
          ariaLabel="Test severity"
          value={severity}
          onChange={setSeverity}
          options={[
            { id: 'info', label: 'Info' },
            { id: 'warning', label: 'Warning' },
            { id: 'critical', label: 'Critical' },
          ]}
        />
        <Button onClick={() => send.mutate({ severity })} disabled={send.isPending}>
          <PaperPlaneTilt />
          {send.isPending ? 'Sending…' : 'Send a test alert'}
        </Button>
      </div>
      {send.data ? (
        <p className="mt-3 text-xs">
          Test alert raised.{' '}
          <Link to={`/alerts/${send.data.alertId}`} className="underline underline-offset-2">
            See who it went to
          </Link>
          {deliveryEnabled ? '' : ' (nothing leaves this controller while sending is switched off).'}
        </p>
      ) : null}
      {send.error ? <p className="mt-3 text-xs text-destructive">{send.error.message}</p> : null}
    </Panel>
  )
}

// ── General and advanced ─────────────────────────────────────────────────

type GeneralForm = {
  dashboardUrl: string
  heartbeatUrl: string
  heartbeatInterval: string
  bootGraceSeconds: string
  massEnabled: boolean
  fractionPercent: string
  minAgents: string
  rateMax: string
  rateWindow: string
  ttlCritical: string
  ttlWarning: string
  ttlInfo: string
  webhookRetryHours: string
  eventDays: string
  alertDays: string
  deliveryDays: string
  vapidSubject: string
  allowAnyPushService: boolean
}

function toGeneralForm(view: AlertSettingsView): GeneralForm {
  const s = view.settings
  return {
    dashboardUrl: s.dashboardUrl ?? '',
    heartbeatUrl: '',
    heartbeatInterval: String(s.heartbeat.intervalSeconds),
    bootGraceSeconds: String(s.bootGraceSeconds),
    massEnabled: s.massOffline.enabled,
    fractionPercent: String(s.massOffline.fractionPercent),
    minAgents: String(s.massOffline.minAgents),
    rateMax: String(s.destinationRateLimit.max),
    rateWindow: String(s.destinationRateLimit.windowMinutes),
    ttlCritical: String(s.pushTtlMinutes.critical),
    ttlWarning: String(s.pushTtlMinutes.warning),
    ttlInfo: String(s.pushTtlMinutes.info),
    webhookRetryHours: String(s.webhookRetryHours),
    eventDays: String(s.retention.eventDays),
    alertDays: String(s.retention.alertDays),
    deliveryDays: String(s.retention.deliveryDays),
    vapidSubject: s.vapidSubject ?? '',
    allowAnyPushService: s.allowAnyPushService,
  }
}

/**
 * Links, heartbeat and the rarely touched knobs (design README §2.6). One Save sends what changed; every
 * number is checked against the controller's limits first.
 */
export function GeneralSettingsCard({ view }: { view: AlertSettingsView }) {
  const update = useUpdateAlertSettings()
  const id = useId()
  const limits = settingLimits(view.limits)
  const initial = toGeneralForm(view)
  const [form, setForm] = useState<GeneralForm>(initial)
  const [clearHeartbeat, setClearHeartbeat] = useState(false)
  const [saved, setSaved] = useState(false)
  const set = <K extends keyof GeneralForm>(key: K, value: GeneralForm[K]) => {
    setSaved(false)
    setForm((f) => ({ ...f, [key]: value }))
  }
  const serverErrors = fieldErrorsFromApi(update.error)
  const s = view.settings

  const numberProblems: Array<[string, string | null]> = [
    ['Heartbeat interval', intProblem(form.heartbeatInterval, limits.heartbeatSeconds)],
    ['Boot grace', intProblem(form.bootGraceSeconds, limits.bootGraceSeconds)],
    ['Mass-offline share', intProblem(form.fractionPercent, limits.fractionPercent)],
    ['Mass-offline minimum', intProblem(form.minAgents, limits.minAgents)],
    ['Rate limit', intProblem(form.rateMax, limits.rateMax)],
    ['Rate window', intProblem(form.rateWindow, limits.rateWindowMinutes)],
    ['Critical push lifetime', intProblem(form.ttlCritical, limits.pushTtl.critical)],
    ['Warning push lifetime', intProblem(form.ttlWarning, limits.pushTtl.warning)],
    ['Info push lifetime', intProblem(form.ttlInfo, limits.pushTtl.info)],
    ['Webhook retries', intProblem(form.webhookRetryHours, limits.webhookRetryHours)],
    ['Event history', intProblem(form.eventDays, limits.eventDays)],
    ['Alert history', intProblem(form.alertDays, limits.alertDays)],
    ['Delivery history', intProblem(form.deliveryDays, limits.deliveryDays)],
  ]
  const dashboardProblem = form.dashboardUrl.trim() ? originProblem(form.dashboardUrl.trim()) : null
  const subjectProblem = form.vapidSubject.trim() ? vapidSubjectProblem(form.vapidSubject.trim()) : null
  const heartbeatProblem = form.heartbeatUrl.trim() && !/^https?:\/\/\S+$/i.test(form.heartbeatUrl.trim()) ? 'An http(s) URL.' : null
  const firstProblem =
    numberProblems.find(([, p]) => p)?.[0] ??
    (dashboardProblem ? 'Dashboard address' : subjectProblem ? 'Push contact' : heartbeatProblem ? 'Heartbeat URL' : null)

  function buildPatch(): AlertSettingsPatch {
    const patch: AlertSettingsPatch = {}
    const n = (value: string) => Number(value)
    const dashboardUrl = form.dashboardUrl.trim() || null
    if (dashboardUrl !== s.dashboardUrl) patch.dashboardUrl = dashboardUrl
    const heartbeat: NonNullable<AlertSettingsPatch['heartbeat']> = {}
    if (form.heartbeatUrl.trim()) heartbeat.url = form.heartbeatUrl.trim()
    else if (clearHeartbeat) heartbeat.url = null
    if (n(form.heartbeatInterval) !== s.heartbeat.intervalSeconds) heartbeat.intervalSeconds = n(form.heartbeatInterval)
    if (Object.keys(heartbeat).length) patch.heartbeat = heartbeat
    if (n(form.bootGraceSeconds) !== s.bootGraceSeconds) patch.bootGraceSeconds = n(form.bootGraceSeconds)
    if (
      form.massEnabled !== s.massOffline.enabled ||
      n(form.fractionPercent) !== s.massOffline.fractionPercent ||
      n(form.minAgents) !== s.massOffline.minAgents
    ) {
      patch.massOffline = { enabled: form.massEnabled, fractionPercent: n(form.fractionPercent), minAgents: n(form.minAgents) }
    }
    if (n(form.rateMax) !== s.destinationRateLimit.max || n(form.rateWindow) !== s.destinationRateLimit.windowMinutes) {
      patch.destinationRateLimit = { max: n(form.rateMax), windowMinutes: n(form.rateWindow) }
    }
    if (
      n(form.ttlCritical) !== s.pushTtlMinutes.critical ||
      n(form.ttlWarning) !== s.pushTtlMinutes.warning ||
      n(form.ttlInfo) !== s.pushTtlMinutes.info
    ) {
      patch.pushTtlMinutes = { critical: n(form.ttlCritical), warning: n(form.ttlWarning), info: n(form.ttlInfo) }
    }
    if (n(form.webhookRetryHours) !== s.webhookRetryHours) patch.webhookRetryHours = n(form.webhookRetryHours)
    if (
      n(form.eventDays) !== s.retention.eventDays ||
      n(form.alertDays) !== s.retention.alertDays ||
      n(form.deliveryDays) !== s.retention.deliveryDays
    ) {
      patch.retention = { eventDays: n(form.eventDays), alertDays: n(form.alertDays), deliveryDays: n(form.deliveryDays) }
    }
    const vapidSubject = form.vapidSubject.trim() || null
    if (vapidSubject !== s.vapidSubject) patch.vapidSubject = vapidSubject
    if (form.allowAnyPushService !== s.allowAnyPushService) patch.allowAnyPushService = form.allowAnyPushService
    return patch
  }

  const patch = buildPatch()
  const dirty = Object.keys(patch).length > 0

  return (
    <Panel title="General" description="Links in messages, the heartbeat, and the rarely touched limits." actions={<Saved show={saved && !dirty} />}>
      <form
        className="space-y-5"
        onSubmit={(event) => {
          event.preventDefault()
          if (firstProblem || !dirty) return
          update.mutate(patch, {
            onSuccess: (next) => {
              setForm(toGeneralForm(next))
              setClearHeartbeat(false)
              setSaved(true)
            },
          })
        }}
      >
        <div className="space-y-1.5">
          <label htmlFor={`${id}-dash`} className="text-xs font-medium">
            Dashboard address
          </label>
          <div className="flex flex-wrap gap-2">
            <Input
              id={`${id}-dash`}
              className="h-9 max-w-sm flex-1 rounded-md font-mono"
              value={form.dashboardUrl}
              placeholder={s.capturedOrigin ?? window.location.origin}
              onChange={(e) => set('dashboardUrl', e.target.value)}
              inputMode="url"
              spellCheck={false}
            />
            {!form.dashboardUrl ? (
              <Button type="button" variant="outline" size="sm" className="h-9" onClick={() => set('dashboardUrl', window.location.origin)}>
                Use this address
              </Button>
            ) : null}
          </div>
          <p className={dashboardProblem || serverErrors.dashboardUrl ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>
            {dashboardProblem ??
              serverErrors.dashboardUrl ??
              `Links in webhook messages open here. Empty: ${s.capturedOrigin ?? 'the address this page was saved from'}.`}
          </p>
        </div>

        <div className="space-y-3 rounded-lg border border-border p-3">
          <div className="space-y-1">
            <p className="text-xs font-medium">Heartbeat</p>
            <p className="text-xs text-muted-foreground">
              A dead controller cannot tell you it is dead. Give it a URL of an outside watcher (an Uptime Kuma push monitor,
              healthchecks.io) and Perch calls it regularly; the watcher alerts you when the calls stop.
            </p>
          </div>
          {s.heartbeat.configured && !clearHeartbeat ? (
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <span className="min-w-0">
                <span className="block truncate font-mono">{s.heartbeat.urlDisplay}</span>
                <span className="text-muted-foreground">
                  {view.heartbeat.lastPingAt
                    ? `Last call ${formatAgo(view.heartbeat.lastPingAt)}${view.heartbeat.lastStatus ? ` (${view.heartbeat.lastStatus})` : ''}`
                    : 'Not called yet'}
                </span>
                {view.heartbeat.lastError ? <span className="block text-destructive">{view.heartbeat.lastError}</span> : null}
              </span>
              <Button type="button" size="xs" variant="ghost" onClick={() => setClearHeartbeat(true)}>
                Remove
              </Button>
            </div>
          ) : clearHeartbeat ? (
            <p className="text-xs text-muted-foreground">Removed when you save.</p>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto]">
            <div className="space-y-1.5">
              <label htmlFor={`${id}-hb`} className="text-xs font-medium">
                {s.heartbeat.configured ? 'New URL' : 'URL'}
              </label>
              <Input
                id={`${id}-hb`}
                type="url"
                className="h-9 rounded-md font-mono"
                value={form.heartbeatUrl}
                placeholder="https://kuma.example.com/api/push/…"
                onChange={(e) => set('heartbeatUrl', e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
              <p className={heartbeatProblem ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>
                {heartbeatProblem ?? 'Stored encrypted and never shown in full again.'}
              </p>
            </div>
            <NumberField
              id={`${id}-hbi`}
              label="Every"
              unit="s"
              value={form.heartbeatInterval}
              onChange={(v) => set('heartbeatInterval', v)}
              limit={limits.heartbeatSeconds}
            />
          </div>
        </div>

        <details className="group rounded-lg border border-border [&[open]]:pb-3">
          <summary className="cursor-pointer list-none px-3 py-2.5 text-xs font-medium select-none marker:hidden hover:bg-muted/40">
            Advanced <span className="font-normal text-muted-foreground">· start-up grace, mass offline, rate limits, push lifetime, history</span>
          </summary>
          <div className="space-y-5 border-t border-border px-3 pt-3">
            <div className="grid gap-4 sm:grid-cols-2">
              <NumberField
                id={`${id}-boot`}
                label="Start-up grace"
                unit="s"
                hint="After a restart, silent agents are not reported for this long."
                value={form.bootGraceSeconds}
                onChange={(v) => set('bootGraceSeconds', v)}
                limit={limits.bootGraceSeconds}
              />
              <NumberField
                id={`${id}-retry`}
                label="Retry webhooks for"
                unit="h"
                value={form.webhookRetryHours}
                onChange={(v) => set('webhookRetryHours', v)}
                limit={limits.webhookRetryHours}
              />
            </div>
            <div className="space-y-3">
              <Toggle
                id={`${id}-mass`}
                label="Mass-offline guard"
                hint="When most agents go silent at once, send one “lost contact” alert instead of one per device."
                checked={form.massEnabled}
                onChange={(v) => set('massEnabled', v)}
              />
              <div className="grid gap-4 sm:grid-cols-2">
                <NumberField id={`${id}-frac`} label="Share silent" unit="%" value={form.fractionPercent} onChange={(v) => set('fractionPercent', v)} limit={limits.fractionPercent} />
                <NumberField id={`${id}-min`} label="And at least" unit="agents" value={form.minAgents} onChange={(v) => set('minAgents', v)} limit={limits.minAgents} />
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <NumberField id={`${id}-rmax`} label="Per destination at most" unit="messages" value={form.rateMax} onChange={(v) => set('rateMax', v)} limit={limits.rateMax} />
              <NumberField id={`${id}-rwin`} label="Within" unit="min" hint="More are held and sent as one summary." value={form.rateWindow} onChange={(v) => set('rateWindow', v)} limit={limits.rateWindowMinutes} />
            </div>
            <div className="space-y-2">
              <p className="text-xs font-medium">A push waits for an offline device at most</p>
              <div className="grid gap-4 sm:grid-cols-3">
                <NumberField id={`${id}-ttlc`} label="Critical" unit="min" value={form.ttlCritical} onChange={(v) => set('ttlCritical', v)} limit={limits.pushTtl.critical} />
                <NumberField id={`${id}-ttlw`} label="Warning" unit="min" value={form.ttlWarning} onChange={(v) => set('ttlWarning', v)} limit={limits.pushTtl.warning} />
                <NumberField id={`${id}-ttli`} label="Info" unit="min" value={form.ttlInfo} onChange={(v) => set('ttlInfo', v)} limit={limits.pushTtl.info} />
              </div>
            </div>
            <div className="space-y-2">
              <p className="text-xs font-medium">Keep history for</p>
              <div className="grid gap-4 sm:grid-cols-3">
                <NumberField id={`${id}-ev`} label="Events" unit="days" value={form.eventDays} onChange={(v) => set('eventDays', v)} limit={limits.eventDays} />
                <NumberField id={`${id}-al`} label="Closed alerts" unit="days" value={form.alertDays} onChange={(v) => set('alertDays', v)} limit={limits.alertDays} />
                <NumberField id={`${id}-dl`} label="Deliveries" unit="days" value={form.deliveryDays} onChange={(v) => set('deliveryDays', v)} limit={limits.deliveryDays} />
              </div>
            </div>
            <div className="space-y-1.5">
              <label htmlFor={`${id}-sub`} className="text-xs font-medium">
                Push contact (VAPID subject)
              </label>
              <Input
                id={`${id}-sub`}
                className="h-9 max-w-sm rounded-md font-mono"
                value={form.vapidSubject}
                placeholder={view.vapid?.subject ?? 'https://…'}
                onChange={(e) => set('vapidSubject', e.target.value)}
                spellCheck={false}
              />
              <p className={subjectProblem ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>
                {subjectProblem ??
                  'How push services can reach whoever runs this controller: a mailto: address or an https:// URL. Empty: the dashboard’s HTTPS address.'}
              </p>
            </div>
            <Toggle
              id={`${id}-any`}
              label="Allow any push service"
              hint="Off: devices may only subscribe through Google, Mozilla, Apple and Microsoft, so nobody can point the controller at an address inside your network."
              checked={form.allowAnyPushService}
              onChange={(v) => set('allowAnyPushService', v)}
            />
          </div>
        </details>

        {firstProblem ? <p className="text-xs text-destructive">Check “{firstProblem}”.</p> : null}
        {update.error && Object.keys(serverErrors).length === 0 ? (
          <p className="text-xs text-destructive">{update.error.message}</p>
        ) : Object.keys(serverErrors).length > 0 ? (
          <p className="text-xs text-destructive">{Object.entries(serverErrors).map(([field, message]) => `${field}: ${message}`).join(' · ')}</p>
        ) : null}
        <div className="flex justify-end gap-2">
          {dirty ? (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setForm(initial)
                setClearHeartbeat(false)
                update.reset()
              }}
            >
              Discard
            </Button>
          ) : null}
          <Button type="submit" disabled={!dirty || firstProblem !== null || update.isPending}>
            {update.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </form>
    </Panel>
  )
}

// ── Push keys ────────────────────────────────────────────────────────────

/** The controller's VAPID key pair: which one, and "Regenerate" (every device subscribes again on its next visit). */
export function PushKeysCard({ view }: { view: AlertSettingsView }) {
  const rotate = useRotateVapidKeys()
  const [confirming, setConfirming] = useState(false)
  const vapid = view.vapid
  return (
    <Panel
      title="Push keys"
      description="The key pair browsers check pushes against. Perch made it itself; no account at Google, Mozilla or Apple is involved."
      actions={
        <Button size="sm" variant="outline" onClick={() => setConfirming(true)}>
          <Key />
          Regenerate
        </Button>
      }
    >
      {vapid ? (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-xs">
          <dt className="text-muted-foreground">Key</dt>
          <dd className="font-mono">{vapid.keyId}</dd>
          <dt className="text-muted-foreground">Created</dt>
          <dd>{formatWhen(vapid.createdAt)}</dd>
          <dt className="text-muted-foreground">Contact</dt>
          <dd className="truncate font-mono">{vapid.subject}</dd>
          {!vapid.readable ? (
            <>
              <dt className="text-destructive">State</dt>
              <dd className="text-destructive">
                Unreadable: the controller’s APP_KEY changed since they were made. Regenerate them, then turn notifications on
                again on each device.
              </dd>
            </>
          ) : null}
        </dl>
      ) : (
        <p className="text-xs text-muted-foreground">Not created yet: they appear with the first device that turns push on.</p>
      )}
      {rotate.data ? (
        <p className="mt-3 text-xs">
          New key {rotate.data.keyId}. {rotate.data.invalidated} device{rotate.data.invalidated === 1 ? '' : 's'} will subscribe
          again the next time Perch is opened there.
        </p>
      ) : null}
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Regenerate the push keys?</DialogTitle>
            <DialogDescription>
              Every device stops receiving pushes until Perch is opened on it again (it then subscribes with the new key by
              itself). Do this if the keys leaked or cannot be read.
            </DialogDescription>
          </DialogHeader>
          {rotate.error ? (
            <DialogBody>
              <p className="text-destructive">{rotate.error.message}</p>
            </DialogBody>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={rotate.isPending}
              onClick={() => rotate.mutate(undefined, { onSuccess: () => setConfirming(false) })}
            >
              Regenerate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Panel>
  )
}

/** Shown while ALERTS_DELIVERY=off. */
export function DeliveryOffBanner() {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-status-warning/40 bg-status-warning/5 px-3 py-2.5 text-xs">
      <Moon className="mt-px size-4 shrink-0 text-status-warning" />
      <p>
        <span className="font-medium">Sending is switched off on this controller</span> (<span className="font-mono">ALERTS_DELIVERY=off</span>,
        for restored copies of a database). Alerts are recorded and routed, but nothing leaves: pushes and webhooks are marked
        collapsed.
      </p>
    </div>
  )
}
