import type { AlertTypeDef, RenderInput } from '#services/alerts/model'
import { defineAlertTypes } from '#services/alerts/registry'
import { conditionRender, forSpan, hhmm, pStr, pTime } from '#services/alerts/render'

/**
 * Alert types of the gateway-sync area (docs/design/gateway-sync/README.md
 * 14). WAN transitions are the alerts area's own `wan.*` (from the gateway
 * stats), and rollbacks after failed checks are `gateway.apply_rolled_back`
 * with the reason, so neither is repeated here. A new WireGuard peer is remote
 * access into the LAN: a warning, pushed by default.
 */

type Spec = Omit<AlertTypeDef, 'category' | 'owner' | 'subjects'> & {
  subjects?: AlertTypeDef['subjects']
}

function gw(spec: Spec): AlertTypeDef {
  return { category: 'gateway', owner: 'gateway-sync', subjects: ['gateway'], ...spec }
}

function gatewayName(a: RenderInput): string {
  return pStr(a.payload, 'gatewayName', a.label)
}

export default defineAlertTypes([
  gw({
    type: 'gateway.wireguard.peer_added',
    kind: 'notice',
    severity: 'warning',
    label: 'WireGuard peer added',
    description: 'A new WireGuard peer can reach the network: remote access was granted.',
    render: (a) => ({
      title: `New WireGuard peer on ${pStr(a.payload, 'interface', 'the gateway')}`,
      body: `${pStr(a.payload, 'label', 'A peer')} (key ${pStr(a.payload, 'publicKeyPrefix', '…')}…) was added${pStr(a.payload, 'userName') ? ` by ${pStr(a.payload, 'userName')}` : ''}. Remove it if you did not expect it.`,
      path: '/gateway/vpn',
    }),
  }),
  gw({
    type: 'gateway.wireguard.key_rotated',
    kind: 'notice',
    severity: 'warning',
    label: 'WireGuard key rotated',
    description: 'A WireGuard interface got a new key: every peer needs the new public key.',
    render: (a) => ({
      title: `WireGuard key of ${pStr(a.payload, 'interface', 'an interface')} rotated`,
      body: 'Its peers cannot connect until they have the new public key.',
      path: '/gateway/vpn',
    }),
  }),
  gw({
    type: 'gateway.wireguard.peer_stale',
    kind: 'condition',
    severity: 'info',
    label: 'WireGuard peer silent',
    description: 'A WireGuard peer that used to connect has not done so for a while.',
    defaults: { holdSeconds: 0, notify: false },
    render: conditionRender({
      state: 'silent',
      opened: (a, c) => {
        const last = pTime(a.payload, 'lastHandshakeAt')
        return {
          title: `WireGuard peer ${pStr(a.payload, 'label', 'a peer')} is silent`,
          body: last
            ? `No handshake on ${pStr(a.payload, 'interface', 'its interface')} since ${hhmm(last, c.zone)}.`
            : `No handshake on ${pStr(a.payload, 'interface', 'its interface')} for a while.`,
          path: '/gateway/vpn',
        }
      },
      resolved: (a, c) => ({
        title: `WireGuard peer ${pStr(a.payload, 'label', 'a peer')} connected again`,
        body: forSpan(a, c, 'Silent'),
      }),
    }),
  }),
  gw({
    type: 'gateway.ddns.update_failed',
    kind: 'condition',
    severity: 'warning',
    label: 'Dynamic DNS update failing',
    description: 'A DDNS service reports an error after its last successful update.',
    defaults: { holdSeconds: 300 },
    render: conditionRender({
      state: 'failing',
      opened: (a) => ({
        title: `Dynamic DNS ${pStr(a.payload, 'service', '')} is failing`,
        body: pStr(a.payload, 'error', 'The provider refused the update.'),
        path: '/gateway/internet',
      }),
      resolved: (a, c) => ({
        title: `Dynamic DNS ${pStr(a.payload, 'service', '')} updates again`,
        body: forSpan(a, c, 'Failing'),
      }),
    }),
  }),
  gw({
    type: 'gateway.ddns.ip_mismatch',
    kind: 'condition',
    severity: 'warning',
    label: 'Dynamic DNS points elsewhere',
    description: 'The address a DDNS name has is not the WAN address, for longer than two checks.',
    defaults: { holdSeconds: 1200 },
    render: conditionRender({
      state: 'out of date',
      opened: (a) => ({
        title: `${pStr(a.payload, 'domain', 'A DDNS name')} points to an old address`,
        body: `It has ${pStr(a.payload, 'registered', '?')}; the WAN is ${pStr(a.payload, 'wanIp', '?')}. Update now from the gateway's Internet page.`,
        path: '/gateway/internet',
      }),
    }),
  }),
  gw({
    type: 'gateway.upnp.mapping_opened',
    kind: 'notice',
    severity: 'info',
    label: 'UPnP port opened',
    description: 'A device opened a port on the router with UPnP or NAT-PMP.',
    defaults: { notify: false },
    render: (a) => ({
      title: `UPnP opened ${pStr(a.payload, 'proto', '')} ${pStr(a.payload, 'externalPort', '')}`,
      body: `${pStr(a.payload, 'deviceName') || pStr(a.payload, 'internalIp', 'A device')}${pStr(a.payload, 'description') ? ` (${pStr(a.payload, 'description')})` : ''} is reachable from the internet on that port.`,
      path: '/firewall',
    }),
    pii: ['internalIp', 'deviceName'],
  }),
  gw({
    type: 'gateway.ipv6.prefix_changed',
    kind: 'notice',
    severity: 'info',
    label: 'IPv6 prefix changed',
    description: 'The provider delegated another IPv6 prefix: LAN addresses renumber.',
    render: (a) => {
      const after = Array.isArray(a.payload.after) ? (a.payload.after as string[]) : []
      return {
        title: `New IPv6 prefix on ${pStr(a.payload, 'network', 'the WAN')}`,
        body: after.length > 0 ? `Now ${after.join(', ')}.` : 'The delegated prefix went away.',
        path: '/gateway/ipv6',
      }
    },
    pii: ['before', 'after'],
  }),
  gw({
    type: 'gateway.apply.checks_overridden',
    kind: 'notice',
    severity: 'warning',
    label: 'Gateway checks overridden',
    description: 'An admin confirmed a gateway change although its checks had not passed.',
    render: (a) => ({
      title: `Checks overridden on ${gatewayName(a)}`,
      body: `${pStr(a.payload, 'userName', 'An admin')} kept a change whose checks did not pass.`,
    }),
  }),
  gw({
    type: 'gateway.multiwan.writes_enabled',
    kind: 'notice',
    severity: 'warning',
    subjects: ['controller'],
    label: 'Multi-WAN writes enabled',
    description: 'An admin let Perch write mwan3 (owner decision 12 superseded).',
    render: (a) => ({
      title: 'Perch may now edit multi-WAN',
      body: `${pStr(a.payload, 'userName', 'An admin')} turned on multi-WAN writes in Settings → Gateway sync.`,
      path: '/settings/gateway-sync',
    }),
  }),
])
