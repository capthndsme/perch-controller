import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
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
import { DurationInput, ErrorNote, FormField, QuotaInput } from '@/components/portal/portal-ui'
import { useCreateVoucherBatch, usePortals } from '@/hooks/use-portal'
import {
  mbpsToKbps,
  selectClassName,
  toBytes,
  toMinutes,
  vineFieldErrors,
  type DurationUnit,
  type QuotaUnit,
} from '@/lib/portal'
import type { CreateVoucherBatchPayload } from '@/types/api'

type Clock = 'first_use' | 'creation' | 'active_time'

const CLOCKS: ReadonlyArray<{ id: Clock; label: string; hint: string }> = [
  { id: 'first_use', label: 'From first use', hint: 'The time starts when the guest first signs in, then runs by the clock.' },
  { id: 'creation', label: 'From now', hint: 'The time starts now, whether or not the code is used (event passes).' },
  { id: 'active_time', label: 'Only while online', hint: 'The time runs down only while the device moves traffic.' },
]

/** Voucher batch: the codes come back once, then the batch page shows them for printing. */
export function VoucherBatchDialog({ onClose, portalId }: { onClose: () => void; portalId?: number }) {
  const navigate = useNavigate()
  const create = useCreateVoucherBatch()
  const portals = usePortals()
  const [portal, setPortal] = useState(portalId ? String(portalId) : '')
  const [name, setName] = useState('')
  const [count, setCount] = useState('10')
  const [time, setTime] = useState<{ amount: string; unit: DurationUnit }>({ amount: '2', unit: 'h' })
  const [data, setData] = useState<{ amount: string; unit: QuotaUnit }>({ amount: '', unit: 'GB' })
  const [clock, setClock] = useState<Clock>('first_use')
  const [maxDevices, setMaxDevices] = useState('1')
  const [down, setDown] = useState('')
  const [up, setUp] = useState('')
  const [redeemBy, setRedeemBy] = useState('')
  const [codeLength, setCodeLength] = useState('10')
  const [note, setNote] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)
  const fieldErrors = vineFieldErrors(create.error)

  function submit(event: React.FormEvent) {
    event.preventDefault()
    setLocalError(null)
    const durationMinutes = toMinutes(time.amount, time.unit)
    const quotaBytes = toBytes(data.amount, data.unit)
    if (durationMinutes === undefined && quotaBytes === undefined) {
      setLocalError('Give the vouchers a duration, a data quota, or both.')
      return
    }
    const payload: CreateVoucherBatchPayload = {
      portalId: portal ? Number(portal) : null,
      name: name.trim() || defaultName(durationMinutes, quotaBytes),
      note: note.trim() || null,
      count: Number(count),
      codeLength: Number(codeLength),
      durationMinutes: durationMinutes ?? null,
      durationMode: clock === 'active_time' ? 'active_time' : 'wall_clock',
      startMode: clock === 'creation' ? 'creation' : 'first_use',
      quotaBytes: quotaBytes ?? null,
      downKbps: mbpsToKbps(down) ?? null,
      upKbps: mbpsToKbps(up) ?? null,
      maxDevices: Number(maxDevices),
      // End of the chosen day, in the admin's time zone.
      redeemBy: redeemBy ? new Date(`${redeemBy}T23:59:59`).toISOString() : null,
    }
    create.mutate(payload, {
      onSuccess: (result) => {
        onClose()
        navigate(`/portal/vouchers/${result.batch.id}`, { state: { codes: result.codes, delivery: result.delivery } })
      },
    })
  }

  const clockHint = CLOCKS.find((c) => c.id === clock)?.hint

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent wide>
        <form onSubmit={submit} className="flex min-h-0 flex-col">
          <DialogHeader>
            <DialogTitle>New vouchers</DialogTitle>
            <DialogDescription>
              A batch of codes with the same limits. A guest with time and a data voucher uses the time first; the data
              waits for later.
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label="How many" htmlFor="batch-count" error={fieldErrors.count} hint="1–1000 codes.">
                <Input id="batch-count" required inputMode="numeric" value={count} onChange={(e) => setCount(e.target.value)} className="rounded-md" />
              </FormField>
              <FormField label="Portal" htmlFor="batch-portal" error={fieldErrors.portalId} hint="“Any” binds a code to the first portal it is used on.">
                <select id="batch-portal" className={selectClassName} value={portal} onChange={(e) => setPortal(e.target.value)}>
                  <option value="">Any portal</option>
                  {(portals.data ?? []).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </FormField>
              <FormField label="Time" htmlFor="batch-time" error={fieldErrors.durationMinutes}>
                <DurationInput id="batch-time" {...time} onChange={setTime} />
              </FormField>
              <FormField label="Data" htmlFor="batch-data" error={fieldErrors.quotaBytes} hint="At least 1 MB.">
                <QuotaInput id="batch-data" {...data} onChange={setData} />
              </FormField>
            </div>

            <fieldset className="space-y-1.5">
              <legend className="mb-1.5 text-xs font-medium">When the time runs</legend>
              <div className="flex flex-wrap gap-1.5" role="radiogroup">
                {CLOCKS.map((option) => (
                  <Button
                    key={option.id}
                    type="button"
                    size="sm"
                    role="radio"
                    aria-checked={clock === option.id}
                    variant={clock === option.id ? 'default' : 'outline'}
                    onClick={() => setClock(option.id)}
                  >
                    {option.label}
                  </Button>
                ))}
              </div>
              <p className="text-[11px] text-muted-foreground">{clockHint}</p>
            </fieldset>

            <div className="grid gap-4 sm:grid-cols-3">
              <FormField label="Devices per code" htmlFor="batch-devices" error={fieldErrors.maxDevices} hint="A code used on one more device moves off the first.">
                <Input id="batch-devices" inputMode="numeric" value={maxDevices} onChange={(e) => setMaxDevices(e.target.value)} className="rounded-md" />
              </FormField>
              <FormField label="Download (Mbps)" htmlFor="batch-down" error={fieldErrors.downKbps}>
                <Input id="batch-down" inputMode="decimal" placeholder="No limit" value={down} onChange={(e) => setDown(e.target.value)} className="rounded-md" />
              </FormField>
              <FormField label="Upload (Mbps)" htmlFor="batch-up" error={fieldErrors.upKbps}>
                <Input id="batch-up" inputMode="decimal" placeholder="No limit" value={up} onChange={(e) => setUp(e.target.value)} className="rounded-md" />
              </FormField>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label="Name" htmlFor="batch-name" error={fieldErrors.name}>
                <Input
                  id="batch-name"
                  maxLength={80}
                  placeholder={defaultName(toMinutes(time.amount, time.unit), toBytes(data.amount, data.unit))}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="rounded-md"
                />
              </FormField>
              <FormField label="Use by" htmlFor="batch-redeem" error={fieldErrors.redeemBy} hint="Unused codes expire after this day. Used ones run on.">
                <Input id="batch-redeem" type="date" value={redeemBy} onChange={(e) => setRedeemBy(e.target.value)} className="rounded-md" />
              </FormField>
              <FormField label="Code length" htmlFor="batch-length" error={fieldErrors.codeLength} hint="8–16 characters; 10 is plenty.">
                <Input id="batch-length" inputMode="numeric" value={codeLength} onChange={(e) => setCodeLength(e.target.value)} className="rounded-md" />
              </FormField>
              <FormField label="Note" htmlFor="batch-note" error={fieldErrors.note}>
                <Input id="batch-note" maxLength={500} placeholder="Optional" value={note} onChange={(e) => setNote(e.target.value)} className="rounded-md" />
              </FormField>
            </div>
            {localError ? <p className="text-xs text-destructive">{localError}</p> : null}
            <ErrorNote error={create.error && Object.keys(fieldErrors).length === 0 ? create.error : null} />
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? 'Creating…' : 'Create codes'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function defaultName(minutes: number | undefined, bytes: number | undefined): string {
  const parts: string[] = []
  if (minutes && Number.isFinite(minutes)) {
    parts.push(minutes % 1440 === 0 ? `${minutes / 1440} day` : minutes % 60 === 0 ? `${minutes / 60} hour` : `${minutes} min`)
  }
  if (bytes && Number.isFinite(bytes)) parts.push(bytes >= 1e9 ? `${bytes / 1e9} GB` : `${Math.round(bytes / 1e6)} MB`)
  return parts.length ? parts.join(' + ') : 'Vouchers'
}
