import { ApGroupStateSchema } from '#database/schema'
import { jsonColumn } from '#models/json_column'

/** A station an access point reports on a group VLAN. */
export type ApGroupStation = { mac: string; vid: number; ifname: string }

/**
 * What an access point holds of the device groups' Wi-Fi (perch-apd
 * `groups.*`, docs/gateway/device-groups.md section 7).
 *
 * `state`: `idle` (nothing sent yet), `sending`, `pending_confirm`,
 * `applied`, `failed`, `rolled_back`, `unsupported` (no `wifi_groups`
 * capability), `offline`.
 */
export default class ApGroupState extends ApGroupStateSchema {
  @jsonColumn('stations')
  declare stations: ApGroupStation[] | null
}
