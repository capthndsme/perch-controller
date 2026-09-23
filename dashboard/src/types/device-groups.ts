/**
 * Device groups (controller docs/gateway/device-groups.md section 3).
 */

export type DeviceGroupNetwork = {
  perchId: string
  /** The UCI interface name. */
  name: string
  label: string
  vlanId: number | null
  ipv4: string | null
  zone: string | null
}

export type DeviceGroupRate = { downloadKbit: number | null; uploadKbit: number | null }

export type DeviceGroupQos = {
  assignmentId: number
  policyId: number | null
  rate: DeviceGroupRate | null
  /** `group`: over the bound members; `network`: the default of the group's network. */
  via: 'group' | 'network'
  source: 'group' | 'admin'
}

export type DeviceGroupFirewallState = 'none' | 'pending' | 'applied' | 'conflict'

export type DeviceGroup = {
  id: number
  gatewayId: number
  name: string
  notes: string | null
  network: DeviceGroupNetwork | null
  qos: DeviceGroupQos | null
  internet: boolean
  portalBypass: boolean
  counts: { bound: number; onNetwork: number; keys: number }
  firewall: { state: DeviceGroupFirewallState }
  createdAt: string
  updatedAt: string
}

export type DeviceGroupMember = {
  mac: string
  name: string | null
  source: 'manual' | 'portal'
  portalUserId: number | null
  portalUsername: string | null
  createdAt: string
}

export type DeviceGroupKey = { id: number; label: string; createdAt: string }

export type DeviceGroupDetail = DeviceGroup & {
  members: DeviceGroupMember[]
  onNetwork: Array<{ mac: string; name: string | null; lastSeenAt: string | null }>
  keys: DeviceGroupKey[]
}

export type DeviceGroupPayload = {
  gatewayId?: number
  name?: string
  notes?: string | null
  networkPerchId?: string | null
  internet?: boolean
  portalBypass?: boolean
  qos?: { policyId?: number | null; rate?: DeviceGroupRate | null } | null
}

export type DeviceGroupOf = { group: DeviceGroup; via: 'bound' | 'network' } | null

export type DeviceGroupSettings = { ssids: string[]; confirmSeconds: number }

export type DeviceGroupSettingsView = {
  settings: DeviceGroupSettings
  defaults: DeviceGroupSettings
  limits: { confirmSeconds: { min: number; max: number }; ssids: { max: number } }
}

export type ApGroupStation = { mac: string; vid: number; ifname: string }

export type ApGroupState = {
  apId: number
  name: string
  online: boolean
  supported: boolean
  state:
    | 'idle'
    | 'sending'
    | 'pending_confirm'
    | 'applied'
    | 'failed'
    | 'rolled_back'
    | 'waiting'
    | 'offline'
    | 'unsupported'
  revision: number
  appliedRevision: number | null
  trunkPort: string | null
  trunkOverride: string | null
  converted: boolean
  error: string | null
  stations: ApGroupStation[]
  reportedAt: string | null
}
