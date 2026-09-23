/* eslint-disable prettier/prettier */
import type { routes } from './index.ts'

export interface ApiDefinition {
  setup: {
    status: typeof routes['setup.status']
    admin: typeof routes['setup.admin']
    login: typeof routes['setup.login']
    instance: typeof routes['setup.instance']
    collector: typeof routes['setup.collector'] & {
      candidates: typeof routes['setup.collector.candidates']
      skip: typeof routes['setup.collector.skip']
      adopt: typeof routes['setup.collector.adopt']
    }
  }
  version: typeof routes['version']
  collectors: typeof routes['collectors'] & {
    announce: typeof routes['collectors.announce']
  }
  apAgent: {
    join: typeof routes['apAgent.join']
    wsFallback: typeof routes['apAgent.wsFallback']
  }
  collectorAgent: {
    wsFallback: typeof routes['collectorAgent.wsFallback']
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
      hostnameEnrichmentSources: typeof routes['settings.settings.hostname_enrichment_sources']
      wifiSources: typeof routes['settings.settings.wifi_sources']
      probeWifiSourceDraft: typeof routes['settings.settings.probe_wifi_source_draft']
      createWifiSource: typeof routes['settings.settings.create_wifi_source']
      updateWifiSource: typeof routes['settings.settings.update_wifi_source']
      deleteWifiSource: typeof routes['settings.settings.delete_wifi_source']
      probeWifiSource: typeof routes['settings.settings.probe_wifi_source']
    }
    presence: typeof routes['settings.presence']
    updatePresence: typeof routes['settings.updatePresence']
    gateway: typeof routes['settings.gateway']
    updateGateway: typeof routes['settings.updateGateway']
    gatewayObservations: typeof routes['settings.gatewayObservations']
    updateGatewayObservations: typeof routes['settings.updateGatewayObservations']
    qos: typeof routes['settings.qos']
    updateQos: typeof routes['settings.updateQos']
    charts: typeof routes['settings.charts']
    updateCharts: typeof routes['settings.updateCharts']
    wifiSources: {
      agentPing: typeof routes['settings.wifiSources.agentPing']
      agentForget: typeof routes['settings.wifiSources.agentForget']
    }
    apJoinTokens: {
      index: typeof routes['settings.apJoinTokens.index']
      store: typeof routes['settings.apJoinTokens.store']
      reveal: typeof routes['settings.apJoinTokens.reveal']
      destroy: typeof routes['settings.apJoinTokens.destroy']
    }
    apAgent: {
      install: typeof routes['settings.apAgent.install']
    }
    collectors: {
      index: typeof routes['settings.collectors.index']
      store: typeof routes['settings.collectors.store']
      discovery: typeof routes['settings.collectors.discovery']
      updateDiscovery: typeof routes['settings.collectors.updateDiscovery']
      probeDraft: typeof routes['settings.collectors.probeDraft']
      update: typeof routes['settings.collectors.update']
      destroy: typeof routes['settings.collectors.destroy']
      probe: typeof routes['settings.collectors.probe']
      adopt: typeof routes['settings.collectors.adopt']
      dismiss: typeof routes['settings.collectors.dismiss']
    }
    portal: typeof routes['settings.portal']
    updatePortal: typeof routes['settings.updatePortal']
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
    presence: typeof routes['devices.presence']
    shaping: typeof routes['devices.shaping']
    protocols: typeof routes['devices.protocols']
    network: typeof routes['devices.network']
    networks: typeof routes['devices.networks']
    reservation: typeof routes['devices.reservation']
    wanAccess: typeof routes['devices.wanAccess']
    putWanAccess: typeof routes['devices.putWanAccess']
    putReservation: typeof routes['devices.putReservation']
    deleteReservation: typeof routes['devices.deleteReservation']
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
  infra: {
    layout: typeof routes['infra.layout']
    state: typeof routes['infra.state']
    nodes: {
      store: typeof routes['infra.nodes.store']
      update: typeof routes['infra.nodes.update']
      destroy: typeof routes['infra.nodes.destroy']
      bind: typeof routes['infra.nodes.bind']
      ports: {
        store: typeof routes['infra.nodes.ports.store']
      }
    }
    ports: {
      update: typeof routes['infra.ports.update']
      destroy: typeof routes['infra.ports.destroy']
    }
    links: {
      store: typeof routes['infra.links.store']
      update: typeof routes['infra.links.update']
      destroy: typeof routes['infra.links.destroy']
    }
    positions: typeof routes['infra.positions']
  }
  gatewayObservations: {
    gatewayObservations: {
      overview: typeof routes['gatewayObservations.gateway_observations.overview']
      leases: typeof routes['gatewayObservations.gateway_observations.leases']
      neighbors: typeof routes['gatewayObservations.gateway_observations.neighbors']
      interfaces: typeof routes['gatewayObservations.gateway_observations.interfaces']
      upnp: typeof routes['gatewayObservations.gateway_observations.upnp']
      wanStatus: typeof routes['gatewayObservations.gateway_observations.wan_status']
      system: typeof routes['gatewayObservations.gateway_observations.system']
      wireguard: typeof routes['gatewayObservations.gateway_observations.wireguard']
      observe: typeof routes['gatewayObservations.gateway_observations.observe']
      backups: typeof routes['gatewayObservations.gateway_observations.backups']
      createBackup: typeof routes['gatewayObservations.gateway_observations.create_backup']
      downloadBackup: typeof routes['gatewayObservations.gateway_observations.download_backup']
    }
  }
  portal: {
    authorizations: {
      store: typeof routes['portal.authorizations.store']
      show: typeof routes['portal.authorizations.show']
      destroy: typeof routes['portal.authorizations.destroy']
    }
    portals: {
      index: typeof routes['portal.portals.index']
      show: typeof routes['portal.portals.show']
      store: typeof routes['portal.portals.store']
      update: typeof routes['portal.portals.update']
      destroy: typeof routes['portal.portals.destroy']
    }
    grants: {
      index: typeof routes['portal.grants.index']
      extend: typeof routes['portal.grants.extend']
      revoke: typeof routes['portal.grants.revoke']
    }
    sessions: {
      index: typeof routes['portal.sessions.index']
    }
    gateways: {
      rotateKey: typeof routes['portal.gateways.rotateKey']
    }
    templates: {
      index: typeof routes['portal.templates.index']
      store: typeof routes['portal.templates.store']
      show: typeof routes['portal.templates.show']
      update: typeof routes['portal.templates.update']
      destroy: typeof routes['portal.templates.destroy']
      duplicate: typeof routes['portal.templates.duplicate']
      preview: typeof routes['portal.templates.preview']
      files: {
        put: typeof routes['portal.templates.files.put']
        destroy: typeof routes['portal.templates.files.destroy']
      }
    }
    voucherBatches: {
      store: typeof routes['portal.voucherBatches.store']
      index: typeof routes['portal.voucherBatches.index']
      show: typeof routes['portal.voucherBatches.show']
      codes: typeof routes['portal.voucherBatches.codes']
      csv: typeof routes['portal.voucherBatches.csv']
      revoke: typeof routes['portal.voucherBatches.revoke']
      destroy: typeof routes['portal.voucherBatches.destroy']
    }
    vouchers: {
      index: typeof routes['portal.vouchers.index']
      lookup: typeof routes['portal.vouchers.lookup']
      revoke: typeof routes['portal.vouchers.revoke']
    }
    users: {
      index: typeof routes['portal.users.index']
      store: typeof routes['portal.users.store']
      update: typeof routes['portal.users.update']
      password: typeof routes['portal.users.password']
      destroy: typeof routes['portal.users.destroy']
    }
    apiClients: {
      index: typeof routes['portal.apiClients.index']
      store: typeof routes['portal.apiClients.store']
      update: typeof routes['portal.apiClients.update']
      rotate: typeof routes['portal.apiClients.rotate']
      destroy: typeof routes['portal.apiClients.destroy']
    }
  }
  qos: {
    overview: typeof routes['qos.overview']
    devices: {
      index: typeof routes['qos.devices.index']
    }
    wanQueues: {
      index: typeof routes['qos.wanQueues.index']
      store: typeof routes['qos.wanQueues.store']
      update: typeof routes['qos.wanQueues.update']
      destroy: typeof routes['qos.wanQueues.destroy']
    }
    policies: {
      index: typeof routes['qos.policies.index']
      store: typeof routes['qos.policies.store']
      update: typeof routes['qos.policies.update']
      destroy: typeof routes['qos.policies.destroy']
    }
    groups: {
      index: typeof routes['qos.groups.index']
      store: typeof routes['qos.groups.store']
      update: typeof routes['qos.groups.update']
      destroy: typeof routes['qos.groups.destroy']
    }
    assignments: {
      index: typeof routes['qos.assignments.index']
      store: typeof routes['qos.assignments.store']
      update: typeof routes['qos.assignments.update']
      destroy: typeof routes['qos.assignments.destroy']
      resetQuota: typeof routes['qos.assignments.resetQuota']
    }
    schedules: {
      index: typeof routes['qos.schedules.index']
      store: typeof routes['qos.schedules.store']
      update: typeof routes['qos.schedules.update']
      destroy: typeof routes['qos.schedules.destroy']
    }
    pause: typeof routes['qos.pause']
    resume: typeof routes['qos.resume']
  }
  networks: {
    index: typeof routes['networks.index']
    scopeChanges: typeof routes['networks.scopeChanges']
  }
  gateways: {
    index: typeof routes['gateways.index']
    show: typeof routes['gateways.show']
    syncStatus: typeof routes['gateways.syncStatus']
    sections: typeof routes['gateways.sections']
    section: typeof routes['gateways.section']
    draft: typeof routes['gateways.draft']
    applies: typeof routes['gateways.applies']
    apply: typeof routes['gateways.apply']
    revisions: typeof routes['gateways.revisions']
    revision: typeof routes['gateways.revision']
    events: typeof routes['gateways.events']
    pairing: typeof routes['gateways.pairing']
    dns: typeof routes['gateways.dns']
    labelNames: typeof routes['gateways.labelNames']
    networks: typeof routes['gateways.networks']
    networkHistory: typeof routes['gateways.networkHistory']
    network: typeof routes['gateways.network']
    createNetwork: typeof routes['gateways.createNetwork']
    updateNetwork: typeof routes['gateways.updateNetwork']
    deleteNetwork: typeof routes['gateways.deleteNetwork']
    update: typeof routes['gateways.update']
    bind: typeof routes['gateways.bind']
    refresh: typeof routes['gateways.refresh']
    updateSection: typeof routes['gateways.updateSection']
    resolve: typeof routes['gateways.resolve']
    discardDraft: typeof routes['gateways.discardDraft']
    createApply: typeof routes['gateways.createApply']
    installPackages: typeof routes['gateways.installPackages']
    setSignKey: typeof routes['gateways.setSignKey']
    startPairing: typeof routes['gateways.startPairing']
    confirmPairing: typeof routes['gateways.confirmPairing']
    unpair: typeof routes['gateways.unpair']
    clearSignKey: typeof routes['gateways.clearSignKey']
    confirmApply: typeof routes['gateways.confirmApply']
    revertApply: typeof routes['gateways.revertApply']
    restoreRevision: typeof routes['gateways.restoreRevision']
    dismissRejoin: typeof routes['gateways.dismissRejoin']
    acceptDrift: typeof routes['gateways.acceptDrift']
    revertDrift: typeof routes['gateways.revertDrift']
    resumeEnforcement: typeof routes['gateways.resumeEnforcement']
    updateDns: typeof routes['gateways.updateDns']
    createRecord: typeof routes['gateways.createRecord']
    updateRecord: typeof routes['gateways.updateRecord']
    deleteRecord: typeof routes['gateways.deleteRecord']
    applyLabelNames: typeof routes['gateways.applyLabelNames']
    dhcp: typeof routes['gateways.dhcp']
    updateDhcpPool: typeof routes['gateways.updateDhcpPool']
    createDhcpTag: typeof routes['gateways.createDhcpTag']
    updateDhcpTag: typeof routes['gateways.updateDhcpTag']
    deleteDhcpTag: typeof routes['gateways.deleteDhcpTag']
    updateDhcpReservation: typeof routes['gateways.updateDhcpReservation']
    routing: typeof routes['gateways.routing']
    createRoute: typeof routes['gateways.createRoute']
    updateRoute: typeof routes['gateways.updateRoute']
    deleteRoute: typeof routes['gateways.deleteRoute']
    updateSystem: typeof routes['gateways.updateSystem']
    firewall: typeof routes['gateways.firewall']
    orderFirewallRules: typeof routes['gateways.orderFirewallRules']
    orderPortForwards: typeof routes['gateways.orderPortForwards']
    resolveFirewallOrder: typeof routes['gateways.resolveFirewallOrder']
    createPortForward: typeof routes['gateways.createPortForward']
    updatePortForward: typeof routes['gateways.updatePortForward']
    deletePortForward: typeof routes['gateways.deletePortForward']
    createFirewallRule: typeof routes['gateways.createFirewallRule']
    updateFirewallRule: typeof routes['gateways.updateFirewallRule']
    deleteFirewallRule: typeof routes['gateways.deleteFirewallRule']
  }
}
