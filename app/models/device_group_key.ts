import { DeviceGroupKeySchema } from '#database/schema'

/**
 * A device group's Wi-Fi passphrase (a PPSK entry on the access points),
 * encrypted with APP_KEY; `passphraseDigest` keeps it unique per gateway.
 */
export default class DeviceGroupKey extends DeviceGroupKeySchema {}
