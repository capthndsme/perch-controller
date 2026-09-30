import { useId, useState } from 'react'
import { Link } from 'react-router-dom'
import { CheckCircle, PencilSimple, SealCheck, SpeakerSimpleSlash } from '@phosphor-icons/react'
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
import { useDialog } from '@/hooks/use-dialog'
import { useAcknowledgeAlert, useCreateMute, useResolveAlert } from '@/hooks/use-alerts'
import { SUBJECT_LABEL, subjectText } from '@/lib/alerts'
import { cn } from '@/lib/utils'
import type { AlertDetailView, AlertTypeView } from '@/types/alerts'

const DURATIONS = [
  { id: '60', label: '1 hour', minutes: 60 },
  { id: '480', label: '8 hours', minutes: 480 },
  { id: '1440', label: '1 day', minutes: 1440 },
  { id: '10080', label: '7 days', minutes: 10080 },
  { id: 'forever', label: 'Until I unmute', minutes: null },
] as const

type Scope = 'subject' | 'type'

const textareaClass =
  'min-h-16 w-full rounded-md border border-input bg-transparent px-2.5 py-1.5 text-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 dark:bg-input/30'

/** Choice tiles in a dialog (a radio group that reads well on a phone). */
function Choice({
  name,
  checked,
  onChange,
  title,
  detail,
}: {
  name: string
  checked: boolean
  onChange: () => void
  title: string
  detail?: string
}) {
  return (
    <label
      className={cn(
        'flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5 transition-colors duration-base active:duration-0',
        checked ? 'border-brand/50 bg-brand/5' : 'border-border hover:bg-muted/50 active:bg-muted',
      )}
    >
      <input type="radio" name={name} checked={checked} onChange={onChange} className="mt-0.5 accent-brand" />
      <span className="min-w-0 space-y-0.5">
        <span className="block text-[13px] font-medium">{title}</span>
        {detail ? <span className="block text-xs text-muted-foreground">{detail}</span> : null}
      </span>
    </label>
  )
}

/**
 * The admin's actions on an alert: acknowledge (stops reminders), resolve a condition by hand, mute this
 * subject or this type, and a link to its rule. Viewers see none of it.
 */
export function AlertActions({ alert, type }: { alert: AlertDetailView; type: AlertTypeView | undefined }) {
  const ack = useDialog()
  const resolve = useDialog()
  const mute = useDialog()
  const live = alert.state === 'active' || alert.state === 'pending'
  return (
    <div className="flex flex-wrap gap-2">
      {live && !alert.acknowledged ? (
        <Button variant="outline" size="sm" onClick={ack.show}>
          <SealCheck />
          Acknowledge
        </Button>
      ) : null}
      {alert.kind === 'condition' && live ? (
        <Button variant="outline" size="sm" onClick={resolve.show}>
          <CheckCircle />
          Resolve
        </Button>
      ) : null}
      {!alert.mutedBy ? (
        <Button variant="outline" size="sm" onClick={mute.show}>
          <SpeakerSimpleSlash />
          Mute
        </Button>
      ) : null}
      <Button asChild variant="ghost" size="sm">
        <Link to={`/settings/alerts?type=${encodeURIComponent(alert.type)}`}>
          <PencilSimple />
          Edit rule
        </Link>
      </Button>

      <Dialog open={ack.open} onOpenChange={ack.setOpen}>
        <AcknowledgeDialog key={ack.key} alert={alert} onDone={() => ack.setOpen(false)} />
      </Dialog>
      <Dialog open={resolve.open} onOpenChange={resolve.setOpen}>
        <ResolveDialog
          key={resolve.key}
          alert={alert}
          onDone={() => resolve.setOpen(false)}
          onMuteInstead={() => {
            resolve.setOpen(false)
            mute.show()
          }}
        />
      </Dialog>
      <Dialog open={mute.open} onOpenChange={mute.setOpen}>
        <MuteDialog key={mute.key} alert={alert} type={type} onDone={() => mute.setOpen(false)} />
      </Dialog>
    </div>
  )
}

function AcknowledgeDialog({ alert, onDone }: { alert: AlertDetailView; onDone: () => void }) {
  const acknowledge = useAcknowledgeAlert()
  const [note, setNote] = useState('')
  const noteId = useId()
  return (
    <DialogContent>
      <form
        className="contents"
        onSubmit={(event) => {
          event.preventDefault()
          acknowledge.mutate({ id: alert.id, note: note.trim() || undefined }, { onSuccess: onDone })
        }}
      >
        <DialogHeader>
          <DialogTitle>Acknowledge</DialogTitle>
          <DialogDescription>
            Say you are on it: reminders and escalation notices stop. The recovery notice still goes out.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="space-y-1.5">
            <label htmlFor={noteId} className="text-xs font-medium">
              Note (optional)
            </label>
            <textarea
              id={noteId}
              className={textareaClass}
              maxLength={300}
              value={note}
              placeholder="Replacing the PoE injector"
              onChange={(event) => setNote(event.target.value)}
            />
          </div>
          {acknowledge.error ? <p className="text-destructive">{acknowledge.error.message}</p> : null}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onDone}>
            Cancel
          </Button>
          <Button type="submit" disabled={acknowledge.isPending}>
            {acknowledge.isPending ? 'Saving…' : 'Acknowledge'}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  )
}

function ResolveDialog({
  alert,
  onDone,
  onMuteInstead,
}: {
  alert: AlertDetailView
  onDone: () => void
  onMuteInstead: () => void
}) {
  const resolveAlert = useResolveAlert()
  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Resolve by hand?</DialogTitle>
        <DialogDescription>{alert.title}</DialogDescription>
      </DialogHeader>
      <DialogBody>
        <p>
          Perch closes this alert now, without a recovery notice. If it still sees the problem, a new alert opens at
          its next check (within 15 seconds).
        </p>
        <p className="text-muted-foreground">To stop hearing about something you already know, mute it instead.</p>
        {alert.type === 'wan.down' ? (
          <p className="text-muted-foreground">
            For a WAN, resolving also makes Perch forget it: a link you removed on purpose stops counting as a WAN.
          </p>
        ) : null}
        {resolveAlert.error ? <p className="text-destructive">{resolveAlert.error.message}</p> : null}
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onMuteInstead}>
          Mute instead
        </Button>
        <Button
          type="button"
          disabled={resolveAlert.isPending}
          onClick={() => resolveAlert.mutate({ id: alert.id }, { onSuccess: onDone })}
        >
          {resolveAlert.isPending ? 'Resolving…' : 'Resolve'}
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}

function MuteDialog({
  alert,
  type,
  onDone,
}: {
  alert: AlertDetailView
  type: AlertTypeView | undefined
  onDone: () => void
}) {
  const createMute = useCreateMute()
  const canSubject = alert.subject.kind !== 'controller'
  const [scope, setScope] = useState<Scope>(canSubject ? 'subject' : 'type')
  const [duration, setDuration] = useState<(typeof DURATIONS)[number]['id']>('480')
  const [note, setNote] = useState('')
  const noteId = useId()
  const name = useId()
  const typeLabel = type?.label ?? alert.type
  const chosen = DURATIONS.find((option) => option.id === duration)!

  return (
    <DialogContent>
      <form
        className="contents"
        onSubmit={(event) => {
          event.preventDefault()
          createMute.mutate(
            {
              ...(scope === 'subject'
                ? { type: alert.type, subject: { kind: alert.subject.kind, ref: alert.subject.ref } }
                : { type: alert.type }),
              ...(chosen.minutes ? { minutes: chosen.minutes } : {}),
              ...(note.trim() ? { note: note.trim() } : {}),
            },
            { onSuccess: onDone },
          )
        }}
      >
        <DialogHeader>
          <DialogTitle>Mute</DialogTitle>
          <DialogDescription>
            Muted alerts are still recorded in the inbox; nothing is sent to your devices or webhooks.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <fieldset className="space-y-2">
            <legend className="section-label mb-2">What</legend>
            {canSubject ? (
              <Choice
                name={`${name}-scope`}
                checked={scope === 'subject'}
                onChange={() => setScope('subject')}
                title={`${typeLabel} for ${subjectText(alert.subject)}`}
                detail={`Only this ${SUBJECT_LABEL[alert.subject.kind].toLowerCase()}.`}
              />
            ) : null}
            <Choice
              name={`${name}-scope`}
              checked={scope === 'type'}
              onChange={() => setScope('type')}
              title={`Every “${typeLabel}” alert`}
              detail="Whatever it is about."
            />
          </fieldset>
          <fieldset>
            <legend className="section-label mb-2">For how long</legend>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {DURATIONS.map((option) => (
                <label
                  key={option.id}
                  className={cn(
                    'flex h-10 cursor-pointer items-center justify-center rounded-lg border px-2 text-[13px] font-medium transition-colors duration-base select-none active:duration-0 has-[:focus-visible]:outline-2',
                    duration === option.id
                      ? 'border-brand/50 bg-brand/10 text-brand'
                      : 'border-border hover:bg-muted/50 active:bg-muted',
                  )}
                >
                  <input
                    type="radio"
                    name={`${name}-duration`}
                    className="sr-only"
                    checked={duration === option.id}
                    onChange={() => setDuration(option.id)}
                  />
                  {option.label}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="space-y-1.5">
            <label htmlFor={noteId} className="text-xs font-medium">
              Note (optional)
            </label>
            <textarea
              id={noteId}
              className={textareaClass}
              maxLength={200}
              value={note}
              placeholder="Moving the AP to the garage"
              onChange={(event) => setNote(event.target.value)}
            />
          </div>
          {createMute.error ? <p className="text-destructive">{createMute.error.message}</p> : null}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onDone}>
            Cancel
          </Button>
          <Button type="submit" disabled={createMute.isPending}>
            {createMute.isPending ? 'Muting…' : `Mute ${chosen.minutes ? `for ${chosen.label}` : 'until unmuted'}`}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  )
}
