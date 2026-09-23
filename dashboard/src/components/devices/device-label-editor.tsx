import { useId, useMemo, useState } from 'react'
import { PencilSimple, Plus, Tag, X } from '@phosphor-icons/react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Panel } from '@/components/ui/panel'
import { Switch } from '@/components/ui/switch'
import { useDeleteDeviceLabel, useDeviceLabels, useSaveDeviceLabel } from '@/hooks/use-device-labels'
import { DEVICE_TYPE_OPTIONS, deviceTypeMeta } from '@/lib/device-labels'
import { connectionLabel } from '@/lib/presence'
import type { DeviceLabel, DeviceType } from '@/types/api'

const SELECT_CLASS =
  'h-8 w-full rounded-none border border-input bg-transparent px-2.5 text-xs outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 dark:bg-input/30'

const MAX_TAGS = 12
const TAG_MAX_LENGTH = 24

type DeviceLabelCardProps = {
  mac: string
  label: DeviceLabel | null
  /** What DHCP calls the device — shown as the fallback name. */
  hostname?: string | null
  hostnameSource?: string | null
}

/**
 * Read + edit surface for one device's operator-supplied identity: name,
 * type, the Ethernet mark, tags and notes. Starts read-only (this panel sits
 * on a page people mostly come to *look* at) and flips to a form on Edit.
 *
 * Saves go through `PATCH …/label`, which merges — so the form submits every
 * field explicitly, `null` for the ones left blank, rather than relying on
 * omission.
 */
export function DeviceLabelCard({ mac, label, hostname, hostnameSource }: DeviceLabelCardProps) {
  const [editing, setEditing] = useState(false)

  return (
    <Panel
      title="Name & notes"
      description={editing ? undefined : 'What you call this device, and why.'}
      actions={
        editing ? null : (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-6 px-2 text-xs"
            onClick={() => setEditing(true)}
          >
            <PencilSimple className="size-3" />
            {label ? 'Edit' : 'Add'}
          </Button>
        )
      }
    >
      {editing ? (
        // Keyed on the stored label so a version arriving (or changing)
        // underneath an open form re-seeds the inputs — no reset effect.
        <DeviceLabelForm
          key={`${mac}:${label?.updatedAt ?? 'new'}`}
          mac={mac}
          label={label}
          onDone={() => setEditing(false)}
        />
      ) : (
        <DeviceLabelSummary label={label} hostname={hostname} hostnameSource={hostnameSource} />
      )}
    </Panel>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5 text-[12.5px]">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 text-right">{children}</span>
    </div>
  )
}

function DeviceLabelSummary({
  label,
  hostname,
  hostnameSource,
}: {
  label: DeviceLabel | null
  hostname?: string | null
  hostnameSource?: string | null
}) {
  const typeMeta = deviceTypeMeta(label?.deviceType)

  return (
    <div className="divide-y divide-border/70">
      <Row label="Name">
        {label?.name ?? <span className="text-muted-foreground">not set</span>}
      </Row>
      <Row label="Type">
        {typeMeta ? (
          <span className="inline-flex items-center gap-1.5">
            <typeMeta.Icon className="size-3.5 text-muted-foreground" />
            {typeMeta.label}
          </span>
        ) : (
          <span className="text-muted-foreground">not set</span>
        )}
      </Row>
      <Row label="Connection">
        {label?.connection ? (
          connectionLabel(label.connection)
        ) : (
          <span className="text-muted-foreground">Detected automatically</span>
        )}
      </Row>
      <Row label="Tags">
        {label?.tags.length ? (
          <span className="flex flex-wrap justify-end gap-1">
            {label.tags.map((tag) => (
              <Badge key={tag} variant="outline" className="rounded text-[11px]">
                {tag}
              </Badge>
            ))}
          </span>
        ) : (
          <span className="text-muted-foreground">none</span>
        )}
      </Row>
      <Row label="Hostname">
        {hostname ?? <span className="text-muted-foreground">unknown</span>}
        {hostnameSource ? (
          <span className="ml-1 text-[11px] text-muted-foreground">({hostnameSource})</span>
        ) : null}
      </Row>
      {label?.notes ? (
        <div className="pt-2">
          <p className="section-label mb-1">Notes</p>
          <p className="text-[12.5px] whitespace-pre-wrap text-muted-foreground">{label.notes}</p>
        </div>
      ) : null}
    </div>
  )
}

function DeviceLabelForm({
  mac,
  label,
  onDone,
}: {
  mac: string
  label: DeviceLabel | null
  onDone: () => void
}) {
  const fieldId = useId()
  const [name, setName] = useState(label?.name ?? '')
  const [deviceType, setDeviceType] = useState<DeviceType | ''>(label?.deviceType ?? '')
  const [ethernet, setEthernet] = useState(label?.connection === 'ethernet')
  const [tags, setTags] = useState<string[]>(label?.tags ?? [])
  const [tagDraft, setTagDraft] = useState('')
  const [notes, setNotes] = useState(label?.notes ?? '')

  const save = useSaveDeviceLabel()
  const remove = useDeleteDeviceLabel()
  // Only for the datalist: the labels list is already cached by the filters.
  const known = useDeviceLabels()
  const suggestions = useMemo(
    () => (known.data?.tags ?? []).filter((tag) => !tags.includes(tag)),
    [known.data, tags],
  )

  const addTag = (raw: string) => {
    const cleaned = raw.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, TAG_MAX_LENGTH)
    if (!cleaned || tags.includes(cleaned) || tags.length >= MAX_TAGS) {
      setTagDraft('')
      return
    }
    setTags([...tags, cleaned])
    setTagDraft('')
  }

  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    // Blank fields are sent as explicit nulls: PATCH merges, so omitting one
    // would keep the stored value instead of clearing it.
    save.mutate(
      {
        mac,
        payload: {
          name: name.trim() || null,
          deviceType: deviceType || null,
          connection: ethernet ? 'ethernet' : null,
          tags,
          notes: notes.trim() || null,
        },
      },
      { onSuccess: onDone },
    )
  }

  const busy = save.isPending || remove.isPending

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor={`${fieldId}-name`} className="text-xs font-medium">
          Name
        </Label>
        <Input
          id={`${fieldId}-name`}
          value={name}
          maxLength={80}
          autoFocus
          placeholder="Living-room Apple TV"
          onChange={(event) => setName(event.target.value)}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={`${fieldId}-type`} className="text-xs font-medium">
          Type
        </Label>
        <select
          id={`${fieldId}-type`}
          value={deviceType}
          className={SELECT_CLASS}
          onChange={(event) => setDeviceType(event.target.value as DeviceType | '')}
        >
          <option value="">Unclassified</option>
          {DEVICE_TYPE_OPTIONS.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <Label htmlFor={`${fieldId}-ethernet`} className="text-xs font-medium">
            Ethernet device
          </Label>
          <p className="text-[11px] text-muted-foreground">
            Wired to the network: shown as Ethernet instead of Wired / unknown. If an access point
            lists it, WiFi still shows.
          </p>
        </div>
        <Switch id={`${fieldId}-ethernet`} checked={ethernet} onCheckedChange={setEthernet} />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={`${fieldId}-tag`} className="text-xs font-medium">
          Tags
        </Label>
        {tags.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {tags.map((tag) => (
              <Badge key={tag} variant="outline" className="gap-1 rounded text-[11px]">
                {tag}
                <button
                  type="button"
                  aria-label={`Remove tag ${tag}`}
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() => setTags(tags.filter((value) => value !== tag))}
                >
                  <X className="size-3" />
                </button>
              </Badge>
            ))}
          </div>
        ) : null}
        <div className="flex gap-1.5">
          <Input
            id={`${fieldId}-tag`}
            value={tagDraft}
            list={`${fieldId}-tag-options`}
            maxLength={TAG_MAX_LENGTH}
            placeholder={tags.length >= MAX_TAGS ? `${MAX_TAGS} tags maximum` : 'kids, office, …'}
            disabled={tags.length >= MAX_TAGS}
            onChange={(event) => setTagDraft(event.target.value)}
            onKeyDown={(event) => {
              // Enter adds a tag; it must not submit the whole form.
              if (event.key === 'Enter' || event.key === ',') {
                event.preventDefault()
                addTag(tagDraft)
              }
              if (event.key === 'Backspace' && !tagDraft && tags.length > 0) {
                setTags(tags.slice(0, -1))
              }
            }}
          />
          <datalist id={`${fieldId}-tag-options`}>
            {suggestions.map((tag) => (
              <option key={tag} value={tag} />
            ))}
          </datalist>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-8 shrink-0 px-2 text-xs"
            disabled={!tagDraft.trim() || tags.length >= MAX_TAGS}
            onClick={() => addTag(tagDraft)}
          >
            <Plus className="size-3" />
            Add
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground">
          <Tag className="mr-1 inline size-3" />
          Your own grouping — "kids", "office", "vlan-iot". Enter or comma adds one.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={`${fieldId}-notes`} className="text-xs font-medium">
          Notes
        </Label>
        <textarea
          id={`${fieldId}-notes`}
          value={notes}
          rows={3}
          maxLength={2000}
          placeholder="Wired to the switch behind the console."
          className="w-full rounded-none border border-input bg-transparent px-2.5 py-1.5 text-xs outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 dark:bg-input/30"
          onChange={(event) => setNotes(event.target.value)}
        />
      </div>

      {save.error ? <p className="text-xs text-destructive">{save.error.message}</p> : null}
      {remove.error ? <p className="text-xs text-destructive">{remove.error.message}</p> : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" className="h-7 px-3 text-xs" disabled={busy}>
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 px-3 text-xs"
          disabled={busy}
          onClick={onDone}
        >
          Cancel
        </Button>
        {label ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="ml-auto h-7 px-3 text-xs text-destructive hover:text-destructive"
            disabled={busy}
            onClick={() => remove.mutate(mac, { onSuccess: onDone })}
          >
            {remove.isPending ? 'Removing…' : 'Remove label'}
          </Button>
        ) : null}
      </div>
    </form>
  )
}
