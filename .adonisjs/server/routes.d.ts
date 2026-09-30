import '@adonisjs/core/types/http'

type ParamValue = string | number | bigint | boolean

export type ScannedRoutes = {
  ALL: {
    'gatewaySync.wan': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gatewaySync.wanHistory': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gatewaySync.wanOrder': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gatewaySync.wanCreate': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gatewaySync.wanAliasUpdate': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'perchId': ParamValue} }
    'gatewaySync.wanAliasDelete': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'perchId': ParamValue} }
    'gatewaySync.wanShow': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'perchId': ParamValue} }
    'gatewaySync.wanUpdate': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'perchId': ParamValue} }
    'gatewaySync.wanDelete': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'perchId': ParamValue} }
    'gatewaySync.wanAliasCreate': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'perchId': ParamValue} }
    'gatewaySync.wireguardConfig': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gatewaySync.wireguardInterfaceCreate': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gatewaySync.wireguardInterfaceUpdate': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'perchId': ParamValue} }
    'gatewaySync.wireguardInterfaceDelete': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'perchId': ParamValue} }
    'gatewaySync.wireguardRotateKey': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'perchId': ParamValue} }
    'gatewaySync.wireguardPeerCreate': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'perchId': ParamValue} }
    'gatewaySync.wireguardPeerUpdate': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'perchId': ParamValue} }
    'gatewaySync.wireguardPeerDelete': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'perchId': ParamValue} }
    'gatewaySync.ipv6': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gatewaySync.ipv6Update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gatewaySync.ipv6LanUpdate': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'network': ParamValue} }
    'gatewaySync.ambiguities': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gatewaySync.ambiguitiesResolve': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gatewaySync.firewallDefaults': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gatewaySync.firewallDefaultsUpdate': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gatewaySync.upnpConfig': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gatewaySync.upnpConfigUpdate': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gatewaySync.upnpAclOrder': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gatewaySync.upnpAclCreate': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gatewaySync.upnpAclUpdate': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'perchId': ParamValue} }
    'gatewaySync.upnpAclDelete': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'perchId': ParamValue} }
    'gatewaySync.upnpMappingsDelete': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gatewaySync.upnpDeviceBlock': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'mac': ParamValue} }
    'gatewaySync.ddns': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gatewaySync.ddnsServiceCreate': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gatewaySync.ddnsServiceUpdate': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'perchId': ParamValue} }
    'gatewaySync.ddnsServiceDelete': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'perchId': ParamValue} }
    'gatewaySync.ddnsUpdateNow': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'perchId': ParamValue} }
    'gatewaySync.multiwan': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gatewaySyncSettings.show': { paramsTuple?: []; params?: {} }
    'gatewaySyncSettings.update': { paramsTuple?: []; params?: {} }
    'alerts.push.renew': { paramsTuple?: []; params?: {} }
    'alerts.summary': { paramsTuple?: []; params?: {} }
    'alerts.catalogue': { paramsTuple?: []; params?: {} }
    'alerts.read': { paramsTuple?: []; params?: {} }
    'alerts.mutes.index': { paramsTuple?: []; params?: {} }
    'alerts.watches.index': { paramsTuple?: []; params?: {} }
    'alerts.push.config': { paramsTuple?: []; params?: {} }
    'alerts.push.index': { paramsTuple?: []; params?: {} }
    'alerts.push.store': { paramsTuple?: []; params?: {} }
    'alerts.push.unsubscribe': { paramsTuple?: []; params?: {} }
    'alerts.push.update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'alerts.push.destroy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'alerts.push.test': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'alerts.index': { paramsTuple?: []; params?: {} }
    'alerts.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'alerts.mutes.store': { paramsTuple?: []; params?: {} }
    'alerts.mutes.destroy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'alerts.watches.update': { paramsTuple: [ParamValue]; params: {'mac': ParamValue} }
    'alerts.deliveries.index': { paramsTuple?: []; params?: {} }
    'alerts.deliveries.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'alerts.acknowledge': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'alerts.resolve': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'settings.alerts.show': { paramsTuple?: []; params?: {} }
    'settings.alerts.update': { paramsTuple?: []; params?: {} }
    'settings.alerts.test': { paramsTuple?: []; params?: {} }
    'settings.alerts.vapid.rotate': { paramsTuple?: []; params?: {} }
    'settings.alerts.webhooks.index': { paramsTuple?: []; params?: {} }
    'settings.alerts.webhooks.store': { paramsTuple?: []; params?: {} }
    'settings.alerts.webhooks.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'settings.alerts.webhooks.update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'settings.alerts.webhooks.destroy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'settings.alerts.webhooks.test': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'settings.alerts.webhooks.rotateSecret': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'agentUpdates.download': { paramsTuple: [ParamValue,ParamValue]; params: {'artefactId': ParamValue,'file': ParamValue} }
    'agentUpdates.fleet': { paramsTuple?: []; params?: {} }
    'agentUpdates.jobs': { paramsTuple?: []; params?: {} }
    'agentUpdates.job': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'agentUpdates.events': { paramsTuple?: []; params?: {} }
    'agentUpdates.releases': { paramsTuple?: []; params?: {} }
    'agentUpdates.release': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'agentUpdates.rollouts': { paramsTuple?: []; params?: {} }
    'agentUpdates.rollout': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'agentUpdates.updateDevice': { paramsTuple: [ParamValue,ParamValue]; params: {'kind': ParamValue,'id': ParamValue} }
    'agentUpdates.refreshDevice': { paramsTuple: [ParamValue,ParamValue]; params: {'kind': ParamValue,'id': ParamValue} }
    'agentUpdates.preflightDevice': { paramsTuple: [ParamValue,ParamValue]; params: {'kind': ParamValue,'id': ParamValue} }
    'agentUpdates.updateDeviceVersion': { paramsTuple: [ParamValue,ParamValue]; params: {'kind': ParamValue,'id': ParamValue} }
    'agentUpdates.rollbackDevice': { paramsTuple: [ParamValue,ParamValue]; params: {'kind': ParamValue,'id': ParamValue} }
    'agentUpdates.abortJob': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'agentUpdates.checkReleases': { paramsTuple?: []; params?: {} }
    'agentUpdates.storeRelease': { paramsTuple?: []; params?: {} }
    'agentUpdates.uploadReleaseFile': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'file': ParamValue} }
    'agentUpdates.updateRelease': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'agentUpdates.destroyRelease': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'agentUpdates.storeRollout': { paramsTuple?: []; params?: {} }
    'agentUpdates.pauseRollout': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'agentUpdates.resumeRollout': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'agentUpdates.cancelRollout': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'settings.agentUpdates': { paramsTuple?: []; params?: {} }
    'settings.updateAgentUpdates': { paramsTuple?: []; params?: {} }
    'setup.status': { paramsTuple?: []; params?: {} }
    'setup.admin': { paramsTuple?: []; params?: {} }
    'setup.login': { paramsTuple?: []; params?: {} }
    'setup.instance': { paramsTuple?: []; params?: {} }
    'setup.collector': { paramsTuple?: []; params?: {} }
    'setup.collector.candidates': { paramsTuple?: []; params?: {} }
    'setup.collector.skip': { paramsTuple?: []; params?: {} }
    'setup.collector.adopt': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'version': { paramsTuple?: []; params?: {} }
    'collectors.announce': { paramsTuple?: []; params?: {} }
    'apAgent.join': { paramsTuple?: []; params?: {} }
    'apAgent.wsFallback': { paramsTuple?: []; params?: {} }
    'collectorAgent.wsFallback': { paramsTuple?: []; params?: {} }
    'auth.new_account.store': { paramsTuple?: []; params?: {} }
    'auth.access_tokens.store': { paramsTuple?: []; params?: {} }
    'profile.profile.show': { paramsTuple?: []; params?: {} }
    'profile.profile.change_password': { paramsTuple?: []; params?: {} }
    'profile.access_tokens.destroy': { paramsTuple?: []; params?: {} }
    'settings.settings.hostname_enrichment': { paramsTuple?: []; params?: {} }
    'settings.settings.update_hostname_enrichment': { paramsTuple?: []; params?: {} }
    'settings.settings.hostname_enrichment_sources': { paramsTuple?: []; params?: {} }
    'settings.presence': { paramsTuple?: []; params?: {} }
    'settings.updatePresence': { paramsTuple?: []; params?: {} }
    'settings.gateway': { paramsTuple?: []; params?: {} }
    'settings.updateGateway': { paramsTuple?: []; params?: {} }
    'settings.gatewayObservations': { paramsTuple?: []; params?: {} }
    'settings.updateGatewayObservations': { paramsTuple?: []; params?: {} }
    'settings.qos': { paramsTuple?: []; params?: {} }
    'settings.updateQos': { paramsTuple?: []; params?: {} }
    'settings.charts': { paramsTuple?: []; params?: {} }
    'settings.updateCharts': { paramsTuple?: []; params?: {} }
    'settings.settings.wifi_sources': { paramsTuple?: []; params?: {} }
    'settings.settings.probe_wifi_source_draft': { paramsTuple?: []; params?: {} }
    'settings.settings.create_wifi_source': { paramsTuple?: []; params?: {} }
    'settings.settings.update_wifi_source': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'settings.settings.delete_wifi_source': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'settings.settings.probe_wifi_source': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'settings.wifiSources.agentPing': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'settings.wifiSources.agentForget': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'settings.apJoinTokens.index': { paramsTuple?: []; params?: {} }
    'settings.apJoinTokens.store': { paramsTuple?: []; params?: {} }
    'settings.apJoinTokens.reveal': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'settings.apJoinTokens.destroy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'settings.apAgent.install': { paramsTuple?: []; params?: {} }
    'settings.collectors.index': { paramsTuple?: []; params?: {} }
    'settings.collectors.store': { paramsTuple?: []; params?: {} }
    'settings.collectors.discovery': { paramsTuple?: []; params?: {} }
    'settings.collectors.updateDiscovery': { paramsTuple?: []; params?: {} }
    'settings.collectors.probeDraft': { paramsTuple?: []; params?: {} }
    'settings.collectors.update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'settings.collectors.destroy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'settings.collectors.probe': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'settings.collectors.adopt': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'settings.collectors.dismiss': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'settings.deviceGroups': { paramsTuple?: []; params?: {} }
    'settings.updateDeviceGroups': { paramsTuple?: []; params?: {} }
    'settings.portal': { paramsTuple?: []; params?: {} }
    'settings.updatePortal': { paramsTuple?: []; params?: {} }
    'settings.users.index': { paramsTuple?: []; params?: {} }
    'settings.users.store': { paramsTuple?: []; params?: {} }
    'settings.users.updateRole': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'settings.users.destroy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'aggregateTraffic': { paramsTuple?: []; params?: {} }
    'topTraffic': { paramsTuple?: []; params?: {} }
    'aggregateProtocols': { paramsTuple?: []; params?: {} }
    'aggregateProtocolDevices': { paramsTuple: [ParamValue]; params: {'protocol': ParamValue} }
    'topPeers': { paramsTuple?: []; params?: {} }
    'services.index': { paramsTuple?: []; params?: {} }
    'services.traffic': { paramsTuple: [ParamValue]; params: {'serverName': ParamValue} }
    'router': { paramsTuple?: []; params?: {} }
    'collectors': { paramsTuple?: []; params?: {} }
    'usage.index': { paramsTuple?: []; params?: {} }
    'usage.intervals': { paramsTuple?: []; params?: {} }
    'destinations.index': { paramsTuple?: []; params?: {} }
    'destinations.traffic': { paramsTuple: [ParamValue]; params: {'serverName': ParamValue} }
    'devices.index': { paramsTuple?: []; params?: {} }
    'devices.labels': { paramsTuple?: []; params?: {} }
    'devices.label': { paramsTuple: [ParamValue]; params: {'mac': ParamValue} }
    'devices.updateLabel': { paramsTuple: [ParamValue]; params: {'mac': ParamValue} }
    'devices.destroyLabel': { paramsTuple: [ParamValue]; params: {'mac': ParamValue} }
    'devices.traffic': { paramsTuple: [ParamValue]; params: {'mac': ParamValue} }
    'devices.peers': { paramsTuple: [ParamValue]; params: {'mac': ParamValue} }
    'devices.peersHistory': { paramsTuple: [ParamValue]; params: {'mac': ParamValue} }
    'devices.services': { paramsTuple: [ParamValue]; params: {'mac': ParamValue} }
    'devices.destinations': { paramsTuple: [ParamValue]; params: {'mac': ParamValue} }
    'devices.overview': { paramsTuple: [ParamValue]; params: {'mac': ParamValue} }
    'devices.presence': { paramsTuple: [ParamValue]; params: {'mac': ParamValue} }
    'devices.shaping': { paramsTuple: [ParamValue]; params: {'mac': ParamValue} }
    'devices.protocols': { paramsTuple: [ParamValue]; params: {'mac': ParamValue} }
    'devices.network': { paramsTuple: [ParamValue]; params: {'mac': ParamValue} }
    'devices.networks': { paramsTuple: [ParamValue]; params: {'mac': ParamValue} }
    'devices.reservation': { paramsTuple: [ParamValue]; params: {'mac': ParamValue} }
    'devices.wanAccess': { paramsTuple: [ParamValue]; params: {'mac': ParamValue} }
    'devices.group': { paramsTuple: [ParamValue]; params: {'mac': ParamValue} }
    'devices.putWanAccess': { paramsTuple: [ParamValue]; params: {'mac': ParamValue} }
    'devices.putReservation': { paramsTuple: [ParamValue]; params: {'mac': ParamValue} }
    'devices.deleteReservation': { paramsTuple: [ParamValue]; params: {'mac': ParamValue} }
    'wifi.wifi.overview': { paramsTuple?: []; params?: {} }
    'wifi.wifi.ssids': { paramsTuple?: []; params?: {} }
    'wifi.wifi.ssid_clients': { paramsTuple: [ParamValue]; params: {'ssid': ParamValue} }
    'wifi.wifi.ssid_throughput': { paramsTuple: [ParamValue]; params: {'ssid': ParamValue} }
    'wifi.wifi.clients': { paramsTuple?: []; params?: {} }
    'wifi.wifi.clients_history': { paramsTuple?: []; params?: {} }
    'wifi.wifi.client': { paramsTuple: [ParamValue]; params: {'mac': ParamValue} }
    'wifi.wifi.client_signal': { paramsTuple: [ParamValue]; params: {'mac': ParamValue} }
    'wifi.wifi.rf': { paramsTuple?: []; params?: {} }
    'wifi.wifi.rf_history': { paramsTuple?: []; params?: {} }
    'wifi.wifi.aps': { paramsTuple?: []; params?: {} }
    'wifi.wifi.aps_throughput': { paramsTuple?: []; params?: {} }
    'wifi.wifi.ap_health': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'wifi.wifi.kick_client': { paramsTuple: [ParamValue]; params: {'mac': ParamValue} }
    'wifi.wifi.steer_client': { paramsTuple: [ParamValue]; params: {'mac': ParamValue} }
    'wifi.wifi.reboot_ap': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'wifi.wifi.locate_ap': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'infra.layout': { paramsTuple?: []; params?: {} }
    'infra.state': { paramsTuple?: []; params?: {} }
    'infra.ports.traffic': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'infra.links.traffic': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'infra.nodes.traffic': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'infra.nodes.store': { paramsTuple?: []; params?: {} }
    'infra.nodes.update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'infra.nodes.destroy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'infra.nodes.bind': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'infra.nodes.ports.store': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'infra.ports.update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'infra.ports.destroy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'infra.links.store': { paramsTuple?: []; params?: {} }
    'infra.links.update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'infra.links.destroy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'infra.positions': { paramsTuple?: []; params?: {} }
    'gatewayObservations.gateway_observations.overview': { paramsTuple: [ParamValue]; params: {'gatewayId': ParamValue} }
    'gatewayObservations.gateway_observations.leases': { paramsTuple: [ParamValue]; params: {'gatewayId': ParamValue} }
    'gatewayObservations.gateway_observations.neighbors': { paramsTuple: [ParamValue]; params: {'gatewayId': ParamValue} }
    'gatewayObservations.gateway_observations.interfaces': { paramsTuple: [ParamValue]; params: {'gatewayId': ParamValue} }
    'gatewayObservations.gateway_observations.upnp': { paramsTuple: [ParamValue]; params: {'gatewayId': ParamValue} }
    'gatewayObservations.gateway_observations.wan_status': { paramsTuple: [ParamValue]; params: {'gatewayId': ParamValue} }
    'gatewayObservations.gateway_observations.system': { paramsTuple: [ParamValue]; params: {'gatewayId': ParamValue} }
    'gatewayObservations.gateway_observations.wireguard': { paramsTuple: [ParamValue]; params: {'gatewayId': ParamValue} }
    'gatewayObservations.gateway_observations.observe': { paramsTuple: [ParamValue]; params: {'gatewayId': ParamValue} }
    'gatewayObservations.gateway_observations.backups': { paramsTuple: [ParamValue]; params: {'gatewayId': ParamValue} }
    'gatewayObservations.gateway_observations.create_backup': { paramsTuple: [ParamValue]; params: {'gatewayId': ParamValue} }
    'gatewayObservations.gateway_observations.download_backup': { paramsTuple: [ParamValue,ParamValue]; params: {'gatewayId': ParamValue,'backupId': ParamValue} }
    'portal.authorizations.store': { paramsTuple?: []; params?: {} }
    'portal.authorizations.show': { paramsTuple: [ParamValue]; params: {'mac': ParamValue} }
    'portal.authorizations.destroy': { paramsTuple: [ParamValue]; params: {'mac': ParamValue} }
    'portal.portals.index': { paramsTuple?: []; params?: {} }
    'portal.portals.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'portal.grants.index': { paramsTuple?: []; params?: {} }
    'portal.sessions.index': { paramsTuple?: []; params?: {} }
    'portal.priceTables.index': { paramsTuple?: []; params?: {} }
    'portal.priceTables.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'portal.priceTables.quote': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'portal.terminals.index': { paramsTuple?: []; params?: {} }
    'portal.terminals.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'portal.checkouts.index': { paramsTuple?: []; params?: {} }
    'portal.checkouts.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'portal.portals.store': { paramsTuple?: []; params?: {} }
    'portal.portals.update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'portal.portals.destroy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'portal.gateways.rotateKey': { paramsTuple: [ParamValue]; params: {'gatewayId': ParamValue} }
    'portal.grants.extend': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'portal.grants.revoke': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'portal.templates.index': { paramsTuple?: []; params?: {} }
    'portal.templates.store': { paramsTuple?: []; params?: {} }
    'portal.templates.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'portal.templates.update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'portal.templates.destroy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'portal.templates.duplicate': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'portal.templates.preview': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'portal.templates.files.put': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'name': ParamValue} }
    'portal.templates.files.destroy': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'name': ParamValue} }
    'portal.voucherBatches.store': { paramsTuple?: []; params?: {} }
    'portal.voucherBatches.index': { paramsTuple?: []; params?: {} }
    'portal.voucherBatches.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'portal.voucherBatches.codes': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'portal.voucherBatches.csv': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'portal.voucherBatches.revoke': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'portal.voucherBatches.destroy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'portal.vouchers.index': { paramsTuple?: []; params?: {} }
    'portal.vouchers.lookup': { paramsTuple?: []; params?: {} }
    'portal.vouchers.revoke': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'portal.users.index': { paramsTuple?: []; params?: {} }
    'portal.users.store': { paramsTuple?: []; params?: {} }
    'portal.users.update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'portal.users.password': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'portal.users.destroy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'portal.apiClients.index': { paramsTuple?: []; params?: {} }
    'portal.apiClients.store': { paramsTuple?: []; params?: {} }
    'portal.apiClients.update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'portal.apiClients.rotate': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'portal.apiClients.destroy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'portal.priceTables.store': { paramsTuple?: []; params?: {} }
    'portal.priceTables.update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'portal.priceTables.destroy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'portal.terminals.store': { paramsTuple?: []; params?: {} }
    'portal.terminals.update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'portal.terminals.rotate': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'portal.terminals.destroy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'portal.checkouts.void': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'portal.checkouts.credit': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'portal.checkouts.dismiss': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'deviceGroups.index': { paramsTuple?: []; params?: {} }
    'deviceGroups.aps': { paramsTuple?: []; params?: {} }
    'deviceGroups.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'deviceGroups.store': { paramsTuple?: []; params?: {} }
    'deviceGroups.aps.update': { paramsTuple: [ParamValue]; params: {'apId': ParamValue} }
    'deviceGroups.update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'deviceGroups.destroy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'deviceGroups.members.store': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'deviceGroups.members.destroy': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'mac': ParamValue} }
    'deviceGroups.keys.store': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'deviceGroups.keys.reveal': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'keyId': ParamValue} }
    'deviceGroups.keys.destroy': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'keyId': ParamValue} }
    'qos.overview': { paramsTuple?: []; params?: {} }
    'qos.devices.index': { paramsTuple?: []; params?: {} }
    'qos.wanQueues.index': { paramsTuple?: []; params?: {} }
    'qos.policies.index': { paramsTuple?: []; params?: {} }
    'qos.groups.index': { paramsTuple?: []; params?: {} }
    'qos.assignments.index': { paramsTuple?: []; params?: {} }
    'qos.schedules.index': { paramsTuple?: []; params?: {} }
    'qos.wanQueues.store': { paramsTuple?: []; params?: {} }
    'qos.wanQueues.update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'qos.wanQueues.destroy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'qos.policies.store': { paramsTuple?: []; params?: {} }
    'qos.policies.update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'qos.policies.destroy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'qos.groups.store': { paramsTuple?: []; params?: {} }
    'qos.groups.update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'qos.groups.destroy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'qos.assignments.store': { paramsTuple?: []; params?: {} }
    'qos.assignments.update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'qos.assignments.destroy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'qos.schedules.store': { paramsTuple?: []; params?: {} }
    'qos.schedules.update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'qos.schedules.destroy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'qos.assignments.resetQuota': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'qos.pause': { paramsTuple?: []; params?: {} }
    'qos.resume': { paramsTuple?: []; params?: {} }
    'networks.index': { paramsTuple?: []; params?: {} }
    'networks.scopeChanges': { paramsTuple?: []; params?: {} }
    'gateways.index': { paramsTuple?: []; params?: {} }
    'gateways.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.syncStatus': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.sections': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.section': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'perchId': ParamValue} }
    'gateways.draft': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.applies': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.apply': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'applyId': ParamValue} }
    'gateways.revisions': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.revision': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'number': ParamValue} }
    'gateways.events': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.pairing': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.dns': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.labelNames': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.networks': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.networkHistory': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.network': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'networkId': ParamValue} }
    'gateways.createNetwork': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.updateNetwork': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'networkId': ParamValue} }
    'gateways.deleteNetwork': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'networkId': ParamValue} }
    'gateways.update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.bind': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.refresh': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.updateSection': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'perchId': ParamValue} }
    'gateways.resolve': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.discardDraft': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.createApply': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.installPackages': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.setSignKey': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.startPairing': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.confirmPairing': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.unpair': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.clearSignKey': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.confirmApply': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'applyId': ParamValue} }
    'gateways.revertApply': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'applyId': ParamValue} }
    'gateways.restoreRevision': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'number': ParamValue} }
    'gateways.dismissRejoin': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.acceptDrift': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.revertDrift': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.resumeEnforcement': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.updateDns': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.createRecord': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.updateRecord': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'perchId': ParamValue} }
    'gateways.deleteRecord': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'perchId': ParamValue} }
    'gateways.applyLabelNames': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.dhcp': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.updateDhcpPool': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'network': ParamValue} }
    'gateways.createDhcpTag': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.updateDhcpTag': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'perchId': ParamValue} }
    'gateways.deleteDhcpTag': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'perchId': ParamValue} }
    'gateways.updateDhcpReservation': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'perchId': ParamValue} }
    'gateways.routing': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.createRoute': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.updateRoute': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'perchId': ParamValue} }
    'gateways.deleteRoute': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'perchId': ParamValue} }
    'gateways.updateSystem': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.firewall': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.orderFirewallRules': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.orderPortForwards': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.resolveFirewallOrder': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.createPortForward': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.updatePortForward': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'perchId': ParamValue} }
    'gateways.deletePortForward': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'perchId': ParamValue} }
    'gateways.createFirewallRule': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.updateFirewallRule': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'perchId': ParamValue} }
    'gateways.deleteFirewallRule': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'perchId': ParamValue} }
    'wifiConfig.overview': { paramsTuple?: []; params?: {} }
    'wifiConfig.aps.index': { paramsTuple?: []; params?: {} }
    'wifiConfig.aps.show': { paramsTuple: [ParamValue]; params: {'apId': ParamValue} }
    'wifiConfig.aps.health': { paramsTuple: [ParamValue]; params: {'apId': ParamValue} }
    'wifiConfig.aps.syncStatus': { paramsTuple: [ParamValue]; params: {'apId': ParamValue} }
    'wifiConfig.aps.sections': { paramsTuple: [ParamValue]; params: {'apId': ParamValue} }
    'wifiConfig.aps.section': { paramsTuple: [ParamValue,ParamValue]; params: {'apId': ParamValue,'perchId': ParamValue} }
    'wifiConfig.aps.draft': { paramsTuple: [ParamValue]; params: {'apId': ParamValue} }
    'wifiConfig.aps.applies': { paramsTuple: [ParamValue]; params: {'apId': ParamValue} }
    'wifiConfig.aps.apply': { paramsTuple: [ParamValue,ParamValue]; params: {'apId': ParamValue,'applyId': ParamValue} }
    'wifiConfig.aps.revisions': { paramsTuple: [ParamValue]; params: {'apId': ParamValue} }
    'wifiConfig.aps.revision': { paramsTuple: [ParamValue,ParamValue]; params: {'apId': ParamValue,'number': ParamValue} }
    'wifiConfig.aps.events': { paramsTuple: [ParamValue]; params: {'apId': ParamValue} }
    'wifiConfig.aps.pairing': { paramsTuple: [ParamValue]; params: {'apId': ParamValue} }
    'wifiConfig.aps.update': { paramsTuple: [ParamValue]; params: {'apId': ParamValue} }
    'wifiConfig.aps.refresh': { paramsTuple: [ParamValue]; params: {'apId': ParamValue} }
    'wifiConfig.aps.rejoin': { paramsTuple: [ParamValue]; params: {'apId': ParamValue} }
    'wifiConfig.aps.dismissRejoin': { paramsTuple: [ParamValue]; params: {'apId': ParamValue} }
    'wifiConfig.aps.updateSection': { paramsTuple: [ParamValue,ParamValue]; params: {'apId': ParamValue,'perchId': ParamValue} }
    'wifiConfig.aps.resolve': { paramsTuple: [ParamValue]; params: {'apId': ParamValue} }
    'wifiConfig.aps.discardDraft': { paramsTuple: [ParamValue]; params: {'apId': ParamValue} }
    'wifiConfig.aps.confirmApply': { paramsTuple: [ParamValue,ParamValue]; params: {'apId': ParamValue,'applyId': ParamValue} }
    'wifiConfig.aps.revertApply': { paramsTuple: [ParamValue,ParamValue]; params: {'apId': ParamValue,'applyId': ParamValue} }
    'wifiConfig.aps.restoreRevision': { paramsTuple: [ParamValue,ParamValue]; params: {'apId': ParamValue,'number': ParamValue} }
    'wifiConfig.aps.acceptDrift': { paramsTuple: [ParamValue]; params: {'apId': ParamValue} }
    'wifiConfig.aps.revertDrift': { paramsTuple: [ParamValue]; params: {'apId': ParamValue} }
    'wifiConfig.aps.resumeEnforcement': { paramsTuple: [ParamValue]; params: {'apId': ParamValue} }
    'wifiConfig.aps.startPairing': { paramsTuple: [ParamValue]; params: {'apId': ParamValue} }
    'wifiConfig.aps.confirmPairing': { paramsTuple: [ParamValue]; params: {'apId': ParamValue} }
    'wifiConfig.aps.unpair': { paramsTuple: [ParamValue]; params: {'apId': ParamValue} }
    'wifiConfig.aps.updateRadio': { paramsTuple: [ParamValue,ParamValue]; params: {'apId': ParamValue,'section': ParamValue} }
    'wifiConfig.radios.index': { paramsTuple?: []; params?: {} }
    'wifiConfig.networks.index': { paramsTuple?: []; params?: {} }
    'wifiConfig.networks.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'wifiConfig.networks.store': { paramsTuple?: []; params?: {} }
    'wifiConfig.networks.update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'wifiConfig.networks.destroy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'wifiConfig.networks.setPassphrase': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'wifiConfig.networks.revealPassphrase': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'wifiConfig.networks.putAp': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'apId': ParamValue} }
    'wifiConfig.networks.resetAp': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'apId': ParamValue} }
    'wifiConfig.divergences.index': { paramsTuple?: []; params?: {} }
    'wifiConfig.adoption.show': { paramsTuple?: []; params?: {} }
    'wifiConfig.divergences.resolve': { paramsTuple?: []; params?: {} }
    'wifiConfig.adoption.accept': { paramsTuple?: []; params?: {} }
    'wifiConfig.rollouts.index': { paramsTuple?: []; params?: {} }
    'wifiConfig.rollouts.current': { paramsTuple?: []; params?: {} }
    'wifiConfig.rollouts.show': { paramsTuple: [ParamValue]; params: {'rolloutId': ParamValue} }
    'wifiConfig.rollouts.preview': { paramsTuple?: []; params?: {} }
    'wifiConfig.rollouts.store': { paramsTuple?: []; params?: {} }
    'wifiConfig.rollouts.action': { paramsTuple: [ParamValue,ParamValue]; params: {'rolloutId': ParamValue,'action': ParamValue} }
    'wifiConfigSettings.show': { paramsTuple?: []; params?: {} }
    'wifiConfigSettings.update': { paramsTuple?: []; params?: {} }
  }
  GET: {
    'gatewaySync.wan': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gatewaySync.wanHistory': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gatewaySync.wanShow': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'perchId': ParamValue} }
    'gatewaySync.wireguardConfig': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gatewaySync.ipv6': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gatewaySync.ambiguities': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gatewaySync.firewallDefaults': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gatewaySync.upnpConfig': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gatewaySync.ddns': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gatewaySync.multiwan': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gatewaySyncSettings.show': { paramsTuple?: []; params?: {} }
    'alerts.summary': { paramsTuple?: []; params?: {} }
    'alerts.catalogue': { paramsTuple?: []; params?: {} }
    'alerts.mutes.index': { paramsTuple?: []; params?: {} }
    'alerts.watches.index': { paramsTuple?: []; params?: {} }
    'alerts.push.config': { paramsTuple?: []; params?: {} }
    'alerts.push.index': { paramsTuple?: []; params?: {} }
    'alerts.index': { paramsTuple?: []; params?: {} }
    'alerts.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'alerts.deliveries.index': { paramsTuple?: []; params?: {} }
    'alerts.deliveries.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'settings.alerts.show': { paramsTuple?: []; params?: {} }
    'settings.alerts.webhooks.index': { paramsTuple?: []; params?: {} }
    'settings.alerts.webhooks.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'agentUpdates.download': { paramsTuple: [ParamValue,ParamValue]; params: {'artefactId': ParamValue,'file': ParamValue} }
    'agentUpdates.fleet': { paramsTuple?: []; params?: {} }
    'agentUpdates.jobs': { paramsTuple?: []; params?: {} }
    'agentUpdates.job': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'agentUpdates.events': { paramsTuple?: []; params?: {} }
    'agentUpdates.releases': { paramsTuple?: []; params?: {} }
    'agentUpdates.release': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'agentUpdates.rollouts': { paramsTuple?: []; params?: {} }
    'agentUpdates.rollout': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'settings.agentUpdates': { paramsTuple?: []; params?: {} }
    'setup.status': { paramsTuple?: []; params?: {} }
    'setup.collector.candidates': { paramsTuple?: []; params?: {} }
    'version': { paramsTuple?: []; params?: {} }
    'apAgent.wsFallback': { paramsTuple?: []; params?: {} }
    'collectorAgent.wsFallback': { paramsTuple?: []; params?: {} }
    'profile.profile.show': { paramsTuple?: []; params?: {} }
    'settings.settings.hostname_enrichment': { paramsTuple?: []; params?: {} }
    'settings.settings.hostname_enrichment_sources': { paramsTuple?: []; params?: {} }
    'settings.presence': { paramsTuple?: []; params?: {} }
    'settings.gateway': { paramsTuple?: []; params?: {} }
    'settings.gatewayObservations': { paramsTuple?: []; params?: {} }
    'settings.qos': { paramsTuple?: []; params?: {} }
    'settings.charts': { paramsTuple?: []; params?: {} }
    'settings.settings.wifi_sources': { paramsTuple?: []; params?: {} }
    'settings.apJoinTokens.index': { paramsTuple?: []; params?: {} }
    'settings.apAgent.install': { paramsTuple?: []; params?: {} }
    'settings.collectors.index': { paramsTuple?: []; params?: {} }
    'settings.collectors.discovery': { paramsTuple?: []; params?: {} }
    'settings.deviceGroups': { paramsTuple?: []; params?: {} }
    'settings.portal': { paramsTuple?: []; params?: {} }
    'settings.users.index': { paramsTuple?: []; params?: {} }
    'aggregateTraffic': { paramsTuple?: []; params?: {} }
    'topTraffic': { paramsTuple?: []; params?: {} }
    'aggregateProtocols': { paramsTuple?: []; params?: {} }
    'aggregateProtocolDevices': { paramsTuple: [ParamValue]; params: {'protocol': ParamValue} }
    'topPeers': { paramsTuple?: []; params?: {} }
    'services.index': { paramsTuple?: []; params?: {} }
    'services.traffic': { paramsTuple: [ParamValue]; params: {'serverName': ParamValue} }
    'router': { paramsTuple?: []; params?: {} }
    'collectors': { paramsTuple?: []; params?: {} }
    'usage.index': { paramsTuple?: []; params?: {} }
    'usage.intervals': { paramsTuple?: []; params?: {} }
    'destinations.index': { paramsTuple?: []; params?: {} }
    'destinations.traffic': { paramsTuple: [ParamValue]; params: {'serverName': ParamValue} }
    'devices.index': { paramsTuple?: []; params?: {} }
    'devices.labels': { paramsTuple?: []; params?: {} }
    'devices.label': { paramsTuple: [ParamValue]; params: {'mac': ParamValue} }
    'devices.traffic': { paramsTuple: [ParamValue]; params: {'mac': ParamValue} }
    'devices.peers': { paramsTuple: [ParamValue]; params: {'mac': ParamValue} }
    'devices.peersHistory': { paramsTuple: [ParamValue]; params: {'mac': ParamValue} }
    'devices.services': { paramsTuple: [ParamValue]; params: {'mac': ParamValue} }
    'devices.destinations': { paramsTuple: [ParamValue]; params: {'mac': ParamValue} }
    'devices.overview': { paramsTuple: [ParamValue]; params: {'mac': ParamValue} }
    'devices.presence': { paramsTuple: [ParamValue]; params: {'mac': ParamValue} }
    'devices.shaping': { paramsTuple: [ParamValue]; params: {'mac': ParamValue} }
    'devices.protocols': { paramsTuple: [ParamValue]; params: {'mac': ParamValue} }
    'devices.network': { paramsTuple: [ParamValue]; params: {'mac': ParamValue} }
    'devices.networks': { paramsTuple: [ParamValue]; params: {'mac': ParamValue} }
    'devices.reservation': { paramsTuple: [ParamValue]; params: {'mac': ParamValue} }
    'devices.wanAccess': { paramsTuple: [ParamValue]; params: {'mac': ParamValue} }
    'devices.group': { paramsTuple: [ParamValue]; params: {'mac': ParamValue} }
    'wifi.wifi.overview': { paramsTuple?: []; params?: {} }
    'wifi.wifi.ssids': { paramsTuple?: []; params?: {} }
    'wifi.wifi.ssid_clients': { paramsTuple: [ParamValue]; params: {'ssid': ParamValue} }
    'wifi.wifi.ssid_throughput': { paramsTuple: [ParamValue]; params: {'ssid': ParamValue} }
    'wifi.wifi.clients': { paramsTuple?: []; params?: {} }
    'wifi.wifi.clients_history': { paramsTuple?: []; params?: {} }
    'wifi.wifi.client': { paramsTuple: [ParamValue]; params: {'mac': ParamValue} }
    'wifi.wifi.client_signal': { paramsTuple: [ParamValue]; params: {'mac': ParamValue} }
    'wifi.wifi.rf': { paramsTuple?: []; params?: {} }
    'wifi.wifi.rf_history': { paramsTuple?: []; params?: {} }
    'wifi.wifi.aps': { paramsTuple?: []; params?: {} }
    'wifi.wifi.aps_throughput': { paramsTuple?: []; params?: {} }
    'wifi.wifi.ap_health': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'infra.layout': { paramsTuple?: []; params?: {} }
    'infra.state': { paramsTuple?: []; params?: {} }
    'infra.ports.traffic': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'infra.links.traffic': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'infra.nodes.traffic': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gatewayObservations.gateway_observations.overview': { paramsTuple: [ParamValue]; params: {'gatewayId': ParamValue} }
    'gatewayObservations.gateway_observations.leases': { paramsTuple: [ParamValue]; params: {'gatewayId': ParamValue} }
    'gatewayObservations.gateway_observations.neighbors': { paramsTuple: [ParamValue]; params: {'gatewayId': ParamValue} }
    'gatewayObservations.gateway_observations.interfaces': { paramsTuple: [ParamValue]; params: {'gatewayId': ParamValue} }
    'gatewayObservations.gateway_observations.upnp': { paramsTuple: [ParamValue]; params: {'gatewayId': ParamValue} }
    'gatewayObservations.gateway_observations.wan_status': { paramsTuple: [ParamValue]; params: {'gatewayId': ParamValue} }
    'gatewayObservations.gateway_observations.system': { paramsTuple: [ParamValue]; params: {'gatewayId': ParamValue} }
    'gatewayObservations.gateway_observations.wireguard': { paramsTuple: [ParamValue]; params: {'gatewayId': ParamValue} }
    'gatewayObservations.gateway_observations.backups': { paramsTuple: [ParamValue]; params: {'gatewayId': ParamValue} }
    'gatewayObservations.gateway_observations.download_backup': { paramsTuple: [ParamValue,ParamValue]; params: {'gatewayId': ParamValue,'backupId': ParamValue} }
    'portal.authorizations.show': { paramsTuple: [ParamValue]; params: {'mac': ParamValue} }
    'portal.portals.index': { paramsTuple?: []; params?: {} }
    'portal.portals.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'portal.grants.index': { paramsTuple?: []; params?: {} }
    'portal.sessions.index': { paramsTuple?: []; params?: {} }
    'portal.priceTables.index': { paramsTuple?: []; params?: {} }
    'portal.priceTables.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'portal.terminals.index': { paramsTuple?: []; params?: {} }
    'portal.terminals.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'portal.checkouts.index': { paramsTuple?: []; params?: {} }
    'portal.checkouts.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'portal.templates.index': { paramsTuple?: []; params?: {} }
    'portal.templates.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'portal.templates.preview': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'portal.voucherBatches.index': { paramsTuple?: []; params?: {} }
    'portal.voucherBatches.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'portal.voucherBatches.codes': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'portal.voucherBatches.csv': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'portal.vouchers.index': { paramsTuple?: []; params?: {} }
    'portal.users.index': { paramsTuple?: []; params?: {} }
    'portal.apiClients.index': { paramsTuple?: []; params?: {} }
    'deviceGroups.index': { paramsTuple?: []; params?: {} }
    'deviceGroups.aps': { paramsTuple?: []; params?: {} }
    'deviceGroups.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'deviceGroups.keys.reveal': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'keyId': ParamValue} }
    'qos.overview': { paramsTuple?: []; params?: {} }
    'qos.devices.index': { paramsTuple?: []; params?: {} }
    'qos.wanQueues.index': { paramsTuple?: []; params?: {} }
    'qos.policies.index': { paramsTuple?: []; params?: {} }
    'qos.groups.index': { paramsTuple?: []; params?: {} }
    'qos.assignments.index': { paramsTuple?: []; params?: {} }
    'qos.schedules.index': { paramsTuple?: []; params?: {} }
    'networks.index': { paramsTuple?: []; params?: {} }
    'networks.scopeChanges': { paramsTuple?: []; params?: {} }
    'gateways.index': { paramsTuple?: []; params?: {} }
    'gateways.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.syncStatus': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.sections': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.section': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'perchId': ParamValue} }
    'gateways.draft': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.applies': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.apply': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'applyId': ParamValue} }
    'gateways.revisions': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.revision': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'number': ParamValue} }
    'gateways.events': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.pairing': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.dns': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.labelNames': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.networks': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.networkHistory': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.network': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'networkId': ParamValue} }
    'gateways.dhcp': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.routing': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.firewall': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'wifiConfig.overview': { paramsTuple?: []; params?: {} }
    'wifiConfig.aps.index': { paramsTuple?: []; params?: {} }
    'wifiConfig.aps.show': { paramsTuple: [ParamValue]; params: {'apId': ParamValue} }
    'wifiConfig.aps.health': { paramsTuple: [ParamValue]; params: {'apId': ParamValue} }
    'wifiConfig.aps.syncStatus': { paramsTuple: [ParamValue]; params: {'apId': ParamValue} }
    'wifiConfig.aps.sections': { paramsTuple: [ParamValue]; params: {'apId': ParamValue} }
    'wifiConfig.aps.section': { paramsTuple: [ParamValue,ParamValue]; params: {'apId': ParamValue,'perchId': ParamValue} }
    'wifiConfig.aps.draft': { paramsTuple: [ParamValue]; params: {'apId': ParamValue} }
    'wifiConfig.aps.applies': { paramsTuple: [ParamValue]; params: {'apId': ParamValue} }
    'wifiConfig.aps.apply': { paramsTuple: [ParamValue,ParamValue]; params: {'apId': ParamValue,'applyId': ParamValue} }
    'wifiConfig.aps.revisions': { paramsTuple: [ParamValue]; params: {'apId': ParamValue} }
    'wifiConfig.aps.revision': { paramsTuple: [ParamValue,ParamValue]; params: {'apId': ParamValue,'number': ParamValue} }
    'wifiConfig.aps.events': { paramsTuple: [ParamValue]; params: {'apId': ParamValue} }
    'wifiConfig.aps.pairing': { paramsTuple: [ParamValue]; params: {'apId': ParamValue} }
    'wifiConfig.radios.index': { paramsTuple?: []; params?: {} }
    'wifiConfig.networks.index': { paramsTuple?: []; params?: {} }
    'wifiConfig.networks.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'wifiConfig.networks.revealPassphrase': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'wifiConfig.divergences.index': { paramsTuple?: []; params?: {} }
    'wifiConfig.adoption.show': { paramsTuple?: []; params?: {} }
    'wifiConfig.rollouts.index': { paramsTuple?: []; params?: {} }
    'wifiConfig.rollouts.current': { paramsTuple?: []; params?: {} }
    'wifiConfig.rollouts.show': { paramsTuple: [ParamValue]; params: {'rolloutId': ParamValue} }
    'wifiConfigSettings.show': { paramsTuple?: []; params?: {} }
  }
  HEAD: {
    'gatewaySync.wan': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gatewaySync.wanHistory': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gatewaySync.wanShow': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'perchId': ParamValue} }
    'gatewaySync.wireguardConfig': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gatewaySync.ipv6': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gatewaySync.ambiguities': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gatewaySync.firewallDefaults': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gatewaySync.upnpConfig': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gatewaySync.ddns': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gatewaySync.multiwan': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gatewaySyncSettings.show': { paramsTuple?: []; params?: {} }
    'alerts.summary': { paramsTuple?: []; params?: {} }
    'alerts.catalogue': { paramsTuple?: []; params?: {} }
    'alerts.mutes.index': { paramsTuple?: []; params?: {} }
    'alerts.watches.index': { paramsTuple?: []; params?: {} }
    'alerts.push.config': { paramsTuple?: []; params?: {} }
    'alerts.push.index': { paramsTuple?: []; params?: {} }
    'alerts.index': { paramsTuple?: []; params?: {} }
    'alerts.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'alerts.deliveries.index': { paramsTuple?: []; params?: {} }
    'alerts.deliveries.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'settings.alerts.show': { paramsTuple?: []; params?: {} }
    'settings.alerts.webhooks.index': { paramsTuple?: []; params?: {} }
    'settings.alerts.webhooks.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'agentUpdates.download': { paramsTuple: [ParamValue,ParamValue]; params: {'artefactId': ParamValue,'file': ParamValue} }
    'agentUpdates.fleet': { paramsTuple?: []; params?: {} }
    'agentUpdates.jobs': { paramsTuple?: []; params?: {} }
    'agentUpdates.job': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'agentUpdates.events': { paramsTuple?: []; params?: {} }
    'agentUpdates.releases': { paramsTuple?: []; params?: {} }
    'agentUpdates.release': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'agentUpdates.rollouts': { paramsTuple?: []; params?: {} }
    'agentUpdates.rollout': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'settings.agentUpdates': { paramsTuple?: []; params?: {} }
    'setup.status': { paramsTuple?: []; params?: {} }
    'setup.collector.candidates': { paramsTuple?: []; params?: {} }
    'version': { paramsTuple?: []; params?: {} }
    'apAgent.wsFallback': { paramsTuple?: []; params?: {} }
    'collectorAgent.wsFallback': { paramsTuple?: []; params?: {} }
    'profile.profile.show': { paramsTuple?: []; params?: {} }
    'settings.settings.hostname_enrichment': { paramsTuple?: []; params?: {} }
    'settings.settings.hostname_enrichment_sources': { paramsTuple?: []; params?: {} }
    'settings.presence': { paramsTuple?: []; params?: {} }
    'settings.gateway': { paramsTuple?: []; params?: {} }
    'settings.gatewayObservations': { paramsTuple?: []; params?: {} }
    'settings.qos': { paramsTuple?: []; params?: {} }
    'settings.charts': { paramsTuple?: []; params?: {} }
    'settings.settings.wifi_sources': { paramsTuple?: []; params?: {} }
    'settings.apJoinTokens.index': { paramsTuple?: []; params?: {} }
    'settings.apAgent.install': { paramsTuple?: []; params?: {} }
    'settings.collectors.index': { paramsTuple?: []; params?: {} }
    'settings.collectors.discovery': { paramsTuple?: []; params?: {} }
    'settings.deviceGroups': { paramsTuple?: []; params?: {} }
    'settings.portal': { paramsTuple?: []; params?: {} }
    'settings.users.index': { paramsTuple?: []; params?: {} }
    'aggregateTraffic': { paramsTuple?: []; params?: {} }
    'topTraffic': { paramsTuple?: []; params?: {} }
    'aggregateProtocols': { paramsTuple?: []; params?: {} }
    'aggregateProtocolDevices': { paramsTuple: [ParamValue]; params: {'protocol': ParamValue} }
    'topPeers': { paramsTuple?: []; params?: {} }
    'services.index': { paramsTuple?: []; params?: {} }
    'services.traffic': { paramsTuple: [ParamValue]; params: {'serverName': ParamValue} }
    'router': { paramsTuple?: []; params?: {} }
    'collectors': { paramsTuple?: []; params?: {} }
    'usage.index': { paramsTuple?: []; params?: {} }
    'usage.intervals': { paramsTuple?: []; params?: {} }
    'destinations.index': { paramsTuple?: []; params?: {} }
    'destinations.traffic': { paramsTuple: [ParamValue]; params: {'serverName': ParamValue} }
    'devices.index': { paramsTuple?: []; params?: {} }
    'devices.labels': { paramsTuple?: []; params?: {} }
    'devices.label': { paramsTuple: [ParamValue]; params: {'mac': ParamValue} }
    'devices.traffic': { paramsTuple: [ParamValue]; params: {'mac': ParamValue} }
    'devices.peers': { paramsTuple: [ParamValue]; params: {'mac': ParamValue} }
    'devices.peersHistory': { paramsTuple: [ParamValue]; params: {'mac': ParamValue} }
    'devices.services': { paramsTuple: [ParamValue]; params: {'mac': ParamValue} }
    'devices.destinations': { paramsTuple: [ParamValue]; params: {'mac': ParamValue} }
    'devices.overview': { paramsTuple: [ParamValue]; params: {'mac': ParamValue} }
    'devices.presence': { paramsTuple: [ParamValue]; params: {'mac': ParamValue} }
    'devices.shaping': { paramsTuple: [ParamValue]; params: {'mac': ParamValue} }
    'devices.protocols': { paramsTuple: [ParamValue]; params: {'mac': ParamValue} }
    'devices.network': { paramsTuple: [ParamValue]; params: {'mac': ParamValue} }
    'devices.networks': { paramsTuple: [ParamValue]; params: {'mac': ParamValue} }
    'devices.reservation': { paramsTuple: [ParamValue]; params: {'mac': ParamValue} }
    'devices.wanAccess': { paramsTuple: [ParamValue]; params: {'mac': ParamValue} }
    'devices.group': { paramsTuple: [ParamValue]; params: {'mac': ParamValue} }
    'wifi.wifi.overview': { paramsTuple?: []; params?: {} }
    'wifi.wifi.ssids': { paramsTuple?: []; params?: {} }
    'wifi.wifi.ssid_clients': { paramsTuple: [ParamValue]; params: {'ssid': ParamValue} }
    'wifi.wifi.ssid_throughput': { paramsTuple: [ParamValue]; params: {'ssid': ParamValue} }
    'wifi.wifi.clients': { paramsTuple?: []; params?: {} }
    'wifi.wifi.clients_history': { paramsTuple?: []; params?: {} }
    'wifi.wifi.client': { paramsTuple: [ParamValue]; params: {'mac': ParamValue} }
    'wifi.wifi.client_signal': { paramsTuple: [ParamValue]; params: {'mac': ParamValue} }
    'wifi.wifi.rf': { paramsTuple?: []; params?: {} }
    'wifi.wifi.rf_history': { paramsTuple?: []; params?: {} }
    'wifi.wifi.aps': { paramsTuple?: []; params?: {} }
    'wifi.wifi.aps_throughput': { paramsTuple?: []; params?: {} }
    'wifi.wifi.ap_health': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'infra.layout': { paramsTuple?: []; params?: {} }
    'infra.state': { paramsTuple?: []; params?: {} }
    'infra.ports.traffic': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'infra.links.traffic': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'infra.nodes.traffic': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gatewayObservations.gateway_observations.overview': { paramsTuple: [ParamValue]; params: {'gatewayId': ParamValue} }
    'gatewayObservations.gateway_observations.leases': { paramsTuple: [ParamValue]; params: {'gatewayId': ParamValue} }
    'gatewayObservations.gateway_observations.neighbors': { paramsTuple: [ParamValue]; params: {'gatewayId': ParamValue} }
    'gatewayObservations.gateway_observations.interfaces': { paramsTuple: [ParamValue]; params: {'gatewayId': ParamValue} }
    'gatewayObservations.gateway_observations.upnp': { paramsTuple: [ParamValue]; params: {'gatewayId': ParamValue} }
    'gatewayObservations.gateway_observations.wan_status': { paramsTuple: [ParamValue]; params: {'gatewayId': ParamValue} }
    'gatewayObservations.gateway_observations.system': { paramsTuple: [ParamValue]; params: {'gatewayId': ParamValue} }
    'gatewayObservations.gateway_observations.wireguard': { paramsTuple: [ParamValue]; params: {'gatewayId': ParamValue} }
    'gatewayObservations.gateway_observations.backups': { paramsTuple: [ParamValue]; params: {'gatewayId': ParamValue} }
    'gatewayObservations.gateway_observations.download_backup': { paramsTuple: [ParamValue,ParamValue]; params: {'gatewayId': ParamValue,'backupId': ParamValue} }
    'portal.authorizations.show': { paramsTuple: [ParamValue]; params: {'mac': ParamValue} }
    'portal.portals.index': { paramsTuple?: []; params?: {} }
    'portal.portals.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'portal.grants.index': { paramsTuple?: []; params?: {} }
    'portal.sessions.index': { paramsTuple?: []; params?: {} }
    'portal.priceTables.index': { paramsTuple?: []; params?: {} }
    'portal.priceTables.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'portal.terminals.index': { paramsTuple?: []; params?: {} }
    'portal.terminals.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'portal.checkouts.index': { paramsTuple?: []; params?: {} }
    'portal.checkouts.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'portal.templates.index': { paramsTuple?: []; params?: {} }
    'portal.templates.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'portal.templates.preview': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'portal.voucherBatches.index': { paramsTuple?: []; params?: {} }
    'portal.voucherBatches.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'portal.voucherBatches.codes': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'portal.voucherBatches.csv': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'portal.vouchers.index': { paramsTuple?: []; params?: {} }
    'portal.users.index': { paramsTuple?: []; params?: {} }
    'portal.apiClients.index': { paramsTuple?: []; params?: {} }
    'deviceGroups.index': { paramsTuple?: []; params?: {} }
    'deviceGroups.aps': { paramsTuple?: []; params?: {} }
    'deviceGroups.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'deviceGroups.keys.reveal': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'keyId': ParamValue} }
    'qos.overview': { paramsTuple?: []; params?: {} }
    'qos.devices.index': { paramsTuple?: []; params?: {} }
    'qos.wanQueues.index': { paramsTuple?: []; params?: {} }
    'qos.policies.index': { paramsTuple?: []; params?: {} }
    'qos.groups.index': { paramsTuple?: []; params?: {} }
    'qos.assignments.index': { paramsTuple?: []; params?: {} }
    'qos.schedules.index': { paramsTuple?: []; params?: {} }
    'networks.index': { paramsTuple?: []; params?: {} }
    'networks.scopeChanges': { paramsTuple?: []; params?: {} }
    'gateways.index': { paramsTuple?: []; params?: {} }
    'gateways.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.syncStatus': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.sections': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.section': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'perchId': ParamValue} }
    'gateways.draft': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.applies': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.apply': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'applyId': ParamValue} }
    'gateways.revisions': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.revision': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'number': ParamValue} }
    'gateways.events': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.pairing': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.dns': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.labelNames': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.networks': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.networkHistory': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.network': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'networkId': ParamValue} }
    'gateways.dhcp': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.routing': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.firewall': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'wifiConfig.overview': { paramsTuple?: []; params?: {} }
    'wifiConfig.aps.index': { paramsTuple?: []; params?: {} }
    'wifiConfig.aps.show': { paramsTuple: [ParamValue]; params: {'apId': ParamValue} }
    'wifiConfig.aps.health': { paramsTuple: [ParamValue]; params: {'apId': ParamValue} }
    'wifiConfig.aps.syncStatus': { paramsTuple: [ParamValue]; params: {'apId': ParamValue} }
    'wifiConfig.aps.sections': { paramsTuple: [ParamValue]; params: {'apId': ParamValue} }
    'wifiConfig.aps.section': { paramsTuple: [ParamValue,ParamValue]; params: {'apId': ParamValue,'perchId': ParamValue} }
    'wifiConfig.aps.draft': { paramsTuple: [ParamValue]; params: {'apId': ParamValue} }
    'wifiConfig.aps.applies': { paramsTuple: [ParamValue]; params: {'apId': ParamValue} }
    'wifiConfig.aps.apply': { paramsTuple: [ParamValue,ParamValue]; params: {'apId': ParamValue,'applyId': ParamValue} }
    'wifiConfig.aps.revisions': { paramsTuple: [ParamValue]; params: {'apId': ParamValue} }
    'wifiConfig.aps.revision': { paramsTuple: [ParamValue,ParamValue]; params: {'apId': ParamValue,'number': ParamValue} }
    'wifiConfig.aps.events': { paramsTuple: [ParamValue]; params: {'apId': ParamValue} }
    'wifiConfig.aps.pairing': { paramsTuple: [ParamValue]; params: {'apId': ParamValue} }
    'wifiConfig.radios.index': { paramsTuple?: []; params?: {} }
    'wifiConfig.networks.index': { paramsTuple?: []; params?: {} }
    'wifiConfig.networks.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'wifiConfig.networks.revealPassphrase': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'wifiConfig.divergences.index': { paramsTuple?: []; params?: {} }
    'wifiConfig.adoption.show': { paramsTuple?: []; params?: {} }
    'wifiConfig.rollouts.index': { paramsTuple?: []; params?: {} }
    'wifiConfig.rollouts.current': { paramsTuple?: []; params?: {} }
    'wifiConfig.rollouts.show': { paramsTuple: [ParamValue]; params: {'rolloutId': ParamValue} }
    'wifiConfigSettings.show': { paramsTuple?: []; params?: {} }
  }
  PUT: {
    'gatewaySync.wanOrder': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gatewaySync.upnpAclOrder': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gatewaySync.upnpDeviceBlock': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'mac': ParamValue} }
    'alerts.watches.update': { paramsTuple: [ParamValue]; params: {'mac': ParamValue} }
    'agentUpdates.uploadReleaseFile': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'file': ParamValue} }
    'settings.settings.update_wifi_source': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'settings.collectors.update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'devices.putWanAccess': { paramsTuple: [ParamValue]; params: {'mac': ParamValue} }
    'devices.putReservation': { paramsTuple: [ParamValue]; params: {'mac': ParamValue} }
    'infra.positions': { paramsTuple?: []; params?: {} }
    'portal.templates.files.put': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'name': ParamValue} }
    'portal.users.password': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.setSignKey': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.orderFirewallRules': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.orderPortForwards': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'wifiConfig.networks.putAp': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'apId': ParamValue} }
  }
  POST: {
    'gatewaySync.wanCreate': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gatewaySync.wanAliasCreate': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'perchId': ParamValue} }
    'gatewaySync.wireguardInterfaceCreate': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gatewaySync.wireguardRotateKey': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'perchId': ParamValue} }
    'gatewaySync.wireguardPeerCreate': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'perchId': ParamValue} }
    'gatewaySync.ambiguitiesResolve': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gatewaySync.upnpAclCreate': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gatewaySync.upnpMappingsDelete': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gatewaySync.ddnsServiceCreate': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gatewaySync.ddnsUpdateNow': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'perchId': ParamValue} }
    'alerts.push.renew': { paramsTuple?: []; params?: {} }
    'alerts.read': { paramsTuple?: []; params?: {} }
    'alerts.push.store': { paramsTuple?: []; params?: {} }
    'alerts.push.unsubscribe': { paramsTuple?: []; params?: {} }
    'alerts.push.test': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'alerts.mutes.store': { paramsTuple?: []; params?: {} }
    'alerts.acknowledge': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'alerts.resolve': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'settings.alerts.test': { paramsTuple?: []; params?: {} }
    'settings.alerts.vapid.rotate': { paramsTuple?: []; params?: {} }
    'settings.alerts.webhooks.store': { paramsTuple?: []; params?: {} }
    'settings.alerts.webhooks.test': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'settings.alerts.webhooks.rotateSecret': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'agentUpdates.refreshDevice': { paramsTuple: [ParamValue,ParamValue]; params: {'kind': ParamValue,'id': ParamValue} }
    'agentUpdates.preflightDevice': { paramsTuple: [ParamValue,ParamValue]; params: {'kind': ParamValue,'id': ParamValue} }
    'agentUpdates.updateDeviceVersion': { paramsTuple: [ParamValue,ParamValue]; params: {'kind': ParamValue,'id': ParamValue} }
    'agentUpdates.rollbackDevice': { paramsTuple: [ParamValue,ParamValue]; params: {'kind': ParamValue,'id': ParamValue} }
    'agentUpdates.abortJob': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'agentUpdates.checkReleases': { paramsTuple?: []; params?: {} }
    'agentUpdates.storeRelease': { paramsTuple?: []; params?: {} }
    'agentUpdates.storeRollout': { paramsTuple?: []; params?: {} }
    'agentUpdates.pauseRollout': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'agentUpdates.resumeRollout': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'agentUpdates.cancelRollout': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'setup.admin': { paramsTuple?: []; params?: {} }
    'setup.login': { paramsTuple?: []; params?: {} }
    'setup.instance': { paramsTuple?: []; params?: {} }
    'setup.collector': { paramsTuple?: []; params?: {} }
    'setup.collector.skip': { paramsTuple?: []; params?: {} }
    'setup.collector.adopt': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'collectors.announce': { paramsTuple?: []; params?: {} }
    'apAgent.join': { paramsTuple?: []; params?: {} }
    'auth.new_account.store': { paramsTuple?: []; params?: {} }
    'auth.access_tokens.store': { paramsTuple?: []; params?: {} }
    'profile.access_tokens.destroy': { paramsTuple?: []; params?: {} }
    'settings.settings.probe_wifi_source_draft': { paramsTuple?: []; params?: {} }
    'settings.settings.create_wifi_source': { paramsTuple?: []; params?: {} }
    'settings.settings.probe_wifi_source': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'settings.wifiSources.agentPing': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'settings.apJoinTokens.store': { paramsTuple?: []; params?: {} }
    'settings.apJoinTokens.reveal': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'settings.collectors.store': { paramsTuple?: []; params?: {} }
    'settings.collectors.probeDraft': { paramsTuple?: []; params?: {} }
    'settings.collectors.probe': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'settings.collectors.adopt': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'settings.collectors.dismiss': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'settings.users.store': { paramsTuple?: []; params?: {} }
    'wifi.wifi.kick_client': { paramsTuple: [ParamValue]; params: {'mac': ParamValue} }
    'wifi.wifi.steer_client': { paramsTuple: [ParamValue]; params: {'mac': ParamValue} }
    'wifi.wifi.reboot_ap': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'wifi.wifi.locate_ap': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'infra.nodes.store': { paramsTuple?: []; params?: {} }
    'infra.nodes.bind': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'infra.nodes.ports.store': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'infra.links.store': { paramsTuple?: []; params?: {} }
    'gatewayObservations.gateway_observations.observe': { paramsTuple: [ParamValue]; params: {'gatewayId': ParamValue} }
    'gatewayObservations.gateway_observations.create_backup': { paramsTuple: [ParamValue]; params: {'gatewayId': ParamValue} }
    'portal.authorizations.store': { paramsTuple?: []; params?: {} }
    'portal.priceTables.quote': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'portal.portals.store': { paramsTuple?: []; params?: {} }
    'portal.gateways.rotateKey': { paramsTuple: [ParamValue]; params: {'gatewayId': ParamValue} }
    'portal.grants.extend': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'portal.grants.revoke': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'portal.templates.store': { paramsTuple?: []; params?: {} }
    'portal.templates.duplicate': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'portal.voucherBatches.store': { paramsTuple?: []; params?: {} }
    'portal.voucherBatches.revoke': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'portal.vouchers.lookup': { paramsTuple?: []; params?: {} }
    'portal.vouchers.revoke': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'portal.users.store': { paramsTuple?: []; params?: {} }
    'portal.apiClients.store': { paramsTuple?: []; params?: {} }
    'portal.apiClients.rotate': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'portal.priceTables.store': { paramsTuple?: []; params?: {} }
    'portal.terminals.store': { paramsTuple?: []; params?: {} }
    'portal.terminals.rotate': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'portal.checkouts.void': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'portal.checkouts.credit': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'portal.checkouts.dismiss': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'deviceGroups.store': { paramsTuple?: []; params?: {} }
    'deviceGroups.members.store': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'deviceGroups.keys.store': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'qos.wanQueues.store': { paramsTuple?: []; params?: {} }
    'qos.policies.store': { paramsTuple?: []; params?: {} }
    'qos.groups.store': { paramsTuple?: []; params?: {} }
    'qos.assignments.store': { paramsTuple?: []; params?: {} }
    'qos.schedules.store': { paramsTuple?: []; params?: {} }
    'qos.assignments.resetQuota': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'qos.pause': { paramsTuple?: []; params?: {} }
    'qos.resume': { paramsTuple?: []; params?: {} }
    'gateways.createNetwork': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.bind': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.refresh': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.resolve': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.createApply': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.installPackages': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.startPairing': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.confirmPairing': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.confirmApply': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'applyId': ParamValue} }
    'gateways.revertApply': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'applyId': ParamValue} }
    'gateways.restoreRevision': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'number': ParamValue} }
    'gateways.dismissRejoin': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.acceptDrift': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.revertDrift': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.resumeEnforcement': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.createRecord': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.applyLabelNames': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.createDhcpTag': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.createRoute': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.resolveFirewallOrder': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.createPortForward': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.createFirewallRule': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'wifiConfig.aps.refresh': { paramsTuple: [ParamValue]; params: {'apId': ParamValue} }
    'wifiConfig.aps.rejoin': { paramsTuple: [ParamValue]; params: {'apId': ParamValue} }
    'wifiConfig.aps.dismissRejoin': { paramsTuple: [ParamValue]; params: {'apId': ParamValue} }
    'wifiConfig.aps.resolve': { paramsTuple: [ParamValue]; params: {'apId': ParamValue} }
    'wifiConfig.aps.confirmApply': { paramsTuple: [ParamValue,ParamValue]; params: {'apId': ParamValue,'applyId': ParamValue} }
    'wifiConfig.aps.revertApply': { paramsTuple: [ParamValue,ParamValue]; params: {'apId': ParamValue,'applyId': ParamValue} }
    'wifiConfig.aps.restoreRevision': { paramsTuple: [ParamValue,ParamValue]; params: {'apId': ParamValue,'number': ParamValue} }
    'wifiConfig.aps.acceptDrift': { paramsTuple: [ParamValue]; params: {'apId': ParamValue} }
    'wifiConfig.aps.revertDrift': { paramsTuple: [ParamValue]; params: {'apId': ParamValue} }
    'wifiConfig.aps.resumeEnforcement': { paramsTuple: [ParamValue]; params: {'apId': ParamValue} }
    'wifiConfig.aps.startPairing': { paramsTuple: [ParamValue]; params: {'apId': ParamValue} }
    'wifiConfig.aps.confirmPairing': { paramsTuple: [ParamValue]; params: {'apId': ParamValue} }
    'wifiConfig.networks.store': { paramsTuple?: []; params?: {} }
    'wifiConfig.networks.setPassphrase': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'wifiConfig.divergences.resolve': { paramsTuple?: []; params?: {} }
    'wifiConfig.adoption.accept': { paramsTuple?: []; params?: {} }
    'wifiConfig.rollouts.preview': { paramsTuple?: []; params?: {} }
    'wifiConfig.rollouts.store': { paramsTuple?: []; params?: {} }
    'wifiConfig.rollouts.action': { paramsTuple: [ParamValue,ParamValue]; params: {'rolloutId': ParamValue,'action': ParamValue} }
  }
  PATCH: {
    'gatewaySync.wanAliasUpdate': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'perchId': ParamValue} }
    'gatewaySync.wanUpdate': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'perchId': ParamValue} }
    'gatewaySync.wireguardInterfaceUpdate': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'perchId': ParamValue} }
    'gatewaySync.wireguardPeerUpdate': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'perchId': ParamValue} }
    'gatewaySync.ipv6Update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gatewaySync.ipv6LanUpdate': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'network': ParamValue} }
    'gatewaySync.firewallDefaultsUpdate': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gatewaySync.upnpConfigUpdate': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gatewaySync.upnpAclUpdate': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'perchId': ParamValue} }
    'gatewaySync.ddnsServiceUpdate': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'perchId': ParamValue} }
    'gatewaySyncSettings.update': { paramsTuple?: []; params?: {} }
    'alerts.push.update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'settings.alerts.update': { paramsTuple?: []; params?: {} }
    'settings.alerts.webhooks.update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'agentUpdates.updateDevice': { paramsTuple: [ParamValue,ParamValue]; params: {'kind': ParamValue,'id': ParamValue} }
    'agentUpdates.updateRelease': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'settings.updateAgentUpdates': { paramsTuple?: []; params?: {} }
    'profile.profile.change_password': { paramsTuple?: []; params?: {} }
    'settings.settings.update_hostname_enrichment': { paramsTuple?: []; params?: {} }
    'settings.updatePresence': { paramsTuple?: []; params?: {} }
    'settings.updateGateway': { paramsTuple?: []; params?: {} }
    'settings.updateGatewayObservations': { paramsTuple?: []; params?: {} }
    'settings.updateQos': { paramsTuple?: []; params?: {} }
    'settings.updateCharts': { paramsTuple?: []; params?: {} }
    'settings.collectors.updateDiscovery': { paramsTuple?: []; params?: {} }
    'settings.updateDeviceGroups': { paramsTuple?: []; params?: {} }
    'settings.updatePortal': { paramsTuple?: []; params?: {} }
    'settings.users.updateRole': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'devices.updateLabel': { paramsTuple: [ParamValue]; params: {'mac': ParamValue} }
    'infra.nodes.update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'infra.ports.update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'infra.links.update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'portal.portals.update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'portal.templates.update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'portal.users.update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'portal.apiClients.update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'portal.priceTables.update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'portal.terminals.update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'deviceGroups.aps.update': { paramsTuple: [ParamValue]; params: {'apId': ParamValue} }
    'deviceGroups.update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'qos.wanQueues.update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'qos.policies.update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'qos.groups.update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'qos.assignments.update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'qos.schedules.update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.updateNetwork': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'networkId': ParamValue} }
    'gateways.update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.updateSection': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'perchId': ParamValue} }
    'gateways.updateDns': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.updateRecord': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'perchId': ParamValue} }
    'gateways.updateDhcpPool': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'network': ParamValue} }
    'gateways.updateDhcpTag': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'perchId': ParamValue} }
    'gateways.updateDhcpReservation': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'perchId': ParamValue} }
    'gateways.updateRoute': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'perchId': ParamValue} }
    'gateways.updateSystem': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.updatePortForward': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'perchId': ParamValue} }
    'gateways.updateFirewallRule': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'perchId': ParamValue} }
    'wifiConfig.aps.update': { paramsTuple: [ParamValue]; params: {'apId': ParamValue} }
    'wifiConfig.aps.updateSection': { paramsTuple: [ParamValue,ParamValue]; params: {'apId': ParamValue,'perchId': ParamValue} }
    'wifiConfig.aps.updateRadio': { paramsTuple: [ParamValue,ParamValue]; params: {'apId': ParamValue,'section': ParamValue} }
    'wifiConfig.networks.update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'wifiConfigSettings.update': { paramsTuple?: []; params?: {} }
  }
  DELETE: {
    'gatewaySync.wanAliasDelete': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'perchId': ParamValue} }
    'gatewaySync.wanDelete': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'perchId': ParamValue} }
    'gatewaySync.wireguardInterfaceDelete': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'perchId': ParamValue} }
    'gatewaySync.wireguardPeerDelete': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'perchId': ParamValue} }
    'gatewaySync.upnpAclDelete': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'perchId': ParamValue} }
    'gatewaySync.ddnsServiceDelete': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'perchId': ParamValue} }
    'alerts.push.destroy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'alerts.mutes.destroy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'settings.alerts.webhooks.destroy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'agentUpdates.destroyRelease': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'settings.settings.delete_wifi_source': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'settings.wifiSources.agentForget': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'settings.apJoinTokens.destroy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'settings.collectors.destroy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'settings.users.destroy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'devices.destroyLabel': { paramsTuple: [ParamValue]; params: {'mac': ParamValue} }
    'devices.deleteReservation': { paramsTuple: [ParamValue]; params: {'mac': ParamValue} }
    'infra.nodes.destroy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'infra.ports.destroy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'infra.links.destroy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'portal.authorizations.destroy': { paramsTuple: [ParamValue]; params: {'mac': ParamValue} }
    'portal.portals.destroy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'portal.templates.destroy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'portal.templates.files.destroy': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'name': ParamValue} }
    'portal.voucherBatches.destroy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'portal.users.destroy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'portal.apiClients.destroy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'portal.priceTables.destroy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'portal.terminals.destroy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'deviceGroups.destroy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'deviceGroups.members.destroy': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'mac': ParamValue} }
    'deviceGroups.keys.destroy': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'keyId': ParamValue} }
    'qos.wanQueues.destroy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'qos.policies.destroy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'qos.groups.destroy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'qos.assignments.destroy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'qos.schedules.destroy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.deleteNetwork': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'networkId': ParamValue} }
    'gateways.discardDraft': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.unpair': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.clearSignKey': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'gateways.deleteRecord': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'perchId': ParamValue} }
    'gateways.deleteDhcpTag': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'perchId': ParamValue} }
    'gateways.deleteRoute': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'perchId': ParamValue} }
    'gateways.deletePortForward': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'perchId': ParamValue} }
    'gateways.deleteFirewallRule': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'perchId': ParamValue} }
    'wifiConfig.aps.discardDraft': { paramsTuple: [ParamValue]; params: {'apId': ParamValue} }
    'wifiConfig.aps.unpair': { paramsTuple: [ParamValue]; params: {'apId': ParamValue} }
    'wifiConfig.networks.destroy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'wifiConfig.networks.resetAp': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'apId': ParamValue} }
  }
}
declare module '@adonisjs/core/types/http' {
  export interface RoutesList extends ScannedRoutes {}
}