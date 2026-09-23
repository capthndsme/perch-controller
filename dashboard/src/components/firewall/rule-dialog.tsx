import { useId, useMemo, useState } from 'react'
import { LockKey } from '@phosphor-icons/react'
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
import { Segmented } from '@/components/ui/segmented'
import {
  ApplyNowCheckbox,
  Checkbox,
  ErrorNote,
  FormField,
  WriteResult,
  selectClassName,
} from '@/components/firewall/firewall-ui'
import { useCreateRule, useUpdateRule, type FirewallDevice } from '@/hooks/use-firewall'
import { firewallFieldErrors, parsePortRange, ruleMatchSummary, ruleTitle } from '@/lib/firewall'
import type {
  FirewallOverview,
  FirewallRule,
  FirewallRuleInput,
  FirewallRulePatch,
  FirewallWrite,
  RuleTarget,
} from '@/types/firewall'

const MAC = /^[0-9a-f]{2}([:-][0-9a-f]{2}){5}$/i
const ADDRESS = /^!?[0-9A-Fa-f:.]{2,45}(\/\d{1,3}|\/[0-9.]{7,15})?$/
const EDITABLE_PROTOS = ['tcp', 'udp', 'icmp'] as const

/** "a, b c\nd" → ['a', 'b', 'c', 'd'] */
function words(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((w) => w.trim())
    .filter(Boolean)
}

function sameList(a: string[], b: string[]): boolean {
  const x = [...a].map((v) => v.toLowerCase()).sort()
  const y = [...b].map((v) => v.toLowerCase()).sort()
  return x.length === y.length && x.every((v, i) => v === y[i])
}

/** '' = the router itself (an input rule); '*' = any zone. */
function destValue(dest: string | null): string {
  return dest ?? ''
}

/**
 * Create or edit a traffic rule (firewall.md section 6). Perch writes forward
 * rules (between zones) and input rules (to the router), never output rules;
 * the server's path guard refuses what would cut the controller or the admin
 * off, and the refusal is explained here.
 */
export function RuleDialog({
  gatewayId,
  overview,
  rule,
  devices,
  onClose,
}: {
  gatewayId: number
  overview: FirewallOverview
  rule?: FirewallRule
  devices: FirewallDevice[]
  onClose: () => void
}) {
  const id = useId()
  const editing = Boolean(rule)
  const create = useCreateRule(gatewayId)
  const update = useUpdateRule(gatewayId)
  const mutation = editing ? update : create
  const [result, setResult] = useState<FirewallWrite<FirewallRule> | null>(null)

  const defaultSrc = overview.zones.find((z) => !z.wan)?.name ?? 'lan'
  const defaultDest = overview.wanZones[0] ?? 'wan'
  const [name, setName] = useState(rule?.name ?? '')
  const [src, setSrc] = useState(rule?.src ?? defaultSrc)
  const [dest, setDest] = useState(rule ? destValue(rule.dest) : defaultDest)
  const [protos, setProtos] = useState<string[]>(rule ? rule.proto.filter((p) => p !== 'all') : [])
  const extraProtos = protos.filter((p) => !(EDITABLE_PROTOS as readonly string[]).includes(p))
  const [destPort, setDestPort] = useState(rule?.destPort ?? '')
  const [srcMac, setSrcMac] = useState(rule?.srcMac.join(' ') ?? '')
  const [srcIp, setSrcIp] = useState(rule?.srcIp.join(' ') ?? '')
  const [destIp, setDestIp] = useState(rule?.destIp.join(' ') ?? '')
  const [family, setFamily] = useState<'any' | 'ipv4' | 'ipv6'>(
    rule?.family === 'ipv4' || rule?.family === '4' ? 'ipv4' : rule?.family === 'ipv6' || rule?.family === '6' ? 'ipv6' : 'any',
  )
  const [target, setTarget] = useState<RuleTarget>(
    rule && ['ACCEPT', 'REJECT', 'DROP'].includes(rule.target.toUpperCase()) ? (rule.target.toUpperCase() as RuleTarget) : 'REJECT',
  )
  const [enabled, setEnabled] = useState(rule?.enabled ?? true)
  const [placement, setPlacement] = useState<'top' | 'bottom'>('bottom')
  const [applyNow, setApplyNow] = useState(true)
  const [touched, setTouched] = useState(false)
  const [pick, setPick] = useState('')
  const serverErrors = firewallFieldErrors(mutation.error)

  const portsAllowed = protos.length === 0 || protos.some((p) => p === 'tcp' || p === 'udp')
  const errors = useMemo(() => {
    const out: Record<string, string> = {}
    if (!name.trim()) out.name = 'Give it a name.'
    if (destPort.trim()) {
      if (!words(destPort).every((p) => parsePortRange(p))) out.destPort = 'Ports 1–65535 or ranges like 8000-8010, separated by spaces.'
      else if (!portsAllowed) out.destPort = 'Ports need TCP or UDP.'
    }
    if (words(srcMac).some((m) => !MAC.test(m))) out.srcMac = 'MAC addresses like 02:00:00:00:00:01.'
    if (words(srcIp).some((a) => !ADDRESS.test(a))) out.srcIp = 'Addresses or networks, e.g. 192.168.1.20 or 192.168.30.0/24.'
    if (words(destIp).some((a) => !ADDRESS.test(a))) out.destIp = 'Addresses or networks, e.g. 192.168.1.20.'
    return out
  }, [name, destPort, portsAllowed, srcMac, srcIp, destIp])

  const narrowed = words(srcMac).length > 0 || words(srcIp).length > 0
  const mayHitPath =
    target !== 'ACCEPT' &&
    enabled &&
    !narrowed &&
    (src === '*' || (overview.managementZone !== null && src === overview.managementZone))

  function body(): FirewallRuleInput {
    return {
      name: name.trim(),
      src,
      dest: dest === '' ? null : dest,
      proto: protos.length ? protos : null,
      destPort: destPort.trim() ? words(destPort).join(' ') : null,
      srcMac: words(srcMac).length ? words(srcMac).map((m) => m.toLowerCase()) : null,
      srcIp: words(srcIp).length ? words(srcIp) : null,
      destIp: words(destIp).length ? words(destIp) : null,
      family: family === 'any' ? null : family,
      target,
      enabled,
    }
  }

  function patch(r: FirewallRule): FirewallRulePatch {
    const next = body()
    const out: FirewallRulePatch = {}
    if (next.name !== (r.name ?? '')) out.name = next.name
    if (next.src !== r.src) out.src = next.src
    if ((next.dest ?? null) !== r.dest) out.dest = next.dest
    if (!sameList(protos, r.proto.filter((p) => p !== 'all'))) out.proto = next.proto
    if ((next.destPort ?? null) !== (r.destPort ?? null)) out.destPort = next.destPort
    if (!sameList(next.srcMac ?? [], r.srcMac)) out.srcMac = next.srcMac
    if (!sameList(next.srcIp ?? [], r.srcIp)) out.srcIp = next.srcIp
    if (!sameList(next.destIp ?? [], r.destIp)) out.destIp = next.destIp
    const was = r.family === 'ipv4' || r.family === '4' ? 'ipv4' : r.family === 'ipv6' || r.family === '6' ? 'ipv6' : 'any'
    if (family !== was) out.family = next.family
    if (target !== r.target.toUpperCase()) out.target = target
    if (enabled !== r.enabled) out.enabled = enabled
    return out
  }

  function submit(event: React.FormEvent) {
    event.preventDefault()
    setTouched(true)
    if (Object.keys(errors).length > 0) return
    if (rule) {
      const p = patch(rule)
      if (Object.keys(p).length === 0) {
        onClose()
        return
      }
      update.mutate({ id: rule.id, body: p, apply: applyNow }, { onSuccess: setResult })
    } else {
      create.mutate({ body: { ...body(), placement }, apply: applyNow }, { onSuccess: setResult })
    }
  }

  const err = (key: string) => (touched ? errors[key] : undefined) ?? serverErrors[key]
  const zoneOptions = overview.zones.map((z) => (
    <option key={z.name} value={z.name}>
      {z.name}
      {z.wan ? ' (WAN)' : ''}
      {z.management ? ' (management)' : ''}
    </option>
  ))

  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent wide>
        <DialogHeader>
          <DialogTitle>
            {result ? (editing ? 'Rule saved' : 'Rule created') : editing ? `Edit ${ruleTitle(rule!)}` : 'New traffic rule'}
          </DialogTitle>
          <DialogDescription>
            {result
              ? 'The change is in Perch’s draft and, unless you kept it there, on its way to the router.'
              : 'Allow or block traffic between zones, or to the router itself. Rules are checked top to bottom; the first match wins.'}
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <>
            <DialogBody>
              {result.object ? (
                <p className="text-[12.5px]">
                  <span className="font-medium">{ruleTitle(result.object)}</span>: {result.object.target}{' '}
                  {ruleMatchSummary(result.object)}
                </p>
              ) : null}
              <WriteResult gatewayId={gatewayId} issues={result.issues} apply={result.apply} applyError={result.applyError} />
            </DialogBody>
            <DialogFooter>
              <Button size="sm" onClick={onClose}>
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col" noValidate>
            <DialogBody>
              <FormField label="Name" htmlFor={`${id}-name`} error={err('name')}>
                <Input
                  id={`${id}-name`}
                  value={name}
                  maxLength={64}
                  placeholder="e.g. Block IoT from the internet"
                  onChange={(e) => setName(e.target.value)}
                  aria-invalid={Boolean(err('name'))}
                />
              </FormField>

              <FormField label="Action">
                <Segmented
                  size="xs"
                  ariaLabel="Action"
                  value={target}
                  onChange={setTarget}
                  options={[
                    { id: 'ACCEPT', label: 'Allow', title: 'ACCEPT' },
                    { id: 'REJECT', label: 'Reject', title: 'REJECT: refused at once' },
                    { id: 'DROP', label: 'Drop', title: 'DROP: silently discarded' },
                  ]}
                  className="w-fit"
                />
              </FormField>

              <div className="grid gap-4 sm:grid-cols-2">
                <FormField label="From zone" htmlFor={`${id}-src`}>
                  <select id={`${id}-src`} className={selectClassName} value={src} onChange={(e) => setSrc(e.target.value)}>
                    {zoneOptions}
                    <option value="*">Any zone</option>
                  </select>
                </FormField>
                <FormField
                  label="To"
                  htmlFor={`${id}-dest`}
                  hint={dest === '' ? 'Traffic to the router itself (its services: DNS, SSH, the web interface).' : undefined}
                >
                  <select id={`${id}-dest`} className={selectClassName} value={dest} onChange={(e) => setDest(e.target.value)}>
                    <option value="">This router</option>
                    {zoneOptions}
                    <option value="*">Any zone</option>
                  </select>
                </FormField>
              </div>

              <FormField label="Protocols" hint="None ticked: any protocol.">
                <div className="flex flex-wrap gap-4">
                  {EDITABLE_PROTOS.map((p) => (
                    <Checkbox
                      key={p}
                      id={`${id}-proto-${p}`}
                      checked={protos.includes(p)}
                      onChange={(next) => setProtos((list) => (next ? [...list, p] : list.filter((x) => x !== p)))}
                      label={p.toUpperCase()}
                    />
                  ))}
                  {extraProtos.map((p) => (
                    <Checkbox
                      key={p}
                      id={`${id}-proto-${p}`}
                      checked
                      onChange={() => setProtos((list) => list.filter((x) => x !== p))}
                      label={p.toUpperCase()}
                    />
                  ))}
                </div>
              </FormField>

              <FormField
                label="Destination ports"
                htmlFor={`${id}-ports`}
                error={err('destPort')}
                hint="Empty: every port. Several: 80 443 8000-8010."
              >
                <Input
                  id={`${id}-ports`}
                  value={destPort}
                  className="font-mono"
                  placeholder="443"
                  onChange={(e) => setDestPort(e.target.value)}
                  aria-invalid={Boolean(err('destPort'))}
                />
              </FormField>

              <FormField
                label="Only these devices (MAC)"
                htmlFor={`${id}-mac`}
                error={err('srcMac')}
                hint="Empty: every device in the zone. A device with a random or changed MAC is not matched."
              >
                <Input
                  id={`${id}-mac`}
                  value={srcMac}
                  className="font-mono"
                  placeholder="02:00:00:00:00:01"
                  onChange={(e) => setSrcMac(e.target.value)}
                  aria-invalid={Boolean(err('srcMac'))}
                />
                {devices.length > 0 ? (
                  <select
                    aria-label="Add a device"
                    className={`${selectClassName} mt-1.5`}
                    value={pick}
                    onChange={(e) => {
                      const mac = e.target.value
                      if (mac && !words(srcMac).map((m) => m.toLowerCase()).includes(mac)) {
                        setSrcMac((v) => [...words(v), mac].join(' '))
                      }
                      setPick('')
                    }}
                  >
                    <option value="">Add a device…</option>
                    {devices.map((d) => (
                      <option key={d.mac} value={d.mac}>
                        {d.name} ({d.mac})
                      </option>
                    ))}
                  </select>
                ) : null}
              </FormField>

              <details className="rounded-md border border-border px-3 py-2">
                <summary className="cursor-pointer text-xs font-medium">Addresses and family</summary>
                <div className="mt-3 grid gap-4 sm:grid-cols-2">
                  <FormField label="Source addresses" htmlFor={`${id}-srcip`} error={err('srcIp')}>
                    <Input
                      id={`${id}-srcip`}
                      value={srcIp}
                      className="font-mono"
                      placeholder="192.168.30.0/24"
                      onChange={(e) => setSrcIp(e.target.value)}
                    />
                  </FormField>
                  <FormField label="Destination addresses" htmlFor={`${id}-destip`} error={err('destIp')}>
                    <Input
                      id={`${id}-destip`}
                      value={destIp}
                      className="font-mono"
                      placeholder="203.0.113.10"
                      onChange={(e) => setDestIp(e.target.value)}
                    />
                  </FormField>
                  <FormField label="Family" htmlFor={`${id}-family`}>
                    <select
                      id={`${id}-family`}
                      className={selectClassName}
                      value={family}
                      onChange={(e) => setFamily(e.target.value as 'any' | 'ipv4' | 'ipv6')}
                    >
                      <option value="any">IPv4 and IPv6</option>
                      <option value="ipv4">IPv4 only</option>
                      <option value="ipv6">IPv6 only</option>
                    </select>
                  </FormField>
                </div>
              </details>

              {editing ? null : (
                <FormField label="Place it" hint="Rules are checked top to bottom. You can move it afterwards.">
                  <Segmented
                    size="xs"
                    ariaLabel="Placement"
                    value={placement}
                    onChange={setPlacement}
                    options={[
                      { id: 'top', label: 'First' },
                      { id: 'bottom', label: 'Last' },
                    ]}
                    className="w-fit"
                  />
                </FormField>
              )}

              <Checkbox id={`${id}-enabled`} checked={enabled} onChange={setEnabled} label="Enabled" />

              {mayHitPath ? (
                <div className="flex items-start gap-2 rounded-md border border-status-warning/40 bg-status-warning/10 px-3 py-2 text-[11.5px]">
                  <LockKey className="mt-0.5 size-4 shrink-0 text-status-warning" />
                  <span>
                    {src === '*' ? 'Any zone' : `Zone ${src}`} includes the network the gateway reaches Perch through.
                    Perch refuses a blocking rule there that would cut the gateway or you off; narrow it to devices or
                    addresses if it is refused.
                  </span>
                </div>
              ) : null}

              <ErrorNote error={mutation.error} />
            </DialogBody>
            <DialogFooter>
              <div className="mr-auto">
                <ApplyNowCheckbox id={`${id}-apply`} checked={applyNow} onChange={setApplyNow} />
              </div>
              <Button type="button" size="sm" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={mutation.isPending}>
                {mutation.isPending ? 'Saving…' : editing ? 'Save' : 'Create'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
