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
    'devices.protocols': { paramsTuple: [ParamValue]; params: {'mac': ParamValue} }
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
    'devices.protocols': { paramsTuple: [ParamValue]; params: {'mac': ParamValue} }
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
    'devices.protocols': { paramsTuple: [ParamValue]; params: {'mac': ParamValue} }
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
  }
  PATCH: {
    'profile.profile.change_password': { paramsTuple?: []; params?: {} }
    'settings.settings.update_hostname_enrichment': { paramsTuple?: []; params?: {} }
    'settings.updatePresence': { paramsTuple?: []; params?: {} }
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
    'portal.priceTables.update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'portal.terminals.update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
  }
  PUT: {
    'settings.settings.update_wifi_source': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'settings.collectors.update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'infra.positions': { paramsTuple?: []; params?: {} }
    'portal.templates.files.put': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'name': ParamValue} }
    'portal.users.password': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
  }
  DELETE: {
    'settings.settings.delete_wifi_source': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'settings.wifiSources.agentForget': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'settings.apJoinTokens.destroy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'settings.collectors.destroy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'settings.users.destroy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'devices.destroyLabel': { paramsTuple: [ParamValue]; params: {'mac': ParamValue} }
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
  }
}
declare module '@adonisjs/core/types/http' {
  export interface RoutesList extends ScannedRoutes {}
}