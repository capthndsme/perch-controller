import '@adonisjs/core/types/http'

type ParamValue = string | number | bigint | boolean

export type ScannedRoutes = {
  ALL: {
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
  }
  GET: {
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
  }
  HEAD: {
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
  }
  POST: {
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
  }
  PATCH: {
    'profile.profile.change_password': { paramsTuple?: []; params?: {} }
    'settings.settings.update_hostname_enrichment': { paramsTuple?: []; params?: {} }
    'settings.updatePresence': { paramsTuple?: []; params?: {} }
    'settings.updateGateway': { paramsTuple?: []; params?: {} }
    'settings.updateGatewayObservations': { paramsTuple?: []; params?: {} }
    'settings.updateQos': { paramsTuple?: []; params?: {} }
    'settings.updateCharts': { paramsTuple?: []; params?: {} }
    'settings.collectors.updateDiscovery': { paramsTuple?: []; params?: {} }
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
  }
  PUT: {
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
  }
  DELETE: {
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
  }
}
declare module '@adonisjs/core/types/http' {
  export interface RoutesList extends ScannedRoutes {}
}