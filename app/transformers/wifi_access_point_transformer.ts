import type WifiAccessPoint from '#models/wifi_access_point'
import hub from '#services/ap_agent_hub'
import { BaseTransformer } from '@adonisjs/core/transformers'
import type { DateTime } from 'luxon'

/**
 * Safe wire shape for WiFi source settings. Agent credentials never leave;
 * `agent` is the dashboard's view of the Perch AP Daemon session
 * (docs/ap-controller.md section 4.4).
 */
export default class WifiAccessPointTransformer extends BaseTransformer<WifiAccessPoint> {
  toObject() {
    const info = this.resource.agentInfo
    return {
      id: this.resource.id,
      name: this.resource.name,
      friendlyName: this.resource.friendlyName,
      metricsUrl: this.resource.metricsUrl ?? null,
      transport: this.resource.transport ?? 'scrape',
      pollIntervalSeconds: this.resource.pollIntervalSeconds,
      enabled: this.resource.enabled,
      enableTwoWayCommands: this.resource.enableTwoWayCommands,
      sshHost: this.resource.sshHost,
      sshPort: this.resource.sshPort,
      sshUsername: this.resource.sshUsername,
      hasSshPrivateKey: this.resource.sshPrivateKey !== null,
      model: this.resource.model,
      openwrtRelease: this.resource.openwrtRelease,
      nodename: this.resource.nodename,
      lastSeenAt: this.resource.lastSeenAt,
      lastStatus: this.resource.lastStatus,
      agent: this.resource.agentId
        ? {
            online: hub.isOnline(this.resource.id),
            idPrefix: this.resource.agentId.slice(0, 8),
            version: this.resource.agentVersion ?? null,
            arch: info?.arch ?? null,
            hostname: info?.hostname ?? null,
            boardName: info?.boardName ?? null,
            target: info?.target ?? null,
            kernel: info?.kernel ?? null,
            capabilities: info?.capabilities ?? [],
            joinedAt: iso(this.resource.agentJoinedAt),
            connectedAt: iso(this.resource.agentConnectedAt),
            disconnectedAt: iso(this.resource.agentDisconnectedAt),
            lastAddress: this.resource.agentLastAddress ?? null,
          }
        : null,
      createdAt: this.resource.createdAt,
      updatedAt: this.resource.updatedAt,
    }
  }
}

function iso(value: DateTime | null | undefined): string | null {
  return value ? value.toUTC().toISO() : null
}
