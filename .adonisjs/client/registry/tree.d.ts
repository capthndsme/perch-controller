/* eslint-disable prettier/prettier */
import type { routes } from './index.ts'

export interface ApiDefinition {
  setup: {
    status: typeof routes['setup.status']
    admin: typeof routes['setup.admin']
    instance: typeof routes['setup.instance']
    collector: typeof routes['setup.collector']
  }
  auth: {
    newAccount: {
      store: typeof routes['auth.new_account.store']
    }
    accessTokens: {
      store: typeof routes['auth.access_tokens.store']
    }
  }
  profile: {
    profile: {
      show: typeof routes['profile.profile.show']
      changePassword: typeof routes['profile.profile.change_password']
    }
    accessTokens: {
      destroy: typeof routes['profile.access_tokens.destroy']
    }
  }
  settings: {
    settings: {
      hostnameEnrichment: typeof routes['settings.settings.hostname_enrichment']
      updateHostnameEnrichment: typeof routes['settings.settings.update_hostname_enrichment']
      wifiSources: typeof routes['settings.settings.wifi_sources']
      probeWifiSourceDraft: typeof routes['settings.settings.probe_wifi_source_draft']
      createWifiSource: typeof routes['settings.settings.create_wifi_source']
      updateWifiSource: typeof routes['settings.settings.update_wifi_source']
      deleteWifiSource: typeof routes['settings.settings.delete_wifi_source']
      probeWifiSource: typeof routes['settings.settings.probe_wifi_source']
    }
    users: {
      index: typeof routes['settings.users.index']
      store: typeof routes['settings.users.store']
      updateRole: typeof routes['settings.users.updateRole']
      destroy: typeof routes['settings.users.destroy']
    }
  }
  aggregateTraffic: typeof routes['aggregateTraffic']
  topTraffic: typeof routes['topTraffic']
  aggregateProtocols: typeof routes['aggregateProtocols']
  aggregateProtocolDevices: typeof routes['aggregateProtocolDevices']
  topPeers: typeof routes['topPeers']
  services: {
    index: typeof routes['services.index']
    traffic: typeof routes['services.traffic']
  }
  router: typeof routes['router']
  usage: {
    index: typeof routes['usage.index']
    intervals: typeof routes['usage.intervals']
  }
  destinations: {
    index: typeof routes['destinations.index']
    traffic: typeof routes['destinations.traffic']
  }
  devices: {
    index: typeof routes['devices.index']
    labels: typeof routes['devices.labels']
    label: typeof routes['devices.label']
    updateLabel: typeof routes['devices.updateLabel']
    destroyLabel: typeof routes['devices.destroyLabel']
    traffic: typeof routes['devices.traffic']
    peers: typeof routes['devices.peers']
    peersHistory: typeof routes['devices.peersHistory']
    services: typeof routes['devices.services']
    destinations: typeof routes['devices.destinations']
    overview: typeof routes['devices.overview']
    protocols: typeof routes['devices.protocols']
  }
  wifi: {
    wifi: {
      overview: typeof routes['wifi.wifi.overview']
      ssids: typeof routes['wifi.wifi.ssids']
      ssidClients: typeof routes['wifi.wifi.ssid_clients']
      ssidThroughput: typeof routes['wifi.wifi.ssid_throughput']
      clients: typeof routes['wifi.wifi.clients']
      clientsHistory: typeof routes['wifi.wifi.clients_history']
      client: typeof routes['wifi.wifi.client']
      clientSignal: typeof routes['wifi.wifi.client_signal']
      rf: typeof routes['wifi.wifi.rf']
      rfHistory: typeof routes['wifi.wifi.rf_history']
      aps: typeof routes['wifi.wifi.aps']
      apsThroughput: typeof routes['wifi.wifi.aps_throughput']
      apHealth: typeof routes['wifi.wifi.ap_health']
      kickClient: typeof routes['wifi.wifi.kick_client']
      steerClient: typeof routes['wifi.wifi.steer_client']
      rebootAp: typeof routes['wifi.wifi.reboot_ap']
      locateAp: typeof routes['wifi.wifi.locate_ap']
    }
  }
}
