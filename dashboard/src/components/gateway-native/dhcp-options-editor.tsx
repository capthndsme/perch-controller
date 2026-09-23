import { Plus, Trash } from '@phosphor-icons/react'
import { Field, ListEditor } from '@/components/gateway-native/native-ui'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { OptionsDraft } from '@/lib/gateway-native'

export function DhcpOptionsEditor({
  draft,
  onChange,
  routerAddress,
  unparsed,
}: {
  draft: OptionsDraft
  onChange: (next: OptionsDraft) => void
  /** The network's router address (the default gateway and DNS server clients get). */
  routerAddress: string | null
  /** Items the page does not edit (tagged or named options), shown read-only. */
  unparsed: string[]
}) {
  const set = (patch: Partial<OptionsDraft>) => onChange({ ...draft, ...patch })
  return (
    <div className="space-y-3">
      <Field
        label="Router (option 3)"
        hint={routerAddress ? `Empty = the router itself (${routerAddress}).` : 'Empty = the router itself.'}
      >
        <Input
          value={draft.gateway}
          placeholder={routerAddress ?? '192.168.1.1'}
          onChange={(e) => set({ gateway: e.target.value })}
          className="font-mono"
        />
      </Field>
      <Field label="DNS servers (option 6)" hint="Pushed to clients in this order. Empty = the router answers DNS.">
        <ListEditor values={draft.dnsServers} onChange={(v) => set({ dnsServers: v })} placeholder="192.168.1.53" />
      </Field>
      <Field label="NTP servers (option 42)" hint="Addresses only (DHCP carries no names here).">
        <ListEditor values={draft.ntpServers} onChange={(v) => set({ ntpServers: v })} placeholder="192.168.1.1" />
      </Field>
      <Field label="Domain (option 15)">
        <Input value={draft.domain} placeholder="lan" onChange={(e) => set({ domain: e.target.value })} className="font-mono" />
      </Field>
      <Field label="Other options" hint="Code and value as dnsmasq takes them, e.g. 26 · 1480 (MTU).">
        <div className="space-y-1.5">
          {draft.other.map((o, i) => (
            <div key={i} className="flex gap-1.5">
              <Input
                value={o.code}
                inputMode="numeric"
                aria-label="Option code"
                placeholder="code"
                onChange={(e) => set({ other: draft.other.map((x, j) => (j === i ? { ...x, code: e.target.value } : x)) })}
                className="h-7 w-20 font-mono"
              />
              <Input
                value={o.value}
                aria-label="Option value"
                placeholder="value"
                onChange={(e) => set({ other: draft.other.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })}
                className="h-7 font-mono"
              />
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-label="Remove option"
                onClick={() => set({ other: draft.other.filter((_, j) => j !== i) })}
              >
                <Trash className="size-3.5" />
              </Button>
            </div>
          ))}
          <Button type="button" size="sm" variant="outline" onClick={() => set({ other: [...draft.other, { code: '', value: '' }] })}>
            <Plus className="size-3.5" />
            Add option
          </Button>
        </div>
      </Field>
      {unparsed.length > 0 ? (
        <Field label="Kept as they are" hint="Tagged or named items the page does not edit.">
          <ul className="space-y-0.5 font-mono text-[11px] text-muted-foreground">
            {unparsed.map((u) => (
              <li key={u} className="break-all">
                {u}
              </li>
            ))}
          </ul>
        </Field>
      ) : null}
    </div>
  )
}
