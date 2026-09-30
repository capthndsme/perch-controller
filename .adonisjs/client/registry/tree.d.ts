/* eslint-disable prettier/prettier */
import type { routes } from './index.ts'

export interface ApiDefinition {
  gatewaySync: {
    wan: typeof routes['gatewaySync.wan']
    wanHistory: typeof routes['gatewaySync.wanHistory']
    wanOrder: typeof routes['gatewaySync.wanOrder']
    wanCreate: typeof routes['gatewaySync.wanCreate']
    wanAliasUpdate: typeof routes['gatewaySync.wanAliasUpdate']
    wanAliasDelete: typeof routes['gatewaySync.wanAliasDelete']
    wanShow: typeof routes['gatewaySync.wanShow']
    wanUpdate: typeof routes['gatewaySync.wanUpdate']
    wanDelete: typeof routes['gatewaySync.wanDelete']
    wanAliasCreate: typeof routes['gatewaySync.wanAliasCreate']
    wireguardConfig: typeof routes['gatewaySync.wireguardConfig']
    wireguardInterfaceCreate: typeof routes['gatewaySync.wireguardInterfaceCreate']
    wireguardInterfaceUpdate: typeof routes['gatewaySync.wireguardInterfaceUpdate']
    wireguardInterfaceDelete: typeof routes['gatewaySync.wireguardInterfaceDelete']
    wireguardRotateKey: typeof routes['gatewaySync.wireguardRotateKey']
    wireguardPeerCreate: typeof routes['gatewaySync.wireguardPeerCreate']
    wireguardPeerUpdate: typeof routes['gatewaySync.wireguardPeerUpdate']
    wireguardPeerDelete: typeof routes['gatewaySync.wireguardPeerDelete']
    ipv6: typeof routes['gatewaySync.ipv6']
    ipv6Update: typeof routes['gatewaySync.ipv6Update']
    ipv6LanUpdate: typeof routes['gatewaySync.ipv6LanUpdate']
    ambiguities: typeof routes['gatewaySync.ambiguities']
    ambiguitiesResolve: typeof routes['gatewaySync.ambiguitiesResolve']
    firewallDefaults: typeof routes['gatewaySync.firewallDefaults']
    firewallDefaultsUpdate: typeof routes['gatewaySync.firewallDefaultsUpdate']
    upnpConfig: typeof routes['gatewaySync.upnpConfig']
    upnpConfigUpdate: typeof routes['gatewaySync.upnpConfigUpdate']
    upnpAclOrder: typeof routes['gatewaySync.upnpAclOrder']
    upnpAclCreate: typeof routes['gatewaySync.upnpAclCreate']
    upnpAclUpdate: typeof routes['gatewaySync.upnpAclUpdate']
    upnpAclDelete: typeof routes['gatewaySync.upnpAclDelete']
    upnpMappingsDelete: typeof routes['gatewaySync.upnpMappingsDelete']
    upnpDeviceBlock: typeof routes['gatewaySync.upnpDeviceBlock']
    ddns: typeof routes['gatewaySync.ddns']
    ddnsServiceCreate: typeof routes['gatewaySync.ddnsServiceCreate']
    ddnsServiceUpdate: typeof routes['gatewaySync.ddnsServiceUpdate']
    ddnsServiceDelete: typeof routes['gatewaySync.ddnsServiceDelete']
    ddnsUpdateNow: typeof routes['gatewaySync.ddnsUpdateNow']
    multiwan: typeof routes['gatewaySync.multiwan']
  }
  gatewaySyncSettings: {
    show: typeof routes['gatewaySyncSettings.show']
    update: typeof routes['gatewaySyncSettings.update']
  }
  alerts: {
    push: {
      renew: typeof routes['alerts.push.renew']
      config: typeof routes['alerts.push.config']
      index: typeof routes['alerts.push.index']
      store: typeof routes['alerts.push.store']
      unsubscribe: typeof routes['alerts.push.unsubscribe']
      update: typeof routes['alerts.push.update']
      destroy: typeof routes['alerts.push.destroy']
      test: typeof routes['alerts.push.test']
    }
    summary: typeof routes['alerts.summary']
    catalogue: typeof routes['alerts.catalogue']
    read: typeof routes['alerts.read']
    mutes: {
      index: typeof routes['alerts.mutes.index']
      store: typeof routes['alerts.mutes.store']
      destroy: typeof routes['alerts.mutes.destroy']
    }
    watches: {
      index: typeof routes['alerts.watches.index']
      update: typeof routes['alerts.watches.update']
    }
    index: typeof routes['alerts.index']
    show: typeof routes['alerts.show']
    deliveries: {
      index: typeof routes['alerts.deliveries.index']
      show: typeof routes['alerts.deliveries.show']
    }
    acknowledge: typeof routes['alerts.acknowledge']
    resolve: typeof routes['alerts.resolve']
  }
  settings: {
    alerts: {
      show: typeof routes['settings.alerts.show']
      update: typeof routes['settings.alerts.update']
      test: typeof routes['settings.alerts.test']
      vapid: {
        rotate: typeof routes['settings.alerts.vapid.rotate']
      }
      webhooks: {
        index: typeof routes['settings.alerts.webhooks.index']
        store: typeof routes['settings.alerts.webhooks.store']
        show: typeof routes['settings.alerts.webhooks.show']
        update: typeof routes['settings.alerts.webhooks.update']
        destroy: typeof routes['settings.alerts.webhooks.destroy']
        test: typeof routes['settings.alerts.webhooks.test']
        rotateSecret: typeof routes['settings.alerts.webhooks.rotateSecret']
      }
    }
    agentUpdates: typeof routes['settings.agentUpdates']
    updateAgentUpdates: typeof routes['settings.updateAgentUpdates']
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
    deviceGroups: typeof routes['settings.deviceGroups']
    updateDeviceGroups: typeof routes['settings.updateDeviceGroups']
    portal: typeof routes['settings.portal']
    updatePortal: typeof routes['settings.updatePortal']
    users: {
      index: typeof routes['settings.users.index']
      store: typeof routes['settings.users.store']
      updateRole: typeof routes['settings.users.updateRole']
      destroy: typeof routes['settings.users.destroy']
    }
  }
  agentUpdates: {
    download: typeof routes['agentUpdates.download']
    fleet: typeof routes['agentUpdates.fleet']
    jobs: typeof routes['agentUpdates.jobs']
    job: typeof routes['agentUpdates.job']
    events: typeof routes['agentUpdates.events']
    releases: typeof routes['agentUpdates.releases']
    release: typeof routes['agentUpdates.release']
    rollouts: typeof routes['agentUpdates.rollouts']
    rollout: typeof routes['agentUpdates.rollout']
    updateDevice: typeof routes['agentUpdates.updateDevice']
    refreshDevice: typeof routes['agentUpdates.refreshDevice']
    preflightDevice: typeof routes['agentUpdates.preflightDevice']
    updateDeviceVersion: typeof routes['agentUpdates.updateDeviceVersion']
    rollbackDevice: typeof routes['agentUpdates.rollbackDevice']
    abortJob: typeof routes['agentUpdates.abortJob']
    checkReleases: typeof routes['agentUpdates.checkReleases']
    storeRelease: typeof routes['agentUpdates.storeRelease']
    uploadReleaseFile: typeof routes['agentUpdates.uploadReleaseFile']
    updateRelease: typeof routes['agentUpdates.updateRelease']
    destroyRelease: typeof routes['agentUpdates.destroyRelease']
    storeRollout: typeof routes['agentUpdates.storeRollout']
    pauseRollout: typeof routes['agentUpdates.pauseRollout']
    resumeRollout: typeof routes['agentUpdates.resumeRollout']
    cancelRollout: typeof routes['agentUpdates.cancelRollout']
  }
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
    group: typeof routes['devices.group']
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
    ports: {
      traffic: typeof routes['infra.ports.traffic']
      update: typeof routes['infra.ports.update']
      destroy: typeof routes['infra.ports.destroy']
    }
    links: {
      traffic: typeof routes['infra.links.traffic']
      store: typeof routes['infra.links.store']
      update: typeof routes['infra.links.update']
      destroy: typeof routes['infra.links.destroy']
    }
    nodes: {
      traffic: typeof routes['infra.nodes.traffic']
      store: typeof routes['infra.nodes.store']
      update: typeof routes['infra.nodes.update']
      destroy: typeof routes['infra.nodes.destroy']
      bind: typeof routes['infra.nodes.bind']
      ports: {
        store: typeof routes['infra.nodes.ports.store']
      }
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
    priceTables: {
      index: typeof routes['portal.priceTables.index']
      show: typeof routes['portal.priceTables.show']
      quote: typeof routes['portal.priceTables.quote']
      store: typeof routes['portal.priceTables.store']
      update: typeof routes['portal.priceTables.update']
      destroy: typeof routes['portal.priceTables.destroy']
    }
    terminals: {
      index: typeof routes['portal.terminals.index']
      show: typeof routes['portal.terminals.show']
      store: typeof routes['portal.terminals.store']
      update: typeof routes['portal.terminals.update']
      rotate: typeof routes['portal.terminals.rotate']
      destroy: typeof routes['portal.terminals.destroy']
    }
    checkouts: {
      index: typeof routes['portal.checkouts.index']
      show: typeof routes['portal.checkouts.show']
      void: typeof routes['portal.checkouts.void']
      credit: typeof routes['portal.checkouts.credit']
      dismiss: typeof routes['portal.checkouts.dismiss']
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
  deviceGroups: {
    index: typeof routes['deviceGroups.index']
    aps: typeof routes['deviceGroups.aps'] & {
      update: typeof routes['deviceGroups.aps.update']
    }
    show: typeof routes['deviceGroups.show']
    store: typeof routes['deviceGroups.store']
    update: typeof routes['deviceGroups.update']
    destroy: typeof routes['deviceGroups.destroy']
    members: {
      store: typeof routes['deviceGroups.members.store']
      destroy: typeof routes['deviceGroups.members.destroy']
    }
    keys: {
      store: typeof routes['deviceGroups.keys.store']
      reveal: typeof routes['deviceGroups.keys.reveal']
      destroy: typeof routes['deviceGroups.keys.destroy']
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
  wifiConfig: {
    overview: typeof routes['wifiConfig.overview']
    aps: {
      index: typeof routes['wifiConfig.aps.index']
      show: typeof routes['wifiConfig.aps.show']
      health: typeof routes['wifiConfig.aps.health']
      syncStatus: typeof routes['wifiConfig.aps.syncStatus']
      sections: typeof routes['wifiConfig.aps.sections']
      section: typeof routes['wifiConfig.aps.section']
      draft: typeof routes['wifiConfig.aps.draft']
      applies: typeof routes['wifiConfig.aps.applies']
      apply: typeof routes['wifiConfig.aps.apply']
      revisions: typeof routes['wifiConfig.aps.revisions']
      revision: typeof routes['wifiConfig.aps.revision']
      events: typeof routes['wifiConfig.aps.events']
      pairing: typeof routes['wifiConfig.aps.pairing']
      update: typeof routes['wifiConfig.aps.update']
      refresh: typeof routes['wifiConfig.aps.refresh']
      rejoin: typeof routes['wifiConfig.aps.rejoin']
      dismissRejoin: typeof routes['wifiConfig.aps.dismissRejoin']
      updateSection: typeof routes['wifiConfig.aps.updateSection']
      resolve: typeof routes['wifiConfig.aps.resolve']
      discardDraft: typeof routes['wifiConfig.aps.discardDraft']
      confirmApply: typeof routes['wifiConfig.aps.confirmApply']
      revertApply: typeof routes['wifiConfig.aps.revertApply']
      restoreRevision: typeof routes['wifiConfig.aps.restoreRevision']
      acceptDrift: typeof routes['wifiConfig.aps.acceptDrift']
      revertDrift: typeof routes['wifiConfig.aps.revertDrift']
      resumeEnforcement: typeof routes['wifiConfig.aps.resumeEnforcement']
      startPairing: typeof routes['wifiConfig.aps.startPairing']
      confirmPairing: typeof routes['wifiConfig.aps.confirmPairing']
      unpair: typeof routes['wifiConfig.aps.unpair']
      updateRadio: typeof routes['wifiConfig.aps.updateRadio']
    }
    radios: {
      index: typeof routes['wifiConfig.radios.index']
    }
    networks: {
      index: typeof routes['wifiConfig.networks.index']
      show: typeof routes['wifiConfig.networks.show']
      store: typeof routes['wifiConfig.networks.store']
      update: typeof routes['wifiConfig.networks.update']
      destroy: typeof routes['wifiConfig.networks.destroy']
      setPassphrase: typeof routes['wifiConfig.networks.setPassphrase']
      revealPassphrase: typeof routes['wifiConfig.networks.revealPassphrase']
      putAp: typeof routes['wifiConfig.networks.putAp']
      resetAp: typeof routes['wifiConfig.networks.resetAp']
    }
    divergences: {
      index: typeof routes['wifiConfig.divergences.index']
      resolve: typeof routes['wifiConfig.divergences.resolve']
    }
    adoption: {
      show: typeof routes['wifiConfig.adoption.show']
      accept: typeof routes['wifiConfig.adoption.accept']
    }
    rollouts: {
      index: typeof routes['wifiConfig.rollouts.index']
      current: typeof routes['wifiConfig.rollouts.current']
      show: typeof routes['wifiConfig.rollouts.show']
      preview: typeof routes['wifiConfig.rollouts.preview']
      store: typeof routes['wifiConfig.rollouts.store']
      action: typeof routes['wifiConfig.rollouts.action']
    }
  }
  wifiConfigSettings: {
    show: typeof routes['wifiConfigSettings.show']
    update: typeof routes['wifiConfigSettings.update']
  }
}
