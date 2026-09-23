import { DeviceGroupSchema } from '#database/schema'

/**
 * A device group of a gateway (docs/gateway/device-groups.md): an apartment
 * unit, a family, the IoT gear. Members, a network, Wi-Fi keys, a speed
 * limit, internet access and a portal bypass.
 */
export default class DeviceGroup extends DeviceGroupSchema {}
