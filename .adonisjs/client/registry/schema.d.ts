/* eslint-disable prettier/prettier */
/// <reference path="../manifest.d.ts" />

import type { ExtractBody, ExtractErrorResponse, ExtractQuery, ExtractQueryForGet, ExtractResponse } from '@tuyau/core/types'
import type { InferInput, SimpleError } from '@vinejs/vine/types'

export type ParamValue = string | number | bigint | boolean

export interface Registry {
  'setup.status': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/setup/status'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/setup_controller').default['status']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/setup_controller').default['status']>>>
    }
  }
  'setup.admin': {
    methods: ["POST"]
    pattern: '/api/v1/setup/admin'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/setup').setupAdminValidator)>>
      paramsTuple: []
      params: {}
      query: ExtractQuery<InferInput<(typeof import('#validators/setup').setupAdminValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/setup_controller').default['admin']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/setup_controller').default['admin']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'setup.instance': {
    methods: ["POST"]
    pattern: '/api/v1/setup/instance'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/setup').setupInstanceValidator)>>
      paramsTuple: []
      params: {}
      query: ExtractQuery<InferInput<(typeof import('#validators/setup').setupInstanceValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/setup_controller').default['instance']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/setup_controller').default['instance']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'setup.collector': {
    methods: ["POST"]
    pattern: '/api/v1/setup/collector'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/setup').setupCollectorValidator)>>
      paramsTuple: []
      params: {}
      query: ExtractQuery<InferInput<(typeof import('#validators/setup').setupCollectorValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/setup_controller').default['collector']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/setup_controller').default['collector']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'auth.new_account.store': {
    methods: ["POST"]
    pattern: '/api/v1/auth/signup'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/user').signupValidator)>>
      paramsTuple: []
      params: {}
      query: ExtractQuery<InferInput<(typeof import('#validators/user').signupValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/new_account_controller').default['store']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/new_account_controller').default['store']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'auth.access_tokens.store': {
    methods: ["POST"]
    pattern: '/api/v1/auth/login'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/user').loginValidator)>>
      paramsTuple: []
      params: {}
      query: ExtractQuery<InferInput<(typeof import('#validators/user').loginValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/access_tokens_controller').default['store']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/access_tokens_controller').default['store']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'profile.profile.show': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/account/profile'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/profile_controller').default['show']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/profile_controller').default['show']>>>
    }
  }
  'profile.profile.change_password': {
    methods: ["PATCH"]
    pattern: '/api/v1/account/password'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/user').changePasswordValidator)>>
      paramsTuple: []
      params: {}
      query: ExtractQuery<InferInput<(typeof import('#validators/user').changePasswordValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/profile_controller').default['changePassword']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/profile_controller').default['changePassword']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'profile.access_tokens.destroy': {
    methods: ["POST"]
    pattern: '/api/v1/account/logout'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/access_tokens_controller').default['destroy']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/access_tokens_controller').default['destroy']>>>
    }
  }
  'settings.settings.hostname_enrichment': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/settings/hostname-enrichment'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/settings_controller').default['hostnameEnrichment']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/settings_controller').default['hostnameEnrichment']>>>
    }
  }
  'settings.settings.update_hostname_enrichment': {
    methods: ["PATCH"]
    pattern: '/api/v1/settings/hostname-enrichment'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/hostname_enrichment_settings').updateHostnameEnrichmentSettingsValidator)>>
      paramsTuple: []
      params: {}
      query: ExtractQuery<InferInput<(typeof import('#validators/hostname_enrichment_settings').updateHostnameEnrichmentSettingsValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/settings_controller').default['updateHostnameEnrichment']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/settings_controller').default['updateHostnameEnrichment']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'settings.settings.wifi_sources': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/settings/wifi-sources'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/settings_controller').default['wifiSources']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/settings_controller').default['wifiSources']>>>
    }
  }
  'settings.settings.probe_wifi_source_draft': {
    methods: ["POST"]
    pattern: '/api/v1/settings/wifi-sources/probe'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/wifi').wifiSourceProbeValidator)>>
      paramsTuple: []
      params: {}
      query: ExtractQuery<InferInput<(typeof import('#validators/wifi').wifiSourceProbeValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/settings_controller').default['probeWifiSourceDraft']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/settings_controller').default['probeWifiSourceDraft']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'settings.settings.create_wifi_source': {
    methods: ["POST"]
    pattern: '/api/v1/settings/wifi-sources'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/wifi').wifiSourceCreateValidator)>>
      paramsTuple: []
      params: {}
      query: ExtractQuery<InferInput<(typeof import('#validators/wifi').wifiSourceCreateValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/settings_controller').default['createWifiSource']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/settings_controller').default['createWifiSource']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'settings.settings.update_wifi_source': {
    methods: ["PUT"]
    pattern: '/api/v1/settings/wifi-sources/:id'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/wifi').wifiSourceUpdateValidator)>>
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/wifi').wifiSourceUpdateValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/settings_controller').default['updateWifiSource']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/settings_controller').default['updateWifiSource']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'settings.settings.delete_wifi_source': {
    methods: ["DELETE"]
    pattern: '/api/v1/settings/wifi-sources/:id'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/settings_controller').default['deleteWifiSource']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/settings_controller').default['deleteWifiSource']>>>
    }
  }
  'settings.settings.probe_wifi_source': {
    methods: ["POST"]
    pattern: '/api/v1/settings/wifi-sources/:id/probe'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/settings_controller').default['probeWifiSource']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/settings_controller').default['probeWifiSource']>>>
    }
  }
  'settings.users.index': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/settings/users'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/users_controller').default['index']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/users_controller').default['index']>>>
    }
  }
  'settings.users.store': {
    methods: ["POST"]
    pattern: '/api/v1/settings/users'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/user').inviteUserValidator)>>
      paramsTuple: []
      params: {}
      query: ExtractQuery<InferInput<(typeof import('#validators/user').inviteUserValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/users_controller').default['store']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/users_controller').default['store']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'settings.users.updateRole': {
    methods: ["PATCH"]
    pattern: '/api/v1/settings/users/:id/role'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/user').updateUserRoleValidator)>>
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/user').updateUserRoleValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/users_controller').default['updateRole']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/users_controller').default['updateRole']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'settings.users.destroy': {
    methods: ["DELETE"]
    pattern: '/api/v1/settings/users/:id'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/users_controller').default['destroy']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/users_controller').default['destroy']>>>
    }
  }
  'aggregateTraffic': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/traffic'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: ExtractQueryForGet<InferInput<(typeof import('#validators/devices').aggregateTrafficQueryValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/devices_controller').default['aggregateTraffic']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/devices_controller').default['aggregateTraffic']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'topTraffic': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/traffic/top'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: ExtractQueryForGet<InferInput<(typeof import('#validators/devices').topTrafficQueryValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/devices_controller').default['topTraffic']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/devices_controller').default['topTraffic']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'aggregateProtocols': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/protocols'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: ExtractQueryForGet<InferInput<(typeof import('#validators/devices').protocolsQueryValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/devices_controller').default['aggregateProtocols']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/devices_controller').default['aggregateProtocols']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'aggregateProtocolDevices': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/protocols/:protocol/devices'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { protocol: ParamValue }
      query: ExtractQueryForGet<InferInput<(typeof import('#validators/devices').protocolTopDevicesQueryValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/devices_controller').default['aggregateProtocolDevices']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/devices_controller').default['aggregateProtocolDevices']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'topPeers': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/peers/top'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: ExtractQueryForGet<InferInput<(typeof import('#validators/devices').peerHistoryQueryValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/devices_controller').default['topPeers']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/devices_controller').default['topPeers']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'services.index': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/services'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: ExtractQueryForGet<InferInput<(typeof import('#validators/devices').servicesQueryValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/services_controller').default['index']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/services_controller').default['index']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'services.traffic': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/services/:serverName/traffic'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { serverName: ParamValue }
      query: ExtractQueryForGet<InferInput<(typeof import('#validators/devices').serviceTrafficQueryValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/services_controller').default['traffic']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/services_controller').default['traffic']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'router': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/router'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: ExtractQueryForGet<InferInput<(typeof import('#validators/devices').routerQueryValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/router_controller').default['index']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/router_controller').default['index']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'usage.index': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/usage'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: ExtractQueryForGet<InferInput<(typeof import('#validators/devices').usageQueryValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/usage_controller').default['index']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/usage_controller').default['index']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'usage.intervals': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/usage/intervals'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: ExtractQueryForGet<InferInput<(typeof import('#validators/devices').usageIntervalsQueryValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/usage_controller').default['intervals']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/usage_controller').default['intervals']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'destinations.index': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/destinations'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: ExtractQueryForGet<InferInput<(typeof import('#validators/devices').destinationsQueryValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/destinations_controller').default['index']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/destinations_controller').default['index']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'destinations.traffic': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/destinations/:serverName/traffic'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { serverName: ParamValue }
      query: ExtractQueryForGet<InferInput<(typeof import('#validators/devices').destinationTrafficQueryValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/destinations_controller').default['traffic']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/destinations_controller').default['traffic']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'devices.index': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/devices'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: ExtractQueryForGet<InferInput<(typeof import('#validators/devices').devicesIndexValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/devices_controller').default['index']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/devices_controller').default['index']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'devices.labels': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/devices/labels'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/device_labels_controller').default['index']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/device_labels_controller').default['index']>>>
    }
  }
  'devices.label': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/devices/:mac/label'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { mac: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/device_labels_controller').default['show']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/device_labels_controller').default['show']>>>
    }
  }
  'devices.updateLabel': {
    methods: ["PATCH"]
    pattern: '/api/v1/devices/:mac/label'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/device_labels').deviceLabelUpdateValidator)>>
      paramsTuple: [ParamValue]
      params: { mac: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/device_labels').deviceLabelUpdateValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/device_labels_controller').default['update']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/device_labels_controller').default['update']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'devices.destroyLabel': {
    methods: ["DELETE"]
    pattern: '/api/v1/devices/:mac/label'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { mac: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/device_labels_controller').default['destroy']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/device_labels_controller').default['destroy']>>>
    }
  }
  'devices.traffic': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/devices/:mac/traffic'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { mac: ParamValue }
      query: ExtractQueryForGet<InferInput<(typeof import('#validators/devices').trafficQueryValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/devices_controller').default['traffic']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/devices_controller').default['traffic']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'devices.peers': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/devices/:mac/peers'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { mac: ParamValue }
      query: ExtractQueryForGet<InferInput<(typeof import('#validators/devices').peersQueryValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/devices_controller').default['peers']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/devices_controller').default['peers']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'devices.peersHistory': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/devices/:mac/peers/history'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { mac: ParamValue }
      query: ExtractQueryForGet<InferInput<(typeof import('#validators/devices').peerHistoryQueryValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/devices_controller').default['peersHistory']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/devices_controller').default['peersHistory']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'devices.services': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/devices/:mac/services'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { mac: ParamValue }
      query: ExtractQueryForGet<InferInput<(typeof import('#validators/devices').servicesQueryValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/services_controller').default['device']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/services_controller').default['device']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'devices.destinations': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/devices/:mac/destinations'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { mac: ParamValue }
      query: ExtractQueryForGet<InferInput<(typeof import('#validators/devices').destinationsQueryValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/destinations_controller').default['device']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/destinations_controller').default['device']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'devices.overview': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/devices/:mac/overview'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { mac: ParamValue }
      query: ExtractQueryForGet<InferInput<(typeof import('#validators/devices').overviewQueryValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/devices_controller').default['overview']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/devices_controller').default['overview']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'devices.protocols': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/devices/:mac/protocols'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { mac: ParamValue }
      query: ExtractQueryForGet<InferInput<(typeof import('#validators/devices').protocolsQueryValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/devices_controller').default['protocols']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/devices_controller').default['protocols']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'wifi.wifi.overview': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/wifi/overview'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: ExtractQueryForGet<InferInput<(typeof import('#validators/wifi').wifiOverviewQueryValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/wifi_controller').default['overview']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/wifi_controller').default['overview']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'wifi.wifi.ssids': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/wifi/ssids'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: ExtractQueryForGet<InferInput<(typeof import('#validators/wifi').wifiSsidsQueryValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/wifi_controller').default['ssids']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/wifi_controller').default['ssids']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'wifi.wifi.ssid_clients': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/wifi/ssids/:ssid/clients'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { ssid: ParamValue }
      query: ExtractQueryForGet<InferInput<(typeof import('#validators/wifi').wifiSsidClientsQueryValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/wifi_controller').default['ssidClients']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/wifi_controller').default['ssidClients']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'wifi.wifi.ssid_throughput': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/wifi/ssids/:ssid/throughput'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { ssid: ParamValue }
      query: ExtractQueryForGet<InferInput<(typeof import('#validators/wifi').wifiSsidThroughputQueryValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/wifi_controller').default['ssidThroughput']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/wifi_controller').default['ssidThroughput']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'wifi.wifi.clients': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/wifi/clients'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: ExtractQueryForGet<InferInput<(typeof import('#validators/wifi').wifiClientsQueryValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/wifi_controller').default['clients']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/wifi_controller').default['clients']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'wifi.wifi.clients_history': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/wifi/clients/history'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: ExtractQueryForGet<InferInput<(typeof import('#validators/wifi').wifiClientsHistoryQueryValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/wifi_controller').default['clientsHistory']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/wifi_controller').default['clientsHistory']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'wifi.wifi.client': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/wifi/clients/:mac'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { mac: ParamValue }
      query: ExtractQueryForGet<InferInput<(typeof import('#validators/wifi').wifiClientMacParamValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/wifi_controller').default['client']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/wifi_controller').default['client']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'wifi.wifi.client_signal': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/wifi/clients/:mac/signal'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { mac: ParamValue }
      query: ExtractQueryForGet<InferInput<(typeof import('#validators/wifi').wifiClientMacParamValidator)>|InferInput<(typeof import('#validators/wifi').wifiClientSignalQueryValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/wifi_controller').default['clientSignal']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/wifi_controller').default['clientSignal']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'wifi.wifi.rf': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/wifi/rf'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: ExtractQueryForGet<InferInput<(typeof import('#validators/wifi').wifiRfQueryValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/wifi_controller').default['rf']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/wifi_controller').default['rf']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'wifi.wifi.rf_history': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/wifi/rf/history'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: ExtractQueryForGet<InferInput<(typeof import('#validators/wifi').wifiRfHistoryQueryValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/wifi_controller').default['rfHistory']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/wifi_controller').default['rfHistory']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'wifi.wifi.aps': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/wifi/aps'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: ExtractQueryForGet<InferInput<(typeof import('#validators/wifi').wifiApsQueryValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/wifi_controller').default['aps']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/wifi_controller').default['aps']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'wifi.wifi.aps_throughput': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/wifi/aps/throughput'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: ExtractQueryForGet<InferInput<(typeof import('#validators/wifi').wifiApThroughputQueryValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/wifi_controller').default['apsThroughput']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/wifi_controller').default['apsThroughput']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'wifi.wifi.ap_health': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/wifi/aps/:id/health'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQueryForGet<InferInput<(typeof import('#validators/wifi').wifiApHealthQueryValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/wifi_controller').default['apHealth']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/wifi_controller').default['apHealth']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'wifi.wifi.kick_client': {
    methods: ["POST"]
    pattern: '/api/v1/wifi/clients/:mac/kick'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/wifi').wifiClientMacParamValidator)>>
      paramsTuple: [ParamValue]
      params: { mac: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/wifi').wifiClientMacParamValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/wifi_controller').default['kickClient']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/wifi_controller').default['kickClient']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'wifi.wifi.steer_client': {
    methods: ["POST"]
    pattern: '/api/v1/wifi/clients/:mac/steer'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/wifi').wifiClientSteerValidator)>|InferInput<(typeof import('#validators/wifi').wifiClientMacParamValidator)>>
      paramsTuple: [ParamValue]
      params: { mac: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/wifi').wifiClientSteerValidator)>|InferInput<(typeof import('#validators/wifi').wifiClientMacParamValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/wifi_controller').default['steerClient']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/wifi_controller').default['steerClient']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'wifi.wifi.reboot_ap': {
    methods: ["POST"]
    pattern: '/api/v1/wifi/aps/:id/reboot'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/wifi_controller').default['rebootAp']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/wifi_controller').default['rebootAp']>>>
    }
  }
  'wifi.wifi.locate_ap': {
    methods: ["POST"]
    pattern: '/api/v1/wifi/aps/:id/locate'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/wifi').wifiApLocateValidator)>>
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/wifi').wifiApLocateValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/wifi_controller').default['locateAp']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/wifi_controller').default['locateAp']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
}
