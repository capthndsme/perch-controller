import '@adonisjs/core/types/http'

type ParamValue = string | number | bigint | boolean

export type ScannedRoutes = {
  ALL: {
    'setup.status': { paramsTuple?: []; params?: {} }
    'setup.admin': { paramsTuple?: []; params?: {} }
    'setup.instance': { paramsTuple?: []; params?: {} }
    'setup.collector': { paramsTuple?: []; params?: {} }
    'collectors.announce': { paramsTuple?: []; params?: {} }
    'apAgent.join': { paramsTuple?: []; params?: {} }
    'auth.new_account.store': { paramsTuple?: []; params?: {} }
    'auth.access_tokens.store': { paramsTuple?: []; params?: {} }
    'profile.profile.show': { paramsTuple?: []; params?: {} }
    'profile.profile.change_password': { paramsTuple?: []; params?: {} }
    'profile.access_tokens.destroy': { paramsTuple?: []; params?: {} }
    'settings.settings.hostname_enrichment': { paramsTuple?: []; params?: {} }
    'settings.settings.update_hostname_enrichment': { paramsTuple?: []; params?: {} }
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
  }
  GET: {
    'setup.status': { paramsTuple?: []; params?: {} }
    'profile.profile.show': { paramsTuple?: []; params?: {} }
    'settings.settings.hostname_enrichment': { paramsTuple?: []; params?: {} }
    'settings.settings.wifi_sources': { paramsTuple?: []; params?: {} }
    'settings.apJoinTokens.index': { paramsTuple?: []; params?: {} }
    'settings.apAgent.install': { paramsTuple?: []; params?: {} }
    'settings.collectors.index': { paramsTuple?: []; params?: {} }
    'settings.collectors.discovery': { paramsTuple?: []; params?: {} }
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
  }
  HEAD: {
    'setup.status': { paramsTuple?: []; params?: {} }
    'profile.profile.show': { paramsTuple?: []; params?: {} }
    'settings.settings.hostname_enrichment': { paramsTuple?: []; params?: {} }
    'settings.settings.wifi_sources': { paramsTuple?: []; params?: {} }
    'settings.apJoinTokens.index': { paramsTuple?: []; params?: {} }
    'settings.apAgent.install': { paramsTuple?: []; params?: {} }
    'settings.collectors.index': { paramsTuple?: []; params?: {} }
    'settings.collectors.discovery': { paramsTuple?: []; params?: {} }
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
  }
  POST: {
    'setup.admin': { paramsTuple?: []; params?: {} }
    'setup.instance': { paramsTuple?: []; params?: {} }
    'setup.collector': { paramsTuple?: []; params?: {} }
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
  }
  PATCH: {
    'profile.profile.change_password': { paramsTuple?: []; params?: {} }
    'settings.settings.update_hostname_enrichment': { paramsTuple?: []; params?: {} }
    'settings.collectors.updateDiscovery': { paramsTuple?: []; params?: {} }
    'settings.users.updateRole': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'devices.updateLabel': { paramsTuple: [ParamValue]; params: {'mac': ParamValue} }
  }
  PUT: {
    'settings.settings.update_wifi_source': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'settings.collectors.update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
  }
  DELETE: {
    'settings.settings.delete_wifi_source': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'settings.wifiSources.agentForget': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'settings.apJoinTokens.destroy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'settings.collectors.destroy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'settings.users.destroy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'devices.destroyLabel': { paramsTuple: [ParamValue]; params: {'mac': ParamValue} }
  }
}
declare module '@adonisjs/core/types/http' {
  export interface RoutesList extends ScannedRoutes {}
}