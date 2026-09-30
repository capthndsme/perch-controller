/* eslint-disable prettier/prettier */
/// <reference path="../manifest.d.ts" />

import type { ExtractBody, ExtractErrorResponse, ExtractQuery, ExtractQueryForGet, ExtractResponse } from '@tuyau/core/types'
import type { InferInput, SimpleError } from '@vinejs/vine/types'

export type ParamValue = string | number | bigint | boolean

export interface Registry {
  'gatewaySync.wan': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/gateways/:id/wan'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_wan_controller').default['index']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_wan_controller').default['index']>>>
    }
  }
  'gatewaySync.wanHistory': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/gateways/:id/wan/history'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQueryForGet<InferInput<(typeof import('#validators/gateway_wan').wanHistoryValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_wan_controller').default['history']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_wan_controller').default['history']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'gatewaySync.wanOrder': {
    methods: ["PUT"]
    pattern: '/api/v1/gateways/:id/wan/order'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/gateway_wan').wanOrderValidator)>>
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/gateway_wan').wanOrderValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_wan_controller').default['order']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_wan_controller').default['order']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'gatewaySync.wanCreate': {
    methods: ["POST"]
    pattern: '/api/v1/gateways/:id/wan'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/gateway_wan').wanCreateValidator)>>
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/gateway_wan').wanCreateValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_wan_controller').default['create']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_wan_controller').default['create']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'gatewaySync.wanAliasUpdate': {
    methods: ["PATCH"]
    pattern: '/api/v1/gateways/:id/wan/aliases/:perchId'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/gateway_wan').wanAliasPatchValidator)>>
      paramsTuple: [ParamValue, ParamValue]
      params: { id: ParamValue; perchId: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/gateway_wan').wanAliasPatchValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_wan_controller').default['updateAlias']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_wan_controller').default['updateAlias']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'gatewaySync.wanAliasDelete': {
    methods: ["DELETE"]
    pattern: '/api/v1/gateways/:id/wan/aliases/:perchId'
    types: {
      body: {}
      paramsTuple: [ParamValue, ParamValue]
      params: { id: ParamValue; perchId: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_wan_controller').default['deleteAlias']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_wan_controller').default['deleteAlias']>>>
    }
  }
  'gatewaySync.wanShow': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/gateways/:id/wan/:perchId'
    types: {
      body: {}
      paramsTuple: [ParamValue, ParamValue]
      params: { id: ParamValue; perchId: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_wan_controller').default['show']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_wan_controller').default['show']>>>
    }
  }
  'gatewaySync.wanUpdate': {
    methods: ["PATCH"]
    pattern: '/api/v1/gateways/:id/wan/:perchId'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/gateway_wan').wanPatchValidator)>>
      paramsTuple: [ParamValue, ParamValue]
      params: { id: ParamValue; perchId: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/gateway_wan').wanPatchValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_wan_controller').default['update']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_wan_controller').default['update']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'gatewaySync.wanDelete': {
    methods: ["DELETE"]
    pattern: '/api/v1/gateways/:id/wan/:perchId'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/gateway_wan').wanDeleteValidator)>>
      paramsTuple: [ParamValue, ParamValue]
      params: { id: ParamValue; perchId: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/gateway_wan').wanDeleteValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_wan_controller').default['destroy']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_wan_controller').default['destroy']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'gatewaySync.wanAliasCreate': {
    methods: ["POST"]
    pattern: '/api/v1/gateways/:id/wan/:perchId/aliases'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/gateway_wan').wanAliasCreateValidator)>>
      paramsTuple: [ParamValue, ParamValue]
      params: { id: ParamValue; perchId: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/gateway_wan').wanAliasCreateValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_wan_controller').default['createAlias']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_wan_controller').default['createAlias']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'gatewaySync.wireguardConfig': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/gateways/:id/wireguard/config'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_wireguard_controller').default['index']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_wireguard_controller').default['index']>>>
    }
  }
  'gatewaySync.wireguardInterfaceCreate': {
    methods: ["POST"]
    pattern: '/api/v1/gateways/:id/wireguard/interfaces'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/gateway_sync_services').wgInterfaceCreateValidator)>>
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/gateway_sync_services').wgInterfaceCreateValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_wireguard_controller').default['createInterface']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_wireguard_controller').default['createInterface']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'gatewaySync.wireguardInterfaceUpdate': {
    methods: ["PATCH"]
    pattern: '/api/v1/gateways/:id/wireguard/interfaces/:perchId'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/gateway_sync_services').wgInterfacePatchValidator)>>
      paramsTuple: [ParamValue, ParamValue]
      params: { id: ParamValue; perchId: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/gateway_sync_services').wgInterfacePatchValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_wireguard_controller').default['updateInterface']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_wireguard_controller').default['updateInterface']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'gatewaySync.wireguardInterfaceDelete': {
    methods: ["DELETE"]
    pattern: '/api/v1/gateways/:id/wireguard/interfaces/:perchId'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/gateway_sync_services').wgConfirmValidator)>>
      paramsTuple: [ParamValue, ParamValue]
      params: { id: ParamValue; perchId: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/gateway_sync_services').wgConfirmValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_wireguard_controller').default['deleteInterface']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_wireguard_controller').default['deleteInterface']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'gatewaySync.wireguardRotateKey': {
    methods: ["POST"]
    pattern: '/api/v1/gateways/:id/wireguard/interfaces/:perchId/rotate-key'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/gateway_sync_services').wgRotateValidator)>>
      paramsTuple: [ParamValue, ParamValue]
      params: { id: ParamValue; perchId: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/gateway_sync_services').wgRotateValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_wireguard_controller').default['rotateKey']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_wireguard_controller').default['rotateKey']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'gatewaySync.wireguardPeerCreate': {
    methods: ["POST"]
    pattern: '/api/v1/gateways/:id/wireguard/interfaces/:perchId/peers'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/gateway_sync_services').wgPeerCreateValidator)>>
      paramsTuple: [ParamValue, ParamValue]
      params: { id: ParamValue; perchId: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/gateway_sync_services').wgPeerCreateValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_wireguard_controller').default['createPeer']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_wireguard_controller').default['createPeer']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'gatewaySync.wireguardPeerUpdate': {
    methods: ["PATCH"]
    pattern: '/api/v1/gateways/:id/wireguard/peers/:perchId'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/gateway_sync_services').wgPeerPatchValidator)>>
      paramsTuple: [ParamValue, ParamValue]
      params: { id: ParamValue; perchId: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/gateway_sync_services').wgPeerPatchValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_wireguard_controller').default['updatePeer']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_wireguard_controller').default['updatePeer']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'gatewaySync.wireguardPeerDelete': {
    methods: ["DELETE"]
    pattern: '/api/v1/gateways/:id/wireguard/peers/:perchId'
    types: {
      body: {}
      paramsTuple: [ParamValue, ParamValue]
      params: { id: ParamValue; perchId: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_wireguard_controller').default['deletePeer']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_wireguard_controller').default['deletePeer']>>>
    }
  }
  'gatewaySync.ipv6': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/gateways/:id/ipv6'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_ipv6_controller').default['show']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_ipv6_controller').default['show']>>>
    }
  }
  'gatewaySync.ipv6Update': {
    methods: ["PATCH"]
    pattern: '/api/v1/gateways/:id/ipv6'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/gateway_sync_services').ipv6PatchValidator)>>
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/gateway_sync_services').ipv6PatchValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_ipv6_controller').default['update']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_ipv6_controller').default['update']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'gatewaySync.ipv6LanUpdate': {
    methods: ["PATCH"]
    pattern: '/api/v1/gateways/:id/ipv6/lans/:network'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/gateway_sync_services').ipv6LanPatchValidator)>>
      paramsTuple: [ParamValue, ParamValue]
      params: { id: ParamValue; network: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/gateway_sync_services').ipv6LanPatchValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_ipv6_controller').default['updateLan']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_ipv6_controller').default['updateLan']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'gatewaySync.ambiguities': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/gateways/:id/ambiguities'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_ambiguities_controller').default['index']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_ambiguities_controller').default['index']>>>
    }
  }
  'gatewaySync.ambiguitiesResolve': {
    methods: ["POST"]
    pattern: '/api/v1/gateways/:id/ambiguities/resolve'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/gateway_sync').ambiguityResolveValidator)>>
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/gateway_sync').ambiguityResolveValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_ambiguities_controller').default['resolve']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_ambiguities_controller').default['resolve']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'gatewaySync.firewallDefaults': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/gateways/:id/firewall/defaults'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_firewall_defaults_controller').default['show']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_firewall_defaults_controller').default['show']>>>
    }
  }
  'gatewaySync.firewallDefaultsUpdate': {
    methods: ["PATCH"]
    pattern: '/api/v1/gateways/:id/firewall/defaults'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/gateway_sync').firewallDefaultsPatchValidator)>>
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/gateway_sync').firewallDefaultsPatchValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_firewall_defaults_controller').default['update']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_firewall_defaults_controller').default['update']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'gatewaySync.upnpConfig': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/gateways/:id/upnp/config'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_upnp_controller').default['show']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_upnp_controller').default['show']>>>
    }
  }
  'gatewaySync.upnpConfigUpdate': {
    methods: ["PATCH"]
    pattern: '/api/v1/gateways/:id/upnp/config'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/gateway_sync_services').upnpConfigPatchValidator)>>
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/gateway_sync_services').upnpConfigPatchValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_upnp_controller').default['update']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_upnp_controller').default['update']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'gatewaySync.upnpAclOrder': {
    methods: ["PUT"]
    pattern: '/api/v1/gateways/:id/upnp/acl/order'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/gateway_sync_services').upnpAclOrderValidator)>>
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/gateway_sync_services').upnpAclOrderValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_upnp_controller').default['orderAcl']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_upnp_controller').default['orderAcl']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'gatewaySync.upnpAclCreate': {
    methods: ["POST"]
    pattern: '/api/v1/gateways/:id/upnp/acl'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/gateway_sync_services').upnpAclCreateValidator)>>
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/gateway_sync_services').upnpAclCreateValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_upnp_controller').default['createAcl']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_upnp_controller').default['createAcl']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'gatewaySync.upnpAclUpdate': {
    methods: ["PATCH"]
    pattern: '/api/v1/gateways/:id/upnp/acl/:perchId'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/gateway_sync_services').upnpAclPatchValidator)>>
      paramsTuple: [ParamValue, ParamValue]
      params: { id: ParamValue; perchId: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/gateway_sync_services').upnpAclPatchValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_upnp_controller').default['updateAcl']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_upnp_controller').default['updateAcl']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'gatewaySync.upnpAclDelete': {
    methods: ["DELETE"]
    pattern: '/api/v1/gateways/:id/upnp/acl/:perchId'
    types: {
      body: {}
      paramsTuple: [ParamValue, ParamValue]
      params: { id: ParamValue; perchId: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_upnp_controller').default['deleteAcl']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_upnp_controller').default['deleteAcl']>>>
    }
  }
  'gatewaySync.upnpMappingsDelete': {
    methods: ["POST"]
    pattern: '/api/v1/gateways/:id/upnp/mappings/delete'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/gateway_sync_services').upnpMappingsDeleteValidator)>>
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/gateway_sync_services').upnpMappingsDeleteValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_upnp_controller').default['deleteMappings']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_upnp_controller').default['deleteMappings']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'gatewaySync.upnpDeviceBlock': {
    methods: ["PUT"]
    pattern: '/api/v1/gateways/:id/upnp/devices/:mac'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/gateway_sync_services').upnpDeviceBlockValidator)>>
      paramsTuple: [ParamValue, ParamValue]
      params: { id: ParamValue; mac: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/gateway_sync_services').upnpDeviceBlockValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_upnp_controller').default['blockDevice']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_upnp_controller').default['blockDevice']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'gatewaySync.ddns': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/gateways/:id/ddns'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_ddns_controller').default['index']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_ddns_controller').default['index']>>>
    }
  }
  'gatewaySync.ddnsServiceCreate': {
    methods: ["POST"]
    pattern: '/api/v1/gateways/:id/ddns/services'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/gateway_sync_services').ddnsServiceCreateValidator)>>
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/gateway_sync_services').ddnsServiceCreateValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_ddns_controller').default['createService']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_ddns_controller').default['createService']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'gatewaySync.ddnsServiceUpdate': {
    methods: ["PATCH"]
    pattern: '/api/v1/gateways/:id/ddns/services/:perchId'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/gateway_sync_services').ddnsServicePatchValidator)>>
      paramsTuple: [ParamValue, ParamValue]
      params: { id: ParamValue; perchId: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/gateway_sync_services').ddnsServicePatchValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_ddns_controller').default['updateService']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_ddns_controller').default['updateService']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'gatewaySync.ddnsServiceDelete': {
    methods: ["DELETE"]
    pattern: '/api/v1/gateways/:id/ddns/services/:perchId'
    types: {
      body: {}
      paramsTuple: [ParamValue, ParamValue]
      params: { id: ParamValue; perchId: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_ddns_controller').default['deleteService']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_ddns_controller').default['deleteService']>>>
    }
  }
  'gatewaySync.ddnsUpdateNow': {
    methods: ["POST"]
    pattern: '/api/v1/gateways/:id/ddns/services/:perchId/update-now'
    types: {
      body: {}
      paramsTuple: [ParamValue, ParamValue]
      params: { id: ParamValue; perchId: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_ddns_controller').default['updateNow']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_ddns_controller').default['updateNow']>>>
    }
  }
  'gatewaySync.multiwan': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/gateways/:id/multiwan'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_multiwan_controller').default['show']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_multiwan_controller').default['show']>>>
    }
  }
  'gatewaySyncSettings.show': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/settings/gateway-sync'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_sync_settings_controller').default['show']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_sync_settings_controller').default['show']>>>
    }
  }
  'gatewaySyncSettings.update': {
    methods: ["PATCH"]
    pattern: '/api/v1/settings/gateway-sync'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/gateway_wan').gatewaySyncSettingsPatchValidator)>>
      paramsTuple: []
      params: {}
      query: ExtractQuery<InferInput<(typeof import('#validators/gateway_wan').gatewaySyncSettingsPatchValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_sync_settings_controller').default['update']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_sync_settings_controller').default['update']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'alerts.push.renew': {
    methods: ["POST"]
    pattern: '/api/v1/alerts/push/renew'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/alert_push').pushRenewValidator)>>
      paramsTuple: []
      params: {}
      query: ExtractQuery<InferInput<(typeof import('#validators/alert_push').pushRenewValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/alert_push_controller').default['renew']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/alert_push_controller').default['renew']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'alerts.summary': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/alerts/summary'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/alerts_controller').default['summary']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/alerts_controller').default['summary']>>>
    }
  }
  'alerts.catalogue': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/alerts/catalogue'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/alerts_controller').default['catalogue']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/alerts_controller').default['catalogue']>>>
    }
  }
  'alerts.read': {
    methods: ["POST"]
    pattern: '/api/v1/alerts/read'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/alerts').alertReadValidator)>>
      paramsTuple: []
      params: {}
      query: ExtractQuery<InferInput<(typeof import('#validators/alerts').alertReadValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/alerts_controller').default['read']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/alerts_controller').default['read']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'alerts.mutes.index': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/alerts/mutes'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/alert_mutes_controller').default['index']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/alert_mutes_controller').default['index']>>>
    }
  }
  'alerts.watches.index': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/alerts/watches'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: ExtractQueryForGet<InferInput<(typeof import('#validators/alerts').alertWatchListValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/alert_mutes_controller').default['watches']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/alert_mutes_controller').default['watches']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'alerts.push.config': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/alerts/push/config'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/alert_push_controller').default['config']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/alert_push_controller').default['config']>>>
    }
  }
  'alerts.push.index': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/alerts/push/subscriptions'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/alert_push_controller').default['index']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/alert_push_controller').default['index']>>>
    }
  }
  'alerts.push.store': {
    methods: ["POST"]
    pattern: '/api/v1/alerts/push/subscriptions'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/alert_push').pushSubscribeValidator)>>
      paramsTuple: []
      params: {}
      query: ExtractQuery<InferInput<(typeof import('#validators/alert_push').pushSubscribeValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/alert_push_controller').default['store']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/alert_push_controller').default['store']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'alerts.push.unsubscribe': {
    methods: ["POST"]
    pattern: '/api/v1/alerts/push/subscriptions/unsubscribe'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/alert_push').pushUnsubscribeValidator)>>
      paramsTuple: []
      params: {}
      query: ExtractQuery<InferInput<(typeof import('#validators/alert_push').pushUnsubscribeValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/alert_push_controller').default['unsubscribe']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/alert_push_controller').default['unsubscribe']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'alerts.push.update': {
    methods: ["PATCH"]
    pattern: '/api/v1/alerts/push/subscriptions/:id'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/alert_push').pushUpdateValidator)>>
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/alert_push').pushUpdateValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/alert_push_controller').default['update']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/alert_push_controller').default['update']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'alerts.push.destroy': {
    methods: ["DELETE"]
    pattern: '/api/v1/alerts/push/subscriptions/:id'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/alert_push_controller').default['destroy']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/alert_push_controller').default['destroy']>>>
    }
  }
  'alerts.push.test': {
    methods: ["POST"]
    pattern: '/api/v1/alerts/push/subscriptions/:id/test'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/alert_push_controller').default['test']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/alert_push_controller').default['test']>>>
    }
  }
  'alerts.index': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/alerts'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: ExtractQueryForGet<InferInput<(typeof import('#validators/alerts').alertListValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/alerts_controller').default['index']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/alerts_controller').default['index']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'alerts.show': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/alerts/:id'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/alerts_controller').default['show']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/alerts_controller').default['show']>>>
    }
  }
  'alerts.mutes.store': {
    methods: ["POST"]
    pattern: '/api/v1/alerts/mutes'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/alerts').alertMuteValidator)>>
      paramsTuple: []
      params: {}
      query: ExtractQuery<InferInput<(typeof import('#validators/alerts').alertMuteValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/alert_mutes_controller').default['store']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/alert_mutes_controller').default['store']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'alerts.mutes.destroy': {
    methods: ["DELETE"]
    pattern: '/api/v1/alerts/mutes/:id'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/alert_mutes_controller').default['destroy']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/alert_mutes_controller').default['destroy']>>>
    }
  }
  'alerts.watches.update': {
    methods: ["PUT"]
    pattern: '/api/v1/alerts/watches/devices/:mac'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/alerts').alertWatchValidator)>>
      paramsTuple: [ParamValue]
      params: { mac: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/alerts').alertWatchValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/alert_mutes_controller').default['updateWatch']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/alert_mutes_controller').default['updateWatch']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'alerts.deliveries.index': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/alerts/deliveries'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: ExtractQueryForGet<InferInput<(typeof import('#validators/alert_settings').alertDeliveryListValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/alert_deliveries_controller').default['index']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/alert_deliveries_controller').default['index']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'alerts.deliveries.show': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/alerts/deliveries/:id'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/alert_deliveries_controller').default['show']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/alert_deliveries_controller').default['show']>>>
    }
  }
  'alerts.acknowledge': {
    methods: ["POST"]
    pattern: '/api/v1/alerts/:id/acknowledge'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/alerts').alertNoteValidator)>>
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/alerts').alertNoteValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/alerts_controller').default['acknowledge']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/alerts_controller').default['acknowledge']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'alerts.resolve': {
    methods: ["POST"]
    pattern: '/api/v1/alerts/:id/resolve'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/alerts').alertNoteValidator)>>
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/alerts').alertNoteValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/alerts_controller').default['resolve']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/alerts_controller').default['resolve']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'settings.alerts.show': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/settings/alerts'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/alert_settings_controller').default['show']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/alert_settings_controller').default['show']>>>
    }
  }
  'settings.alerts.update': {
    methods: ["PATCH"]
    pattern: '/api/v1/settings/alerts'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/alert_settings').alertSettingsUpdateValidator)>>
      paramsTuple: []
      params: {}
      query: ExtractQuery<InferInput<(typeof import('#validators/alert_settings').alertSettingsUpdateValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/alert_settings_controller').default['update']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/alert_settings_controller').default['update']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'settings.alerts.test': {
    methods: ["POST"]
    pattern: '/api/v1/settings/alerts/test'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/alert_settings').alertTestValidator)>>
      paramsTuple: []
      params: {}
      query: ExtractQuery<InferInput<(typeof import('#validators/alert_settings').alertTestValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/alert_settings_controller').default['test']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/alert_settings_controller').default['test']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'settings.alerts.vapid.rotate': {
    methods: ["POST"]
    pattern: '/api/v1/settings/alerts/vapid/rotate'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/alert_push').vapidRotateValidator)>>
      paramsTuple: []
      params: {}
      query: ExtractQuery<InferInput<(typeof import('#validators/alert_push').vapidRotateValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/alert_push_controller').default['rotate']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/alert_push_controller').default['rotate']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'settings.alerts.webhooks.index': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/settings/alerts/webhooks'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/alert_webhooks_controller').default['index']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/alert_webhooks_controller').default['index']>>>
    }
  }
  'settings.alerts.webhooks.store': {
    methods: ["POST"]
    pattern: '/api/v1/settings/alerts/webhooks'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/alert_webhooks').webhookCreateValidator)>>
      paramsTuple: []
      params: {}
      query: ExtractQuery<InferInput<(typeof import('#validators/alert_webhooks').webhookCreateValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/alert_webhooks_controller').default['store']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/alert_webhooks_controller').default['store']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'settings.alerts.webhooks.show': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/settings/alerts/webhooks/:id'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/alert_webhooks_controller').default['show']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/alert_webhooks_controller').default['show']>>>
    }
  }
  'settings.alerts.webhooks.update': {
    methods: ["PATCH"]
    pattern: '/api/v1/settings/alerts/webhooks/:id'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/alert_webhooks').webhookUpdateValidator)>>
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/alert_webhooks').webhookUpdateValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/alert_webhooks_controller').default['update']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/alert_webhooks_controller').default['update']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'settings.alerts.webhooks.destroy': {
    methods: ["DELETE"]
    pattern: '/api/v1/settings/alerts/webhooks/:id'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/alert_webhooks_controller').default['destroy']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/alert_webhooks_controller').default['destroy']>>>
    }
  }
  'settings.alerts.webhooks.test': {
    methods: ["POST"]
    pattern: '/api/v1/settings/alerts/webhooks/:id/test'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/alert_webhooks_controller').default['test']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/alert_webhooks_controller').default['test']>>>
    }
  }
  'settings.alerts.webhooks.rotateSecret': {
    methods: ["POST"]
    pattern: '/api/v1/settings/alerts/webhooks/:id/rotate-secret'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/alert_webhooks_controller').default['rotateSecret']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/alert_webhooks_controller').default['rotateSecret']>>>
    }
  }
  'agentUpdates.download': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/agent-updates/files/:artefactId/:file'
    types: {
      body: {}
      paramsTuple: [ParamValue, ParamValue]
      params: { artefactId: ParamValue; file: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/agent_artefacts_controller').default['download']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/agent_artefacts_controller').default['download']>>>
    }
  }
  'agentUpdates.fleet': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/agent-updates/fleet'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: ExtractQueryForGet<InferInput<(typeof import('#validators/agent_updates').fleetQueryValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/agent_updates_controller').default['fleet']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/agent_updates_controller').default['fleet']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'agentUpdates.jobs': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/agent-updates/jobs'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: ExtractQueryForGet<InferInput<(typeof import('#validators/agent_updates').jobsQueryValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/agent_updates_controller').default['jobs']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/agent_updates_controller').default['jobs']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'agentUpdates.job': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/agent-updates/jobs/:id'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/agent_updates_controller').default['job']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/agent_updates_controller').default['job']>>>
    }
  }
  'agentUpdates.events': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/agent-updates/events'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: ExtractQueryForGet<InferInput<(typeof import('#validators/agent_updates').eventsQueryValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/agent_updates_controller').default['events']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/agent_updates_controller').default['events']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'agentUpdates.releases': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/agent-updates/releases'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: ExtractQueryForGet<InferInput<(typeof import('#validators/agent_updates').releasesIndexValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/agent_releases_controller').default['index']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/agent_releases_controller').default['index']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'agentUpdates.release': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/agent-updates/releases/:id'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/agent_releases_controller').default['show']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/agent_releases_controller').default['show']>>>
    }
  }
  'agentUpdates.rollouts': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/agent-updates/rollouts'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: ExtractQueryForGet<InferInput<(typeof import('#validators/agent_updates').rolloutsQueryValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/agent_rollouts_controller').default['index']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/agent_rollouts_controller').default['index']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'agentUpdates.rollout': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/agent-updates/rollouts/:id'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/agent_rollouts_controller').default['show']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/agent_rollouts_controller').default['show']>>>
    }
  }
  'agentUpdates.updateDevice': {
    methods: ["PATCH"]
    pattern: '/api/v1/agent-updates/devices/:kind/:id'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/agent_updates').deviceSettingsValidator)>>
      paramsTuple: [ParamValue, ParamValue]
      params: { kind: ParamValue; id: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/agent_updates').deviceSettingsValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/agent_updates_controller').default['updateDevice']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/agent_updates_controller').default['updateDevice']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'agentUpdates.refreshDevice': {
    methods: ["POST"]
    pattern: '/api/v1/agent-updates/devices/:kind/:id/refresh'
    types: {
      body: {}
      paramsTuple: [ParamValue, ParamValue]
      params: { kind: ParamValue; id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/agent_updates_controller').default['refresh']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/agent_updates_controller').default['refresh']>>>
    }
  }
  'agentUpdates.preflightDevice': {
    methods: ["POST"]
    pattern: '/api/v1/agent-updates/devices/:kind/:id/preflight'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/agent_updates').preflightValidator)>>
      paramsTuple: [ParamValue, ParamValue]
      params: { kind: ParamValue; id: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/agent_updates').preflightValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/agent_updates_controller').default['preflight']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/agent_updates_controller').default['preflight']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'agentUpdates.updateDeviceVersion': {
    methods: ["POST"]
    pattern: '/api/v1/agent-updates/devices/:kind/:id/update'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/agent_updates').updateDeviceValidator)>>
      paramsTuple: [ParamValue, ParamValue]
      params: { kind: ParamValue; id: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/agent_updates').updateDeviceValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/agent_updates_controller').default['update']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/agent_updates_controller').default['update']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'agentUpdates.rollbackDevice': {
    methods: ["POST"]
    pattern: '/api/v1/agent-updates/devices/:kind/:id/rollback'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/agent_updates').rollbackDeviceValidator)>>
      paramsTuple: [ParamValue, ParamValue]
      params: { kind: ParamValue; id: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/agent_updates').rollbackDeviceValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/agent_updates_controller').default['rollback']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/agent_updates_controller').default['rollback']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'agentUpdates.abortJob': {
    methods: ["POST"]
    pattern: '/api/v1/agent-updates/jobs/:id/abort'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/agent_updates_controller').default['abort']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/agent_updates_controller').default['abort']>>>
    }
  }
  'agentUpdates.checkReleases': {
    methods: ["POST"]
    pattern: '/api/v1/agent-updates/releases/check'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/agent_releases_controller').default['check']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/agent_releases_controller').default['check']>>>
    }
  }
  'agentUpdates.storeRelease': {
    methods: ["POST"]
    pattern: '/api/v1/agent-updates/releases'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/agent_updates').releaseCreateValidator)>>
      paramsTuple: []
      params: {}
      query: ExtractQuery<InferInput<(typeof import('#validators/agent_updates').releaseCreateValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/agent_releases_controller').default['store']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/agent_releases_controller').default['store']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'agentUpdates.uploadReleaseFile': {
    methods: ["PUT"]
    pattern: '/api/v1/agent-updates/releases/:id/files/:file'
    types: {
      body: {}
      paramsTuple: [ParamValue, ParamValue]
      params: { id: ParamValue; file: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/agent_releases_controller').default['upload']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/agent_releases_controller').default['upload']>>>
    }
  }
  'agentUpdates.updateRelease': {
    methods: ["PATCH"]
    pattern: '/api/v1/agent-updates/releases/:id'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/agent_updates').releaseUpdateValidator)>>
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/agent_updates').releaseUpdateValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/agent_releases_controller').default['update']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/agent_releases_controller').default['update']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'agentUpdates.destroyRelease': {
    methods: ["DELETE"]
    pattern: '/api/v1/agent-updates/releases/:id'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/agent_releases_controller').default['destroy']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/agent_releases_controller').default['destroy']>>>
    }
  }
  'agentUpdates.storeRollout': {
    methods: ["POST"]
    pattern: '/api/v1/agent-updates/rollouts'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/agent_updates').rolloutCreateValidator)>>
      paramsTuple: []
      params: {}
      query: ExtractQuery<InferInput<(typeof import('#validators/agent_updates').rolloutCreateValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/agent_rollouts_controller').default['store']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/agent_rollouts_controller').default['store']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'agentUpdates.pauseRollout': {
    methods: ["POST"]
    pattern: '/api/v1/agent-updates/rollouts/:id/pause'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/agent_rollouts_controller').default['pause']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/agent_rollouts_controller').default['pause']>>>
    }
  }
  'agentUpdates.resumeRollout': {
    methods: ["POST"]
    pattern: '/api/v1/agent-updates/rollouts/:id/resume'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/agent_updates').rolloutResumeValidator)>>
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/agent_updates').rolloutResumeValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/agent_rollouts_controller').default['resume']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/agent_rollouts_controller').default['resume']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'agentUpdates.cancelRollout': {
    methods: ["POST"]
    pattern: '/api/v1/agent-updates/rollouts/:id/cancel'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/agent_rollouts_controller').default['cancel']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/agent_rollouts_controller').default['cancel']>>>
    }
  }
  'settings.agentUpdates': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/settings/agent-updates'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/agent_updates_controller').default['settings']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/agent_updates_controller').default['settings']>>>
    }
  }
  'settings.updateAgentUpdates': {
    methods: ["PATCH"]
    pattern: '/api/v1/settings/agent-updates'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/agent_updates').agentUpdateSettingsValidator)>>
      paramsTuple: []
      params: {}
      query: ExtractQuery<InferInput<(typeof import('#validators/agent_updates').agentUpdateSettingsValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/agent_updates_controller').default['updateSettings']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/agent_updates_controller').default['updateSettings']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
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
  'setup.login': {
    methods: ["POST"]
    pattern: '/api/v1/setup/login'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/user').loginValidator)>>
      paramsTuple: []
      params: {}
      query: ExtractQuery<InferInput<(typeof import('#validators/user').loginValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/setup_controller').default['login']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/setup_controller').default['login']>>> | { status: 422; response: { errors: SimpleError[] } }
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
  'setup.collector.candidates': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/setup/collector/candidates'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/setup_controller').default['candidates']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/setup_controller').default['candidates']>>>
    }
  }
  'setup.collector.skip': {
    methods: ["POST"]
    pattern: '/api/v1/setup/collector/skip'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/setup_controller').default['skipCollector']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/setup_controller').default['skipCollector']>>>
    }
  }
  'setup.collector.adopt': {
    methods: ["POST"]
    pattern: '/api/v1/setup/collector/:id/adopt'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/collectors').collectorAdoptValidator)>>
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/collectors').collectorAdoptValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/setup_controller').default['adopt']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/setup_controller').default['adopt']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'version': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/version'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/version_controller').default['show']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/version_controller').default['show']>>>
    }
  }
  'collectors.announce': {
    methods: ["POST"]
    pattern: '/api/v1/collectors/announce'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/collectors').collectorAnnounceValidator)>>
      paramsTuple: []
      params: {}
      query: ExtractQuery<InferInput<(typeof import('#validators/collectors').collectorAnnounceValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/collectors_controller').default['announce']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/collectors_controller').default['announce']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'apAgent.join': {
    methods: ["POST"]
    pattern: '/api/v1/ap-agent/join'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/ap_agents').apAgentJoinValidator)>>
      paramsTuple: []
      params: {}
      query: ExtractQuery<InferInput<(typeof import('#validators/ap_agents').apAgentJoinValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/ap_agents_controller').default['join']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/ap_agents_controller').default['join']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'apAgent.wsFallback': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/ap-agent/ws'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/agent_sockets_controller').default['fallback']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/agent_sockets_controller').default['fallback']>>>
    }
  }
  'collectorAgent.wsFallback': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/collector-agent/ws'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/agent_sockets_controller').default['fallback']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/agent_sockets_controller').default['fallback']>>>
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
  'settings.settings.hostname_enrichment_sources': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/settings/hostname-enrichment/sources'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/settings_controller').default['hostnameEnrichmentSources']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/settings_controller').default['hostnameEnrichmentSources']>>>
    }
  }
  'settings.presence': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/settings/presence'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/settings_controller').default['presence']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/settings_controller').default['presence']>>>
    }
  }
  'settings.updatePresence': {
    methods: ["PATCH"]
    pattern: '/api/v1/settings/presence'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/presence_settings').updatePresenceSettingsValidator)>>
      paramsTuple: []
      params: {}
      query: ExtractQuery<InferInput<(typeof import('#validators/presence_settings').updatePresenceSettingsValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/settings_controller').default['updatePresence']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/settings_controller').default['updatePresence']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'settings.gateway': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/settings/gateway'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_settings_controller').default['show']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_settings_controller').default['show']>>>
    }
  }
  'settings.updateGateway': {
    methods: ["PATCH"]
    pattern: '/api/v1/settings/gateway'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/gateway_config_settings').updateGatewayConfigSettingsValidator)>>
      paramsTuple: []
      params: {}
      query: ExtractQuery<InferInput<(typeof import('#validators/gateway_config_settings').updateGatewayConfigSettingsValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_settings_controller').default['update']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_settings_controller').default['update']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'settings.gatewayObservations': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/settings/gateway-observations'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_observations_controller').default['settings']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_observations_controller').default['settings']>>>
    }
  }
  'settings.updateGatewayObservations': {
    methods: ["PATCH"]
    pattern: '/api/v1/settings/gateway-observations'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/gateway_observation_settings').updateGatewayObservationSettingsValidator)>>
      paramsTuple: []
      params: {}
      query: ExtractQuery<InferInput<(typeof import('#validators/gateway_observation_settings').updateGatewayObservationSettingsValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_observations_controller').default['updateSettings']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_observations_controller').default['updateSettings']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'settings.qos': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/settings/qos'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/settings_controller').default['qos']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/settings_controller').default['qos']>>>
    }
  }
  'settings.updateQos': {
    methods: ["PATCH"]
    pattern: '/api/v1/settings/qos'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/qos_settings').updateQosSettingsValidator)>>
      paramsTuple: []
      params: {}
      query: ExtractQuery<InferInput<(typeof import('#validators/qos_settings').updateQosSettingsValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/settings_controller').default['updateQos']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/settings_controller').default['updateQos']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'settings.charts': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/settings/charts'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/settings_controller').default['charts']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/settings_controller').default['charts']>>>
    }
  }
  'settings.updateCharts': {
    methods: ["PATCH"]
    pattern: '/api/v1/settings/charts'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/chart_settings').updateChartSettingsValidator)>>
      paramsTuple: []
      params: {}
      query: ExtractQuery<InferInput<(typeof import('#validators/chart_settings').updateChartSettingsValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/settings_controller').default['updateCharts']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/settings_controller').default['updateCharts']>>> | { status: 422; response: { errors: SimpleError[] } }
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
  'settings.wifiSources.agentPing': {
    methods: ["POST"]
    pattern: '/api/v1/settings/wifi-sources/:id/agent/ping'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/ap_agents_controller').default['ping']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/ap_agents_controller').default['ping']>>>
    }
  }
  'settings.wifiSources.agentForget': {
    methods: ["DELETE"]
    pattern: '/api/v1/settings/wifi-sources/:id/agent'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/ap_agents_controller').default['forget']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/ap_agents_controller').default['forget']>>>
    }
  }
  'settings.apJoinTokens.index': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/settings/ap-join-tokens'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/ap_join_tokens_controller').default['index']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/ap_join_tokens_controller').default['index']>>>
    }
  }
  'settings.apJoinTokens.store': {
    methods: ["POST"]
    pattern: '/api/v1/settings/ap-join-tokens'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/ap_agents').apJoinTokenCreateValidator)>>
      paramsTuple: []
      params: {}
      query: ExtractQuery<InferInput<(typeof import('#validators/ap_agents').apJoinTokenCreateValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/ap_join_tokens_controller').default['store']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/ap_join_tokens_controller').default['store']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'settings.apJoinTokens.reveal': {
    methods: ["POST"]
    pattern: '/api/v1/settings/ap-join-tokens/:id/reveal'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/ap_join_tokens_controller').default['reveal']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/ap_join_tokens_controller').default['reveal']>>>
    }
  }
  'settings.apJoinTokens.destroy': {
    methods: ["DELETE"]
    pattern: '/api/v1/settings/ap-join-tokens/:id'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/ap_join_tokens_controller').default['destroy']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/ap_join_tokens_controller').default['destroy']>>>
    }
  }
  'settings.apAgent.install': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/settings/ap-agent/install'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/ap_agents_controller').default['installInfo']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/ap_agents_controller').default['installInfo']>>>
    }
  }
  'settings.collectors.index': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/settings/collectors'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/collectors_controller').default['index']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/collectors_controller').default['index']>>>
    }
  }
  'settings.collectors.store': {
    methods: ["POST"]
    pattern: '/api/v1/settings/collectors'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/collectors').collectorCreateValidator)>>
      paramsTuple: []
      params: {}
      query: ExtractQuery<InferInput<(typeof import('#validators/collectors').collectorCreateValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/collectors_controller').default['store']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/collectors_controller').default['store']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'settings.collectors.discovery': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/settings/collectors/discovery'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/collectors_controller').default['discovery']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/collectors_controller').default['discovery']>>>
    }
  }
  'settings.collectors.updateDiscovery': {
    methods: ["PATCH"]
    pattern: '/api/v1/settings/collectors/discovery'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/collectors').collectorDiscoveryValidator)>>
      paramsTuple: []
      params: {}
      query: ExtractQuery<InferInput<(typeof import('#validators/collectors').collectorDiscoveryValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/collectors_controller').default['updateDiscovery']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/collectors_controller').default['updateDiscovery']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'settings.collectors.probeDraft': {
    methods: ["POST"]
    pattern: '/api/v1/settings/collectors/probe'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/collectors').collectorProbeValidator)>>
      paramsTuple: []
      params: {}
      query: ExtractQuery<InferInput<(typeof import('#validators/collectors').collectorProbeValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/collectors_controller').default['probeDraft']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/collectors_controller').default['probeDraft']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'settings.collectors.update': {
    methods: ["PUT"]
    pattern: '/api/v1/settings/collectors/:id'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/collectors').collectorUpdateValidator)>>
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/collectors').collectorUpdateValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/collectors_controller').default['update']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/collectors_controller').default['update']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'settings.collectors.destroy': {
    methods: ["DELETE"]
    pattern: '/api/v1/settings/collectors/:id'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/collectors_controller').default['destroy']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/collectors_controller').default['destroy']>>>
    }
  }
  'settings.collectors.probe': {
    methods: ["POST"]
    pattern: '/api/v1/settings/collectors/:id/probe'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/collectors_controller').default['probe']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/collectors_controller').default['probe']>>>
    }
  }
  'settings.collectors.adopt': {
    methods: ["POST"]
    pattern: '/api/v1/settings/collectors/:id/adopt'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/collectors').collectorAdoptValidator)>>
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/collectors').collectorAdoptValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/collectors_controller').default['adopt']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/collectors_controller').default['adopt']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'settings.collectors.dismiss': {
    methods: ["POST"]
    pattern: '/api/v1/settings/collectors/:id/dismiss'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/collectors_controller').default['dismiss']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/collectors_controller').default['dismiss']>>>
    }
  }
  'settings.deviceGroups': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/settings/device-groups'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/device_groups_controller').default['settings']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/device_groups_controller').default['settings']>>>
    }
  }
  'settings.updateDeviceGroups': {
    methods: ["PATCH"]
    pattern: '/api/v1/settings/device-groups'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/device_groups').deviceGroupSettingsValidator)>>
      paramsTuple: []
      params: {}
      query: ExtractQuery<InferInput<(typeof import('#validators/device_groups').deviceGroupSettingsValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/device_groups_controller').default['updateSettings']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/device_groups_controller').default['updateSettings']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'settings.portal': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/settings/portal'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/portal_portals_controller').default['settings']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/portal_portals_controller').default['settings']>>>
    }
  }
  'settings.updatePortal': {
    methods: ["PATCH"]
    pattern: '/api/v1/settings/portal'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/portal').updatePortalSettingsValidator)>>
      paramsTuple: []
      params: {}
      query: ExtractQuery<InferInput<(typeof import('#validators/portal').updatePortalSettingsValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/portal_portals_controller').default['updateSettings']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/portal_portals_controller').default['updateSettings']>>> | { status: 422; response: { errors: SimpleError[] } }
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
  'collectors': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/collectors'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/collectors_controller').default['summary']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/collectors_controller').default['summary']>>>
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
  'devices.presence': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/devices/:mac/presence'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { mac: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/devices_controller').default['presence']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/devices_controller').default['presence']>>>
    }
  }
  'devices.shaping': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/devices/:mac/shaping'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { mac: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/devices_controller').default['shaping']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/devices_controller').default['shaping']>>>
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
  'devices.network': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/devices/:mac/network'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { mac: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_observations_controller').default['deviceNetwork']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_observations_controller').default['deviceNetwork']>>>
    }
  }
  'devices.networks': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/devices/:mac/networks'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { mac: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_networks_controller').default['device']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_networks_controller').default['device']>>>
    }
  }
  'devices.reservation': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/devices/:mac/reservation'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { mac: ParamValue }
      query: ExtractQueryForGet<InferInput<(typeof import('#validators/gateways').deviceGatewayValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_names_controller').default['showReservation']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_names_controller').default['showReservation']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'devices.wanAccess': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/devices/:mac/wan-access'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { mac: ParamValue }
      query: ExtractQueryForGet<InferInput<(typeof import('#validators/gateways').deviceGatewayValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_firewall_controller').default['showWanAccess']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_firewall_controller').default['showWanAccess']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'devices.group': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/devices/:mac/group'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { mac: ParamValue }
      query: ExtractQueryForGet<InferInput<(typeof import('#validators/device_groups').deviceGroupOfQueryValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/device_groups_controller').default['deviceGroup']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/device_groups_controller').default['deviceGroup']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'devices.putWanAccess': {
    methods: ["PUT"]
    pattern: '/api/v1/devices/:mac/wan-access'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/gateway_firewall').wanAccessValidator)>>
      paramsTuple: [ParamValue]
      params: { mac: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/gateway_firewall').wanAccessValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_firewall_controller').default['putWanAccess']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_firewall_controller').default['putWanAccess']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'devices.putReservation': {
    methods: ["PUT"]
    pattern: '/api/v1/devices/:mac/reservation'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/gateways').deviceReservationValidator)>>
      paramsTuple: [ParamValue]
      params: { mac: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/gateways').deviceReservationValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_names_controller').default['putReservation']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_names_controller').default['putReservation']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'devices.deleteReservation': {
    methods: ["DELETE"]
    pattern: '/api/v1/devices/:mac/reservation'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/gateways').deviceGatewayValidator)>>
      paramsTuple: [ParamValue]
      params: { mac: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/gateways').deviceGatewayValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_names_controller').default['deleteReservation']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_names_controller').default['deleteReservation']>>> | { status: 422; response: { errors: SimpleError[] } }
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
  'infra.layout': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/infra/layout'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/infra_controller').default['layout']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/infra_controller').default['layout']>>>
    }
  }
  'infra.state': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/infra/state'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/infra_controller').default['state']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/infra_controller').default['state']>>>
    }
  }
  'infra.ports.traffic': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/infra/ports/:id/traffic'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQueryForGet<InferInput<(typeof import('#validators/infra').infraTrafficQueryValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/infra_controller').default['portTraffic']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/infra_controller').default['portTraffic']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'infra.links.traffic': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/infra/links/:id/traffic'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQueryForGet<InferInput<(typeof import('#validators/infra').infraTrafficQueryValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/infra_controller').default['linkTraffic']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/infra_controller').default['linkTraffic']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'infra.nodes.traffic': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/infra/nodes/:id/traffic'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQueryForGet<InferInput<(typeof import('#validators/infra').infraTrafficQueryValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/infra_controller').default['nodeTraffic']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/infra_controller').default['nodeTraffic']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'infra.nodes.store': {
    methods: ["POST"]
    pattern: '/api/v1/infra/nodes'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/infra').createInfraNodeValidator)>>
      paramsTuple: []
      params: {}
      query: ExtractQuery<InferInput<(typeof import('#validators/infra').createInfraNodeValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/infra_controller').default['createNode']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/infra_controller').default['createNode']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'infra.nodes.update': {
    methods: ["PATCH"]
    pattern: '/api/v1/infra/nodes/:id'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/infra').updateInfraNodeValidator)>>
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/infra').updateInfraNodeValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/infra_controller').default['updateNode']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/infra_controller').default['updateNode']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'infra.nodes.destroy': {
    methods: ["DELETE"]
    pattern: '/api/v1/infra/nodes/:id'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/infra_controller').default['destroyNode']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/infra_controller').default['destroyNode']>>>
    }
  }
  'infra.nodes.bind': {
    methods: ["POST"]
    pattern: '/api/v1/infra/nodes/:id/bind'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/infra').bindInfraNodeValidator)>>
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/infra').bindInfraNodeValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/infra_controller').default['bindNode']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/infra_controller').default['bindNode']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'infra.nodes.ports.store': {
    methods: ["POST"]
    pattern: '/api/v1/infra/nodes/:id/ports'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/infra').addInfraPortsValidator)>>
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/infra').addInfraPortsValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/infra_controller').default['addPorts']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/infra_controller').default['addPorts']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'infra.ports.update': {
    methods: ["PATCH"]
    pattern: '/api/v1/infra/ports/:id'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/infra').updateInfraPortValidator)>>
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/infra').updateInfraPortValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/infra_controller').default['updatePort']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/infra_controller').default['updatePort']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'infra.ports.destroy': {
    methods: ["DELETE"]
    pattern: '/api/v1/infra/ports/:id'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/infra_controller').default['destroyPort']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/infra_controller').default['destroyPort']>>>
    }
  }
  'infra.links.store': {
    methods: ["POST"]
    pattern: '/api/v1/infra/links'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/infra').createInfraLinkValidator)>>
      paramsTuple: []
      params: {}
      query: ExtractQuery<InferInput<(typeof import('#validators/infra').createInfraLinkValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/infra_controller').default['createLink']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/infra_controller').default['createLink']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'infra.links.update': {
    methods: ["PATCH"]
    pattern: '/api/v1/infra/links/:id'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/infra').updateInfraLinkValidator)>>
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/infra').updateInfraLinkValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/infra_controller').default['updateLink']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/infra_controller').default['updateLink']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'infra.links.destroy': {
    methods: ["DELETE"]
    pattern: '/api/v1/infra/links/:id'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/infra_controller').default['destroyLink']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/infra_controller').default['destroyLink']>>>
    }
  }
  'infra.positions': {
    methods: ["PUT"]
    pattern: '/api/v1/infra/positions'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/infra').saveInfraPositionsValidator)>>
      paramsTuple: []
      params: {}
      query: ExtractQuery<InferInput<(typeof import('#validators/infra').saveInfraPositionsValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/infra_controller').default['savePositions']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/infra_controller').default['savePositions']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'gatewayObservations.gateway_observations.overview': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/gateways/:gatewayId/observation'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { gatewayId: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_observations_controller').default['overview']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_observations_controller').default['overview']>>>
    }
  }
  'gatewayObservations.gateway_observations.leases': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/gateways/:gatewayId/dhcp/leases'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { gatewayId: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_observations_controller').default['leases']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_observations_controller').default['leases']>>>
    }
  }
  'gatewayObservations.gateway_observations.neighbors': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/gateways/:gatewayId/neighbors'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { gatewayId: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_observations_controller').default['neighbors']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_observations_controller').default['neighbors']>>>
    }
  }
  'gatewayObservations.gateway_observations.interfaces': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/gateways/:gatewayId/interfaces'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { gatewayId: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_observations_controller').default['interfaces']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_observations_controller').default['interfaces']>>>
    }
  }
  'gatewayObservations.gateway_observations.upnp': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/gateways/:gatewayId/upnp'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { gatewayId: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_observations_controller').default['upnp']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_observations_controller').default['upnp']>>>
    }
  }
  'gatewayObservations.gateway_observations.wan_status': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/gateways/:gatewayId/wan-status'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { gatewayId: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_observations_controller').default['wanStatus']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_observations_controller').default['wanStatus']>>>
    }
  }
  'gatewayObservations.gateway_observations.system': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/gateways/:gatewayId/system'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { gatewayId: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_observations_controller').default['system']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_observations_controller').default['system']>>>
    }
  }
  'gatewayObservations.gateway_observations.wireguard': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/gateways/:gatewayId/wireguard'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { gatewayId: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_observations_controller').default['wireguard']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_observations_controller').default['wireguard']>>>
    }
  }
  'gatewayObservations.gateway_observations.observe': {
    methods: ["POST"]
    pattern: '/api/v1/gateways/:gatewayId/observe'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/gateway_observation_settings').observeRequestValidator)>>
      paramsTuple: [ParamValue]
      params: { gatewayId: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/gateway_observation_settings').observeRequestValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_observations_controller').default['observe']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_observations_controller').default['observe']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'gatewayObservations.gateway_observations.backups': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/gateways/:gatewayId/backups'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { gatewayId: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_observations_controller').default['backups']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_observations_controller').default['backups']>>>
    }
  }
  'gatewayObservations.gateway_observations.create_backup': {
    methods: ["POST"]
    pattern: '/api/v1/gateways/:gatewayId/backups'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/gateway_observation_settings').createBackupValidator)>>
      paramsTuple: [ParamValue]
      params: { gatewayId: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/gateway_observation_settings').createBackupValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_observations_controller').default['createBackup']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_observations_controller').default['createBackup']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'gatewayObservations.gateway_observations.download_backup': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/gateways/:gatewayId/backups/:backupId/download'
    types: {
      body: {}
      paramsTuple: [ParamValue, ParamValue]
      params: { gatewayId: ParamValue; backupId: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_observations_controller').default['downloadBackup']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_observations_controller').default['downloadBackup']>>>
    }
  }
  'portal.authorizations.store': {
    methods: ["POST"]
    pattern: '/api/v1/portal/authorizations'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/portal').authorizeValidator)>>
      paramsTuple: []
      params: {}
      query: ExtractQuery<InferInput<(typeof import('#validators/portal').authorizeValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/portal_authorizations_controller').default['store']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/portal_authorizations_controller').default['store']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'portal.authorizations.show': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/portal/authorizations/:mac'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { mac: ParamValue }
      query: ExtractQueryForGet<InferInput<(typeof import('#validators/portal').authorizationQueryValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/portal_authorizations_controller').default['show']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/portal_authorizations_controller').default['show']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'portal.authorizations.destroy': {
    methods: ["DELETE"]
    pattern: '/api/v1/portal/authorizations/:mac'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/portal').authorizationQueryValidator)>>
      paramsTuple: [ParamValue]
      params: { mac: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/portal').authorizationQueryValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/portal_authorizations_controller').default['destroy']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/portal_authorizations_controller').default['destroy']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'portal.portals.index': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/portal/portals'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: ExtractQueryForGet<InferInput<(typeof import('#validators/portal').portalListQueryValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/portal_portals_controller').default['index']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/portal_portals_controller').default['index']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'portal.portals.show': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/portal/portals/:id'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/portal_portals_controller').default['show']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/portal_portals_controller').default['show']>>>
    }
  }
  'portal.grants.index': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/portal/grants'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: ExtractQueryForGet<InferInput<(typeof import('#validators/portal').grantListQueryValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/portal_grants_controller').default['index']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/portal_grants_controller').default['index']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'portal.sessions.index': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/portal/sessions'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: ExtractQueryForGet<InferInput<(typeof import('#validators/portal').sessionListQueryValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/portal_grants_controller').default['sessions']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/portal_grants_controller').default['sessions']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'portal.priceTables.index': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/portal/price-tables'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/portal_hotspot_controller').default['priceTables']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/portal_hotspot_controller').default['priceTables']>>>
    }
  }
  'portal.priceTables.show': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/portal/price-tables/:id'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/portal_hotspot_controller').default['priceTable']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/portal_hotspot_controller').default['priceTable']>>>
    }
  }
  'portal.priceTables.quote': {
    methods: ["POST"]
    pattern: '/api/v1/portal/price-tables/:id/quote'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/portal').quoteValidator)>>
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/portal').quoteValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/portal_hotspot_controller').default['quote']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/portal_hotspot_controller').default['quote']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'portal.terminals.index': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/portal/terminals'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: ExtractQueryForGet<InferInput<(typeof import('#validators/portal').terminalListQueryValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/portal_hotspot_controller').default['terminals']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/portal_hotspot_controller').default['terminals']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'portal.terminals.show': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/portal/terminals/:id'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/portal_hotspot_controller').default['terminal']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/portal_hotspot_controller').default['terminal']>>>
    }
  }
  'portal.checkouts.index': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/portal/checkouts'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: ExtractQueryForGet<InferInput<(typeof import('#validators/portal').checkoutListQueryValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/portal_hotspot_controller').default['checkouts']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/portal_hotspot_controller').default['checkouts']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'portal.checkouts.show': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/portal/checkouts/:id'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/portal_hotspot_controller').default['checkout']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/portal_hotspot_controller').default['checkout']>>>
    }
  }
  'portal.portals.store': {
    methods: ["POST"]
    pattern: '/api/v1/portal/portals'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/portal').createPortalValidator)>>
      paramsTuple: []
      params: {}
      query: ExtractQuery<InferInput<(typeof import('#validators/portal').createPortalValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/portal_portals_controller').default['store']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/portal_portals_controller').default['store']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'portal.portals.update': {
    methods: ["PATCH"]
    pattern: '/api/v1/portal/portals/:id'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/portal').updatePortalValidator)>>
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/portal').updatePortalValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/portal_portals_controller').default['update']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/portal_portals_controller').default['update']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'portal.portals.destroy': {
    methods: ["DELETE"]
    pattern: '/api/v1/portal/portals/:id'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/portal').deletePortalQueryValidator)>>
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/portal').deletePortalQueryValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/portal_portals_controller').default['destroy']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/portal_portals_controller').default['destroy']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'portal.gateways.rotateKey': {
    methods: ["POST"]
    pattern: '/api/v1/portal/gateways/:gatewayId/rotate-key'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { gatewayId: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/portal_portals_controller').default['rotateKey']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/portal_portals_controller').default['rotateKey']>>>
    }
  }
  'portal.grants.extend': {
    methods: ["POST"]
    pattern: '/api/v1/portal/grants/:id/extend'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/portal').extendGrantValidator)>>
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/portal').extendGrantValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/portal_grants_controller').default['extend']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/portal_grants_controller').default['extend']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'portal.grants.revoke': {
    methods: ["POST"]
    pattern: '/api/v1/portal/grants/:id/revoke'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/portal_grants_controller').default['revoke']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/portal_grants_controller').default['revoke']>>>
    }
  }
  'portal.templates.index': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/portal/templates'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/portal_templates_controller').default['index']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/portal_templates_controller').default['index']>>>
    }
  }
  'portal.templates.store': {
    methods: ["POST"]
    pattern: '/api/v1/portal/templates'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/portal').templateNameValidator)>>
      paramsTuple: []
      params: {}
      query: ExtractQuery<InferInput<(typeof import('#validators/portal').templateNameValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/portal_templates_controller').default['store']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/portal_templates_controller').default['store']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'portal.templates.show': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/portal/templates/:id'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/portal_templates_controller').default['show']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/portal_templates_controller').default['show']>>>
    }
  }
  'portal.templates.update': {
    methods: ["PATCH"]
    pattern: '/api/v1/portal/templates/:id'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/portal').templateNameValidator)>>
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/portal').templateNameValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/portal_templates_controller').default['update']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/portal_templates_controller').default['update']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'portal.templates.destroy': {
    methods: ["DELETE"]
    pattern: '/api/v1/portal/templates/:id'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/portal_templates_controller').default['destroy']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/portal_templates_controller').default['destroy']>>>
    }
  }
  'portal.templates.duplicate': {
    methods: ["POST"]
    pattern: '/api/v1/portal/templates/:id/duplicate'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/portal').templateNameValidator)>>
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/portal').templateNameValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/portal_templates_controller').default['duplicate']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/portal_templates_controller').default['duplicate']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'portal.templates.preview': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/portal/templates/:id/preview'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQueryForGet<InferInput<(typeof import('#validators/portal').previewQueryValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/portal_templates_controller').default['preview']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/portal_templates_controller').default['preview']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'portal.templates.files.put': {
    methods: ["PUT"]
    pattern: '/api/v1/portal/templates/:id/files/:name'
    types: {
      body: {}
      paramsTuple: [ParamValue, ParamValue]
      params: { id: ParamValue; name: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/portal_templates_controller').default['putFile']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/portal_templates_controller').default['putFile']>>>
    }
  }
  'portal.templates.files.destroy': {
    methods: ["DELETE"]
    pattern: '/api/v1/portal/templates/:id/files/:name'
    types: {
      body: {}
      paramsTuple: [ParamValue, ParamValue]
      params: { id: ParamValue; name: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/portal_templates_controller').default['destroyFile']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/portal_templates_controller').default['destroyFile']>>>
    }
  }
  'portal.voucherBatches.store': {
    methods: ["POST"]
    pattern: '/api/v1/portal/voucher-batches'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/portal').createBatchValidator)>>
      paramsTuple: []
      params: {}
      query: ExtractQuery<InferInput<(typeof import('#validators/portal').createBatchValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/portal_vouchers_controller').default['storeBatch']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/portal_vouchers_controller').default['storeBatch']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'portal.voucherBatches.index': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/portal/voucher-batches'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: ExtractQueryForGet<InferInput<(typeof import('#validators/portal').batchListQueryValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/portal_vouchers_controller').default['indexBatches']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/portal_vouchers_controller').default['indexBatches']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'portal.voucherBatches.show': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/portal/voucher-batches/:id'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/portal_vouchers_controller').default['showBatch']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/portal_vouchers_controller').default['showBatch']>>>
    }
  }
  'portal.voucherBatches.codes': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/portal/voucher-batches/:id/codes'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/portal_vouchers_controller').default['codes']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/portal_vouchers_controller').default['codes']>>>
    }
  }
  'portal.voucherBatches.csv': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/portal/voucher-batches/:id/codes.csv'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/portal_vouchers_controller').default['csv']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/portal_vouchers_controller').default['csv']>>>
    }
  }
  'portal.voucherBatches.revoke': {
    methods: ["POST"]
    pattern: '/api/v1/portal/voucher-batches/:id/revoke'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/portal_vouchers_controller').default['revokeBatch']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/portal_vouchers_controller').default['revokeBatch']>>>
    }
  }
  'portal.voucherBatches.destroy': {
    methods: ["DELETE"]
    pattern: '/api/v1/portal/voucher-batches/:id'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/portal_vouchers_controller').default['destroyBatch']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/portal_vouchers_controller').default['destroyBatch']>>>
    }
  }
  'portal.vouchers.index': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/portal/vouchers'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: ExtractQueryForGet<InferInput<(typeof import('#validators/portal').voucherListQueryValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/portal_vouchers_controller').default['index']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/portal_vouchers_controller').default['index']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'portal.vouchers.lookup': {
    methods: ["POST"]
    pattern: '/api/v1/portal/vouchers/lookup'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/portal').voucherLookupValidator)>>
      paramsTuple: []
      params: {}
      query: ExtractQuery<InferInput<(typeof import('#validators/portal').voucherLookupValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/portal_vouchers_controller').default['lookup']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/portal_vouchers_controller').default['lookup']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'portal.vouchers.revoke': {
    methods: ["POST"]
    pattern: '/api/v1/portal/vouchers/:id/revoke'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/portal_vouchers_controller').default['revoke']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/portal_vouchers_controller').default['revoke']>>>
    }
  }
  'portal.users.index': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/portal/users'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/portal_users_controller').default['index']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/portal_users_controller').default['index']>>>
    }
  }
  'portal.users.store': {
    methods: ["POST"]
    pattern: '/api/v1/portal/users'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/portal').createPortalUserValidator)>>
      paramsTuple: []
      params: {}
      query: ExtractQuery<InferInput<(typeof import('#validators/portal').createPortalUserValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/portal_users_controller').default['store']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/portal_users_controller').default['store']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'portal.users.update': {
    methods: ["PATCH"]
    pattern: '/api/v1/portal/users/:id'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/portal').updatePortalUserValidator)>>
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/portal').updatePortalUserValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/portal_users_controller').default['update']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/portal_users_controller').default['update']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'portal.users.password': {
    methods: ["PUT"]
    pattern: '/api/v1/portal/users/:id/password'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/portal').portalUserPasswordValidator)>>
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/portal').portalUserPasswordValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/portal_users_controller').default['password']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/portal_users_controller').default['password']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'portal.users.destroy': {
    methods: ["DELETE"]
    pattern: '/api/v1/portal/users/:id'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/portal_users_controller').default['destroy']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/portal_users_controller').default['destroy']>>>
    }
  }
  'portal.apiClients.index': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/portal/api-clients'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/portal_api_clients_controller').default['index']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/portal_api_clients_controller').default['index']>>>
    }
  }
  'portal.apiClients.store': {
    methods: ["POST"]
    pattern: '/api/v1/portal/api-clients'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/portal').createApiClientValidator)>>
      paramsTuple: []
      params: {}
      query: ExtractQuery<InferInput<(typeof import('#validators/portal').createApiClientValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/portal_api_clients_controller').default['store']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/portal_api_clients_controller').default['store']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'portal.apiClients.update': {
    methods: ["PATCH"]
    pattern: '/api/v1/portal/api-clients/:id'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/portal').updateApiClientValidator)>>
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/portal').updateApiClientValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/portal_api_clients_controller').default['update']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/portal_api_clients_controller').default['update']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'portal.apiClients.rotate': {
    methods: ["POST"]
    pattern: '/api/v1/portal/api-clients/:id/rotate'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/portal_api_clients_controller').default['rotate']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/portal_api_clients_controller').default['rotate']>>>
    }
  }
  'portal.apiClients.destroy': {
    methods: ["DELETE"]
    pattern: '/api/v1/portal/api-clients/:id'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/portal_api_clients_controller').default['destroy']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/portal_api_clients_controller').default['destroy']>>>
    }
  }
  'portal.priceTables.store': {
    methods: ["POST"]
    pattern: '/api/v1/portal/price-tables'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/portal').createPriceTableValidator)>>
      paramsTuple: []
      params: {}
      query: ExtractQuery<InferInput<(typeof import('#validators/portal').createPriceTableValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/portal_hotspot_controller').default['storePriceTable']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/portal_hotspot_controller').default['storePriceTable']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'portal.priceTables.update': {
    methods: ["PATCH"]
    pattern: '/api/v1/portal/price-tables/:id'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/portal').updatePriceTableValidator)>>
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/portal').updatePriceTableValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/portal_hotspot_controller').default['updatePriceTable']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/portal_hotspot_controller').default['updatePriceTable']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'portal.priceTables.destroy': {
    methods: ["DELETE"]
    pattern: '/api/v1/portal/price-tables/:id'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/portal_hotspot_controller').default['destroyPriceTable']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/portal_hotspot_controller').default['destroyPriceTable']>>>
    }
  }
  'portal.terminals.store': {
    methods: ["POST"]
    pattern: '/api/v1/portal/terminals'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/portal').createTerminalValidator)>>
      paramsTuple: []
      params: {}
      query: ExtractQuery<InferInput<(typeof import('#validators/portal').createTerminalValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/portal_hotspot_controller').default['storeTerminal']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/portal_hotspot_controller').default['storeTerminal']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'portal.terminals.update': {
    methods: ["PATCH"]
    pattern: '/api/v1/portal/terminals/:id'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/portal').updateTerminalValidator)>>
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/portal').updateTerminalValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/portal_hotspot_controller').default['updateTerminal']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/portal_hotspot_controller').default['updateTerminal']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'portal.terminals.rotate': {
    methods: ["POST"]
    pattern: '/api/v1/portal/terminals/:id/rotate'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/portal_hotspot_controller').default['rotateTerminal']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/portal_hotspot_controller').default['rotateTerminal']>>>
    }
  }
  'portal.terminals.destroy': {
    methods: ["DELETE"]
    pattern: '/api/v1/portal/terminals/:id'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/portal_hotspot_controller').default['destroyTerminal']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/portal_hotspot_controller').default['destroyTerminal']>>>
    }
  }
  'portal.checkouts.void': {
    methods: ["POST"]
    pattern: '/api/v1/portal/checkouts/:id/void'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/portal').voidCheckoutValidator)>>
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/portal').voidCheckoutValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/portal_hotspot_controller').default['void']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/portal_hotspot_controller').default['void']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'portal.checkouts.credit': {
    methods: ["POST"]
    pattern: '/api/v1/portal/checkouts/:id/credit'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/portal').creditCheckoutValidator)>>
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/portal').creditCheckoutValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/portal_hotspot_controller').default['credit']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/portal_hotspot_controller').default['credit']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'portal.checkouts.dismiss': {
    methods: ["POST"]
    pattern: '/api/v1/portal/checkouts/:id/dismiss'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/portal').dismissCheckoutValidator)>>
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/portal').dismissCheckoutValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/portal_hotspot_controller').default['dismiss']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/portal_hotspot_controller').default['dismiss']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'deviceGroups.index': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/device-groups'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: ExtractQueryForGet<InferInput<(typeof import('#validators/device_groups').deviceGroupsQueryValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/device_groups_controller').default['index']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/device_groups_controller').default['index']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'deviceGroups.aps': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/device-groups/aps'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/device_groups_controller').default['aps']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/device_groups_controller').default['aps']>>>
    }
  }
  'deviceGroups.show': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/device-groups/:id'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/device_groups_controller').default['show']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/device_groups_controller').default['show']>>>
    }
  }
  'deviceGroups.store': {
    methods: ["POST"]
    pattern: '/api/v1/device-groups'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/device_groups').createDeviceGroupValidator)>>
      paramsTuple: []
      params: {}
      query: ExtractQuery<InferInput<(typeof import('#validators/device_groups').createDeviceGroupValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/device_groups_controller').default['store']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/device_groups_controller').default['store']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'deviceGroups.aps.update': {
    methods: ["PATCH"]
    pattern: '/api/v1/device-groups/aps/:apId'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/device_groups').apTrunkValidator)>>
      paramsTuple: [ParamValue]
      params: { apId: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/device_groups').apTrunkValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/device_groups_controller').default['updateAp']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/device_groups_controller').default['updateAp']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'deviceGroups.update': {
    methods: ["PATCH"]
    pattern: '/api/v1/device-groups/:id'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/device_groups').updateDeviceGroupValidator)>>
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/device_groups').updateDeviceGroupValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/device_groups_controller').default['update']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/device_groups_controller').default['update']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'deviceGroups.destroy': {
    methods: ["DELETE"]
    pattern: '/api/v1/device-groups/:id'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/device_groups_controller').default['destroy']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/device_groups_controller').default['destroy']>>>
    }
  }
  'deviceGroups.members.store': {
    methods: ["POST"]
    pattern: '/api/v1/device-groups/:id/members'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/device_groups').addMemberValidator)>>
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/device_groups').addMemberValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/device_groups_controller').default['addMember']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/device_groups_controller').default['addMember']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'deviceGroups.members.destroy': {
    methods: ["DELETE"]
    pattern: '/api/v1/device-groups/:id/members/:mac'
    types: {
      body: {}
      paramsTuple: [ParamValue, ParamValue]
      params: { id: ParamValue; mac: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/device_groups_controller').default['removeMember']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/device_groups_controller').default['removeMember']>>>
    }
  }
  'deviceGroups.keys.store': {
    methods: ["POST"]
    pattern: '/api/v1/device-groups/:id/keys'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/device_groups').createKeyValidator)>>
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/device_groups').createKeyValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/device_groups_controller').default['createKey']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/device_groups_controller').default['createKey']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'deviceGroups.keys.reveal': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/device-groups/:id/keys/:keyId/passphrase'
    types: {
      body: {}
      paramsTuple: [ParamValue, ParamValue]
      params: { id: ParamValue; keyId: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/device_groups_controller').default['revealKey']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/device_groups_controller').default['revealKey']>>>
    }
  }
  'deviceGroups.keys.destroy': {
    methods: ["DELETE"]
    pattern: '/api/v1/device-groups/:id/keys/:keyId'
    types: {
      body: {}
      paramsTuple: [ParamValue, ParamValue]
      params: { id: ParamValue; keyId: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/device_groups_controller').default['destroyKey']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/device_groups_controller').default['destroyKey']>>>
    }
  }
  'qos.overview': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/qos'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: ExtractQueryForGet<InferInput<(typeof import('#validators/qos').qosGatewayQueryValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/qos_controller').default['overview']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/qos_controller').default['overview']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'qos.devices.index': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/qos/devices'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: ExtractQueryForGet<InferInput<(typeof import('#validators/qos').qosDevicesQueryValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/qos_controller').default['devices']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/qos_controller').default['devices']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'qos.wanQueues.index': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/qos/wan-queues'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: ExtractQueryForGet<InferInput<(typeof import('#validators/qos').qosGatewayQueryValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/qos_controller').default['wanQueues']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/qos_controller').default['wanQueues']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'qos.policies.index': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/qos/policies'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: ExtractQueryForGet<InferInput<(typeof import('#validators/qos').qosGatewayQueryValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/qos_controller').default['policies']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/qos_controller').default['policies']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'qos.groups.index': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/qos/groups'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: ExtractQueryForGet<InferInput<(typeof import('#validators/qos').qosGatewayQueryValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/qos_controller').default['groups']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/qos_controller').default['groups']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'qos.assignments.index': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/qos/assignments'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: ExtractQueryForGet<InferInput<(typeof import('#validators/qos').qosAssignmentsQueryValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/qos_controller').default['assignments']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/qos_controller').default['assignments']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'qos.schedules.index': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/qos/schedules'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: ExtractQueryForGet<InferInput<(typeof import('#validators/qos').qosGatewayQueryValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/qos_controller').default['schedules']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/qos_controller').default['schedules']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'qos.wanQueues.store': {
    methods: ["POST"]
    pattern: '/api/v1/qos/wan-queues'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/qos').createWanQueueValidator)>>
      paramsTuple: []
      params: {}
      query: ExtractQuery<InferInput<(typeof import('#validators/qos').createWanQueueValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/qos_controller').default['createWanQueue']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/qos_controller').default['createWanQueue']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'qos.wanQueues.update': {
    methods: ["PATCH"]
    pattern: '/api/v1/qos/wan-queues/:id'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/qos').updateWanQueueValidator)>>
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/qos').updateWanQueueValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/qos_controller').default['updateWanQueue']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/qos_controller').default['updateWanQueue']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'qos.wanQueues.destroy': {
    methods: ["DELETE"]
    pattern: '/api/v1/qos/wan-queues/:id'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/qos_controller').default['destroyWanQueue']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/qos_controller').default['destroyWanQueue']>>>
    }
  }
  'qos.policies.store': {
    methods: ["POST"]
    pattern: '/api/v1/qos/policies'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/qos').createPolicyValidator)>>
      paramsTuple: []
      params: {}
      query: ExtractQuery<InferInput<(typeof import('#validators/qos').createPolicyValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/qos_controller').default['createPolicy']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/qos_controller').default['createPolicy']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'qos.policies.update': {
    methods: ["PATCH"]
    pattern: '/api/v1/qos/policies/:id'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/qos').updatePolicyValidator)>>
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/qos').updatePolicyValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/qos_controller').default['updatePolicy']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/qos_controller').default['updatePolicy']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'qos.policies.destroy': {
    methods: ["DELETE"]
    pattern: '/api/v1/qos/policies/:id'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/qos_controller').default['destroyPolicy']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/qos_controller').default['destroyPolicy']>>>
    }
  }
  'qos.groups.store': {
    methods: ["POST"]
    pattern: '/api/v1/qos/groups'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/qos').createGroupValidator)>>
      paramsTuple: []
      params: {}
      query: ExtractQuery<InferInput<(typeof import('#validators/qos').createGroupValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/qos_controller').default['createGroup']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/qos_controller').default['createGroup']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'qos.groups.update': {
    methods: ["PATCH"]
    pattern: '/api/v1/qos/groups/:id'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/qos').updateGroupValidator)>>
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/qos').updateGroupValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/qos_controller').default['updateGroup']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/qos_controller').default['updateGroup']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'qos.groups.destroy': {
    methods: ["DELETE"]
    pattern: '/api/v1/qos/groups/:id'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/qos_controller').default['destroyGroup']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/qos_controller').default['destroyGroup']>>>
    }
  }
  'qos.assignments.store': {
    methods: ["POST"]
    pattern: '/api/v1/qos/assignments'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/qos').createAssignmentValidator)>>
      paramsTuple: []
      params: {}
      query: ExtractQuery<InferInput<(typeof import('#validators/qos').createAssignmentValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/qos_controller').default['createAssignment']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/qos_controller').default['createAssignment']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'qos.assignments.update': {
    methods: ["PATCH"]
    pattern: '/api/v1/qos/assignments/:id'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/qos').updateAssignmentValidator)>>
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/qos').updateAssignmentValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/qos_controller').default['updateAssignment']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/qos_controller').default['updateAssignment']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'qos.assignments.destroy': {
    methods: ["DELETE"]
    pattern: '/api/v1/qos/assignments/:id'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/qos_controller').default['destroyAssignment']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/qos_controller').default['destroyAssignment']>>>
    }
  }
  'qos.schedules.store': {
    methods: ["POST"]
    pattern: '/api/v1/qos/schedules'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/qos').createScheduleValidator)>>
      paramsTuple: []
      params: {}
      query: ExtractQuery<InferInput<(typeof import('#validators/qos').createScheduleValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/qos_controller').default['createSchedule']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/qos_controller').default['createSchedule']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'qos.schedules.update': {
    methods: ["PATCH"]
    pattern: '/api/v1/qos/schedules/:id'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/qos').updateScheduleValidator)>>
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/qos').updateScheduleValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/qos_controller').default['updateSchedule']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/qos_controller').default['updateSchedule']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'qos.schedules.destroy': {
    methods: ["DELETE"]
    pattern: '/api/v1/qos/schedules/:id'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/qos_controller').default['destroySchedule']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/qos_controller').default['destroySchedule']>>>
    }
  }
  'qos.assignments.resetQuota': {
    methods: ["POST"]
    pattern: '/api/v1/qos/assignments/:id/quota/reset'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/qos_controller').default['resetQuota']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/qos_controller').default['resetQuota']>>>
    }
  }
  'qos.pause': {
    methods: ["POST"]
    pattern: '/api/v1/qos/pause'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/qos_controller').default['pause']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/qos_controller').default['pause']>>>
    }
  }
  'qos.resume': {
    methods: ["POST"]
    pattern: '/api/v1/qos/resume'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/qos_controller').default['resume']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/qos_controller').default['resume']>>>
    }
  }
  'networks.index': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/networks'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_networks_controller').default['all']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_networks_controller').default['all']>>>
    }
  }
  'networks.scopeChanges': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/networks/scope-changes'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_networks_controller').default['scopeChanges']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_networks_controller').default['scopeChanges']>>>
    }
  }
  'gateways.index': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/gateways'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateways_controller').default['index']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateways_controller').default['index']>>>
    }
  }
  'gateways.show': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/gateways/:id'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateways_controller').default['show']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateways_controller').default['show']>>>
    }
  }
  'gateways.syncStatus': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/gateways/:id/sync-status'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateways_controller').default['syncStatus']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateways_controller').default['syncStatus']>>>
    }
  }
  'gateways.sections': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/gateways/:id/sections'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQueryForGet<InferInput<(typeof import('#validators/gateways').sectionFilterValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateways_controller').default['sections']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateways_controller').default['sections']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'gateways.section': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/gateways/:id/sections/:perchId'
    types: {
      body: {}
      paramsTuple: [ParamValue, ParamValue]
      params: { id: ParamValue; perchId: ParamValue }
      query: ExtractQueryForGet<InferInput<(typeof import('#validators/gateways').pagingValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateways_controller').default['section']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateways_controller').default['section']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'gateways.draft': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/gateways/:id/draft'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateways_controller').default['draft']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateways_controller').default['draft']>>>
    }
  }
  'gateways.applies': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/gateways/:id/applies'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQueryForGet<InferInput<(typeof import('#validators/gateways').pagingValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateways_controller').default['applies']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateways_controller').default['applies']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'gateways.apply': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/gateways/:id/applies/:applyId'
    types: {
      body: {}
      paramsTuple: [ParamValue, ParamValue]
      params: { id: ParamValue; applyId: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateways_controller').default['apply']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateways_controller').default['apply']>>>
    }
  }
  'gateways.revisions': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/gateways/:id/revisions'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQueryForGet<InferInput<(typeof import('#validators/gateways').pagingValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateways_controller').default['revisions']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateways_controller').default['revisions']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'gateways.revision': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/gateways/:id/revisions/:number'
    types: {
      body: {}
      paramsTuple: [ParamValue, ParamValue]
      params: { id: ParamValue; number: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateways_controller').default['revision']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateways_controller').default['revision']>>>
    }
  }
  'gateways.events': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/gateways/:id/events'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQueryForGet<InferInput<(typeof import('#validators/gateways').pagingValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateways_controller').default['events']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateways_controller').default['events']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'gateways.pairing': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/gateways/:id/pairing'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateways_controller').default['pairing']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateways_controller').default['pairing']>>>
    }
  }
  'gateways.dns': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/gateways/:id/dns'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_names_controller').default['dns']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_names_controller').default['dns']>>>
    }
  }
  'gateways.labelNames': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/gateways/:id/dns/label-names'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_names_controller').default['labelNames']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_names_controller').default['labelNames']>>>
    }
  }
  'gateways.networks': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/gateways/:id/networks'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_networks_controller').default['index']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_networks_controller').default['index']>>>
    }
  }
  'gateways.networkHistory': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/gateways/:id/networks/history'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQueryForGet<InferInput<(typeof import('#validators/gateways').networkHistoryValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_networks_controller').default['history']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_networks_controller').default['history']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'gateways.network': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/gateways/:id/networks/:networkId'
    types: {
      body: {}
      paramsTuple: [ParamValue, ParamValue]
      params: { id: ParamValue; networkId: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_networks_controller').default['show']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_networks_controller').default['show']>>>
    }
  }
  'gateways.createNetwork': {
    methods: ["POST"]
    pattern: '/api/v1/gateways/:id/networks'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/gateways').networkCreateValidator)>>
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/gateways').networkCreateValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_networks_controller').default['store']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_networks_controller').default['store']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'gateways.updateNetwork': {
    methods: ["PATCH"]
    pattern: '/api/v1/gateways/:id/networks/:networkId'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/gateways').networkPatchValidator)>>
      paramsTuple: [ParamValue, ParamValue]
      params: { id: ParamValue; networkId: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/gateways').networkPatchValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_networks_controller').default['update']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_networks_controller').default['update']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'gateways.deleteNetwork': {
    methods: ["DELETE"]
    pattern: '/api/v1/gateways/:id/networks/:networkId'
    types: {
      body: {}
      paramsTuple: [ParamValue, ParamValue]
      params: { id: ParamValue; networkId: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_networks_controller').default['destroy']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_networks_controller').default['destroy']>>>
    }
  }
  'gateways.update': {
    methods: ["PATCH"]
    pattern: '/api/v1/gateways/:id'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/gateways').gatewayPatchValidator)>>
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/gateways').gatewayPatchValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateways_controller').default['update']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateways_controller').default['update']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'gateways.bind': {
    methods: ["POST"]
    pattern: '/api/v1/gateways/:id/bind'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/gateways').gatewayBindValidator)>>
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/gateways').gatewayBindValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateways_controller').default['bind']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateways_controller').default['bind']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'gateways.refresh': {
    methods: ["POST"]
    pattern: '/api/v1/gateways/:id/refresh'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateways_controller').default['refresh']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateways_controller').default['refresh']>>>
    }
  }
  'gateways.updateSection': {
    methods: ["PATCH"]
    pattern: '/api/v1/gateways/:id/sections/:perchId'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/gateways').sectionScopeValidator)>>
      paramsTuple: [ParamValue, ParamValue]
      params: { id: ParamValue; perchId: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/gateways').sectionScopeValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateways_controller').default['updateSection']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateways_controller').default['updateSection']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'gateways.resolve': {
    methods: ["POST"]
    pattern: '/api/v1/gateways/:id/sections/resolve'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/gateways').sectionResolveValidator)>>
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/gateways').sectionResolveValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateways_controller').default['resolve']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateways_controller').default['resolve']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'gateways.discardDraft': {
    methods: ["DELETE"]
    pattern: '/api/v1/gateways/:id/draft'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/gateways').perchIdsValidator)>>
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/gateways').perchIdsValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateways_controller').default['discardDraft']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateways_controller').default['discardDraft']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'gateways.createApply': {
    methods: ["POST"]
    pattern: '/api/v1/gateways/:id/applies'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/gateways').applyCreateValidator)>>
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/gateways').applyCreateValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateways_controller').default['createApply']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateways_controller').default['createApply']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'gateways.installPackages': {
    methods: ["POST"]
    pattern: '/api/v1/gateways/:id/packages'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/gateways').packageInstallValidator)>>
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/gateways').packageInstallValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateways_controller').default['installPackages']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateways_controller').default['installPackages']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'gateways.setSignKey': {
    methods: ["PUT"]
    pattern: '/api/v1/gateways/:id/sign-key'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/gateways').signKeyValidator)>>
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/gateways').signKeyValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateways_controller').default['setSignKey']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateways_controller').default['setSignKey']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'gateways.startPairing': {
    methods: ["POST"]
    pattern: '/api/v1/gateways/:id/pairing'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/gateways').pairingStartValidator)>>
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/gateways').pairingStartValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateways_controller').default['startPairing']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateways_controller').default['startPairing']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'gateways.confirmPairing': {
    methods: ["POST"]
    pattern: '/api/v1/gateways/:id/pairing/confirm'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/gateways').pairingConfirmValidator)>>
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/gateways').pairingConfirmValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateways_controller').default['confirmPairing']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateways_controller').default['confirmPairing']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'gateways.unpair': {
    methods: ["DELETE"]
    pattern: '/api/v1/gateways/:id/pairing'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateways_controller').default['unpair']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateways_controller').default['unpair']>>>
    }
  }
  'gateways.clearSignKey': {
    methods: ["DELETE"]
    pattern: '/api/v1/gateways/:id/sign-key'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateways_controller').default['clearSignKey']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateways_controller').default['clearSignKey']>>>
    }
  }
  'gateways.confirmApply': {
    methods: ["POST"]
    pattern: '/api/v1/gateways/:id/applies/:applyId/confirm'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/gateway_sync').applyConfirmValidator)>>
      paramsTuple: [ParamValue, ParamValue]
      params: { id: ParamValue; applyId: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/gateway_sync').applyConfirmValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateways_controller').default['confirmApply']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateways_controller').default['confirmApply']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'gateways.revertApply': {
    methods: ["POST"]
    pattern: '/api/v1/gateways/:id/applies/:applyId/revert'
    types: {
      body: {}
      paramsTuple: [ParamValue, ParamValue]
      params: { id: ParamValue; applyId: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateways_controller').default['revertApply']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateways_controller').default['revertApply']>>>
    }
  }
  'gateways.restoreRevision': {
    methods: ["POST"]
    pattern: '/api/v1/gateways/:id/revisions/:number/restore'
    types: {
      body: {}
      paramsTuple: [ParamValue, ParamValue]
      params: { id: ParamValue; number: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateways_controller').default['restoreRevision']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateways_controller').default['restoreRevision']>>>
    }
  }
  'gateways.dismissRejoin': {
    methods: ["POST"]
    pattern: '/api/v1/gateways/:id/rejoin/dismiss'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateways_controller').default['dismissRejoin']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateways_controller').default['dismissRejoin']>>>
    }
  }
  'gateways.acceptDrift': {
    methods: ["POST"]
    pattern: '/api/v1/gateways/:id/drift/accept'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/gateways').perchIdsValidator)>>
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/gateways').perchIdsValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateways_controller').default['acceptDrift']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateways_controller').default['acceptDrift']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'gateways.revertDrift': {
    methods: ["POST"]
    pattern: '/api/v1/gateways/:id/drift/revert-now'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/gateways').perchIdsValidator)>>
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/gateways').perchIdsValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateways_controller').default['revertDrift']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateways_controller').default['revertDrift']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'gateways.resumeEnforcement': {
    methods: ["POST"]
    pattern: '/api/v1/gateways/:id/enforcement/resume'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateways_controller').default['resumeEnforcement']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateways_controller').default['resumeEnforcement']>>>
    }
  }
  'gateways.updateDns': {
    methods: ["PATCH"]
    pattern: '/api/v1/gateways/:id/dns'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/gateway_native').dnsSettingsPatchValidator)>>
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/gateway_native').dnsSettingsPatchValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_names_controller').default['updateDns']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_names_controller').default['updateDns']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'gateways.createRecord': {
    methods: ["POST"]
    pattern: '/api/v1/gateways/:id/dns/records'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/gateways').dnsRecordValidator)>>
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/gateways').dnsRecordValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_names_controller').default['createRecord']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_names_controller').default['createRecord']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'gateways.updateRecord': {
    methods: ["PATCH"]
    pattern: '/api/v1/gateways/:id/dns/records/:perchId'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/gateways').dnsRecordPatchValidator)>>
      paramsTuple: [ParamValue, ParamValue]
      params: { id: ParamValue; perchId: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/gateways').dnsRecordPatchValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_names_controller').default['updateRecord']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_names_controller').default['updateRecord']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'gateways.deleteRecord': {
    methods: ["DELETE"]
    pattern: '/api/v1/gateways/:id/dns/records/:perchId'
    types: {
      body: {}
      paramsTuple: [ParamValue, ParamValue]
      params: { id: ParamValue; perchId: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_names_controller').default['deleteRecord']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_names_controller').default['deleteRecord']>>>
    }
  }
  'gateways.applyLabelNames': {
    methods: ["POST"]
    pattern: '/api/v1/gateways/:id/dns/label-names/apply'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/gateways').labelNamesApplyValidator)>>
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/gateways').labelNamesApplyValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_names_controller').default['applyLabelNames']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_names_controller').default['applyLabelNames']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'gateways.dhcp': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/gateways/:id/dhcp'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_native_controller').default['dhcp']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_native_controller').default['dhcp']>>>
    }
  }
  'gateways.updateDhcpPool': {
    methods: ["PATCH"]
    pattern: '/api/v1/gateways/:id/dhcp/pools/:network'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/gateway_native').dhcpPoolPatchValidator)>>
      paramsTuple: [ParamValue, ParamValue]
      params: { id: ParamValue; network: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/gateway_native').dhcpPoolPatchValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_native_controller').default['updatePool']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_native_controller').default['updatePool']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'gateways.createDhcpTag': {
    methods: ["POST"]
    pattern: '/api/v1/gateways/:id/dhcp/tags'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/gateway_native').dhcpTagValidator)>>
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/gateway_native').dhcpTagValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_native_controller').default['createTag']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_native_controller').default['createTag']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'gateways.updateDhcpTag': {
    methods: ["PATCH"]
    pattern: '/api/v1/gateways/:id/dhcp/tags/:perchId'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/gateway_native').dhcpTagPatchValidator)>>
      paramsTuple: [ParamValue, ParamValue]
      params: { id: ParamValue; perchId: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/gateway_native').dhcpTagPatchValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_native_controller').default['updateTag']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_native_controller').default['updateTag']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'gateways.deleteDhcpTag': {
    methods: ["DELETE"]
    pattern: '/api/v1/gateways/:id/dhcp/tags/:perchId'
    types: {
      body: {}
      paramsTuple: [ParamValue, ParamValue]
      params: { id: ParamValue; perchId: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_native_controller').default['deleteTag']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_native_controller').default['deleteTag']>>>
    }
  }
  'gateways.updateDhcpReservation': {
    methods: ["PATCH"]
    pattern: '/api/v1/gateways/:id/dhcp/reservations/:perchId'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/gateway_native').dhcpReservationPatchValidator)>>
      paramsTuple: [ParamValue, ParamValue]
      params: { id: ParamValue; perchId: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/gateway_native').dhcpReservationPatchValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_native_controller').default['updateReservation']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_native_controller').default['updateReservation']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'gateways.routing': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/gateways/:id/routing'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_native_controller').default['routing']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_native_controller').default['routing']>>>
    }
  }
  'gateways.createRoute': {
    methods: ["POST"]
    pattern: '/api/v1/gateways/:id/routing/routes'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/gateway_native').routeValidator)>>
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/gateway_native').routeValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_native_controller').default['createRoute']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_native_controller').default['createRoute']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'gateways.updateRoute': {
    methods: ["PATCH"]
    pattern: '/api/v1/gateways/:id/routing/routes/:perchId'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/gateway_native').routePatchValidator)>>
      paramsTuple: [ParamValue, ParamValue]
      params: { id: ParamValue; perchId: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/gateway_native').routePatchValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_native_controller').default['updateRoute']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_native_controller').default['updateRoute']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'gateways.deleteRoute': {
    methods: ["DELETE"]
    pattern: '/api/v1/gateways/:id/routing/routes/:perchId'
    types: {
      body: {}
      paramsTuple: [ParamValue, ParamValue]
      params: { id: ParamValue; perchId: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_native_controller').default['deleteRoute']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_native_controller').default['deleteRoute']>>>
    }
  }
  'gateways.updateSystem': {
    methods: ["PATCH"]
    pattern: '/api/v1/gateways/:id/system'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/gateway_native').systemPatchValidator)>>
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/gateway_native').systemPatchValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_native_controller').default['updateSystem']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_native_controller').default['updateSystem']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'gateways.firewall': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/gateways/:id/firewall'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_firewall_controller').default['show']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_firewall_controller').default['show']>>>
    }
  }
  'gateways.orderFirewallRules': {
    methods: ["PUT"]
    pattern: '/api/v1/gateways/:id/firewall/rules/order'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_firewall_controller').default['orderRules']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_firewall_controller').default['orderRules']>>>
    }
  }
  'gateways.orderPortForwards': {
    methods: ["PUT"]
    pattern: '/api/v1/gateways/:id/firewall/port-forwards/order'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_firewall_controller').default['orderPortForwards']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_firewall_controller').default['orderPortForwards']>>>
    }
  }
  'gateways.resolveFirewallOrder': {
    methods: ["POST"]
    pattern: '/api/v1/gateways/:id/firewall/order/resolve'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/gateway_firewall').firewallOrderResolveValidator)>>
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/gateway_firewall').firewallOrderResolveValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_firewall_controller').default['resolveOrder']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_firewall_controller').default['resolveOrder']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'gateways.createPortForward': {
    methods: ["POST"]
    pattern: '/api/v1/gateways/:id/firewall/port-forwards'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/gateway_firewall').portForwardValidator)>>
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/gateway_firewall').portForwardValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_firewall_controller').default['createPortForward']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_firewall_controller').default['createPortForward']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'gateways.updatePortForward': {
    methods: ["PATCH"]
    pattern: '/api/v1/gateways/:id/firewall/port-forwards/:perchId'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/gateway_firewall').portForwardPatchValidator)>>
      paramsTuple: [ParamValue, ParamValue]
      params: { id: ParamValue; perchId: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/gateway_firewall').portForwardPatchValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_firewall_controller').default['updatePortForward']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_firewall_controller').default['updatePortForward']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'gateways.deletePortForward': {
    methods: ["DELETE"]
    pattern: '/api/v1/gateways/:id/firewall/port-forwards/:perchId'
    types: {
      body: {}
      paramsTuple: [ParamValue, ParamValue]
      params: { id: ParamValue; perchId: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_firewall_controller').default['deletePortForward']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_firewall_controller').default['deletePortForward']>>>
    }
  }
  'gateways.createFirewallRule': {
    methods: ["POST"]
    pattern: '/api/v1/gateways/:id/firewall/rules'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/gateway_firewall').firewallRuleValidator)>>
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/gateway_firewall').firewallRuleValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_firewall_controller').default['createRule']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_firewall_controller').default['createRule']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'gateways.updateFirewallRule': {
    methods: ["PATCH"]
    pattern: '/api/v1/gateways/:id/firewall/rules/:perchId'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/gateway_firewall').firewallRulePatchValidator)>>
      paramsTuple: [ParamValue, ParamValue]
      params: { id: ParamValue; perchId: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/gateway_firewall').firewallRulePatchValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_firewall_controller').default['updateRule']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_firewall_controller').default['updateRule']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'gateways.deleteFirewallRule': {
    methods: ["DELETE"]
    pattern: '/api/v1/gateways/:id/firewall/rules/:perchId'
    types: {
      body: {}
      paramsTuple: [ParamValue, ParamValue]
      params: { id: ParamValue; perchId: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/gateway_firewall_controller').default['deleteRule']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/gateway_firewall_controller').default['deleteRule']>>>
    }
  }
  'wifiConfig.overview': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/wifi/config'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/wifi_config_aps_controller').default['overview']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/wifi_config_aps_controller').default['overview']>>>
    }
  }
  'wifiConfig.aps.index': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/wifi/config/aps'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/wifi_config_aps_controller').default['index']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/wifi_config_aps_controller').default['index']>>>
    }
  }
  'wifiConfig.aps.show': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/wifi/config/aps/:apId'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { apId: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/wifi_config_aps_controller').default['show']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/wifi_config_aps_controller').default['show']>>>
    }
  }
  'wifiConfig.aps.health': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/wifi/config/aps/:apId/health'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { apId: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/wifi_config_aps_controller').default['health']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/wifi_config_aps_controller').default['health']>>>
    }
  }
  'wifiConfig.aps.syncStatus': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/wifi/config/aps/:apId/sync-status'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { apId: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/wifi_config_aps_controller').default['syncStatus']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/wifi_config_aps_controller').default['syncStatus']>>>
    }
  }
  'wifiConfig.aps.sections': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/wifi/config/aps/:apId/sections'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { apId: ParamValue }
      query: ExtractQueryForGet<InferInput<(typeof import('#validators/gateways').sectionFilterValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/wifi_config_aps_controller').default['sections']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/wifi_config_aps_controller').default['sections']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'wifiConfig.aps.section': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/wifi/config/aps/:apId/sections/:perchId'
    types: {
      body: {}
      paramsTuple: [ParamValue, ParamValue]
      params: { apId: ParamValue; perchId: ParamValue }
      query: ExtractQueryForGet<InferInput<(typeof import('#validators/wifi_config').wifiPagingValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/wifi_config_aps_controller').default['section']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/wifi_config_aps_controller').default['section']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'wifiConfig.aps.draft': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/wifi/config/aps/:apId/draft'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { apId: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/wifi_config_aps_controller').default['draft']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/wifi_config_aps_controller').default['draft']>>>
    }
  }
  'wifiConfig.aps.applies': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/wifi/config/aps/:apId/applies'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { apId: ParamValue }
      query: ExtractQueryForGet<InferInput<(typeof import('#validators/wifi_config').wifiPagingValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/wifi_config_aps_controller').default['applies']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/wifi_config_aps_controller').default['applies']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'wifiConfig.aps.apply': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/wifi/config/aps/:apId/applies/:applyId'
    types: {
      body: {}
      paramsTuple: [ParamValue, ParamValue]
      params: { apId: ParamValue; applyId: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/wifi_config_aps_controller').default['apply']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/wifi_config_aps_controller').default['apply']>>>
    }
  }
  'wifiConfig.aps.revisions': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/wifi/config/aps/:apId/revisions'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { apId: ParamValue }
      query: ExtractQueryForGet<InferInput<(typeof import('#validators/wifi_config').wifiPagingValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/wifi_config_aps_controller').default['revisions']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/wifi_config_aps_controller').default['revisions']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'wifiConfig.aps.revision': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/wifi/config/aps/:apId/revisions/:number'
    types: {
      body: {}
      paramsTuple: [ParamValue, ParamValue]
      params: { apId: ParamValue; number: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/wifi_config_aps_controller').default['revision']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/wifi_config_aps_controller').default['revision']>>>
    }
  }
  'wifiConfig.aps.events': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/wifi/config/aps/:apId/events'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { apId: ParamValue }
      query: ExtractQueryForGet<InferInput<(typeof import('#validators/wifi_config').wifiPagingValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/wifi_config_aps_controller').default['events']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/wifi_config_aps_controller').default['events']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'wifiConfig.aps.pairing': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/wifi/config/aps/:apId/pairing'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { apId: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/wifi_config_aps_controller').default['pairing']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/wifi_config_aps_controller').default['pairing']>>>
    }
  }
  'wifiConfig.aps.update': {
    methods: ["PATCH"]
    pattern: '/api/v1/wifi/config/aps/:apId'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/wifi_config').apPatchValidator)>>
      paramsTuple: [ParamValue]
      params: { apId: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/wifi_config').apPatchValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/wifi_config_aps_controller').default['update']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/wifi_config_aps_controller').default['update']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'wifiConfig.aps.refresh': {
    methods: ["POST"]
    pattern: '/api/v1/wifi/config/aps/:apId/refresh'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { apId: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/wifi_config_aps_controller').default['refresh']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/wifi_config_aps_controller').default['refresh']>>>
    }
  }
  'wifiConfig.aps.rejoin': {
    methods: ["POST"]
    pattern: '/api/v1/wifi/config/aps/:apId/rejoin'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/wifi_config').rejoinValidator)>>
      paramsTuple: [ParamValue]
      params: { apId: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/wifi_config').rejoinValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/wifi_config_aps_controller').default['rejoin']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/wifi_config_aps_controller').default['rejoin']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'wifiConfig.aps.dismissRejoin': {
    methods: ["POST"]
    pattern: '/api/v1/wifi/config/aps/:apId/rejoin/dismiss'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { apId: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/wifi_config_aps_controller').default['dismissRejoin']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/wifi_config_aps_controller').default['dismissRejoin']>>>
    }
  }
  'wifiConfig.aps.updateSection': {
    methods: ["PATCH"]
    pattern: '/api/v1/wifi/config/aps/:apId/sections/:perchId'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/gateways').sectionScopeValidator)>>
      paramsTuple: [ParamValue, ParamValue]
      params: { apId: ParamValue; perchId: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/gateways').sectionScopeValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/wifi_config_aps_controller').default['updateSection']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/wifi_config_aps_controller').default['updateSection']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'wifiConfig.aps.resolve': {
    methods: ["POST"]
    pattern: '/api/v1/wifi/config/aps/:apId/sections/resolve'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/gateways').sectionResolveValidator)>>
      paramsTuple: [ParamValue]
      params: { apId: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/gateways').sectionResolveValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/wifi_config_aps_controller').default['resolve']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/wifi_config_aps_controller').default['resolve']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'wifiConfig.aps.discardDraft': {
    methods: ["DELETE"]
    pattern: '/api/v1/wifi/config/aps/:apId/draft'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/gateways').perchIdsValidator)>>
      paramsTuple: [ParamValue]
      params: { apId: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/gateways').perchIdsValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/wifi_config_aps_controller').default['discardDraft']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/wifi_config_aps_controller').default['discardDraft']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'wifiConfig.aps.confirmApply': {
    methods: ["POST"]
    pattern: '/api/v1/wifi/config/aps/:apId/applies/:applyId/confirm'
    types: {
      body: {}
      paramsTuple: [ParamValue, ParamValue]
      params: { apId: ParamValue; applyId: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/wifi_config_aps_controller').default['confirmApply']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/wifi_config_aps_controller').default['confirmApply']>>>
    }
  }
  'wifiConfig.aps.revertApply': {
    methods: ["POST"]
    pattern: '/api/v1/wifi/config/aps/:apId/applies/:applyId/revert'
    types: {
      body: {}
      paramsTuple: [ParamValue, ParamValue]
      params: { apId: ParamValue; applyId: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/wifi_config_aps_controller').default['revertApply']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/wifi_config_aps_controller').default['revertApply']>>>
    }
  }
  'wifiConfig.aps.restoreRevision': {
    methods: ["POST"]
    pattern: '/api/v1/wifi/config/aps/:apId/revisions/:number/restore'
    types: {
      body: {}
      paramsTuple: [ParamValue, ParamValue]
      params: { apId: ParamValue; number: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/wifi_config_aps_controller').default['restoreRevision']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/wifi_config_aps_controller').default['restoreRevision']>>>
    }
  }
  'wifiConfig.aps.acceptDrift': {
    methods: ["POST"]
    pattern: '/api/v1/wifi/config/aps/:apId/drift/accept'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/gateways').perchIdsValidator)>>
      paramsTuple: [ParamValue]
      params: { apId: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/gateways').perchIdsValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/wifi_config_aps_controller').default['acceptDrift']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/wifi_config_aps_controller').default['acceptDrift']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'wifiConfig.aps.revertDrift': {
    methods: ["POST"]
    pattern: '/api/v1/wifi/config/aps/:apId/drift/revert-now'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/gateways').perchIdsValidator)>>
      paramsTuple: [ParamValue]
      params: { apId: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/gateways').perchIdsValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/wifi_config_aps_controller').default['revertDrift']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/wifi_config_aps_controller').default['revertDrift']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'wifiConfig.aps.resumeEnforcement': {
    methods: ["POST"]
    pattern: '/api/v1/wifi/config/aps/:apId/enforcement/resume'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { apId: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/wifi_config_aps_controller').default['resumeEnforcement']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/wifi_config_aps_controller').default['resumeEnforcement']>>>
    }
  }
  'wifiConfig.aps.startPairing': {
    methods: ["POST"]
    pattern: '/api/v1/wifi/config/aps/:apId/pairing'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { apId: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/wifi_config_aps_controller').default['pairingUnavailable']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/wifi_config_aps_controller').default['pairingUnavailable']>>>
    }
  }
  'wifiConfig.aps.confirmPairing': {
    methods: ["POST"]
    pattern: '/api/v1/wifi/config/aps/:apId/pairing/confirm'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { apId: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/wifi_config_aps_controller').default['pairingUnavailable']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/wifi_config_aps_controller').default['pairingUnavailable']>>>
    }
  }
  'wifiConfig.aps.unpair': {
    methods: ["DELETE"]
    pattern: '/api/v1/wifi/config/aps/:apId/pairing'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { apId: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/wifi_config_aps_controller').default['pairingUnavailable']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/wifi_config_aps_controller').default['pairingUnavailable']>>>
    }
  }
  'wifiConfig.aps.updateRadio': {
    methods: ["PATCH"]
    pattern: '/api/v1/wifi/config/aps/:apId/radios/:section'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/wifi_config').radioPatchValidator)>>
      paramsTuple: [ParamValue, ParamValue]
      params: { apId: ParamValue; section: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/wifi_config').radioPatchValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/wifi_config_radios_controller').default['update']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/wifi_config_radios_controller').default['update']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'wifiConfig.radios.index': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/wifi/radios'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/wifi_config_radios_controller').default['index']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/wifi_config_radios_controller').default['index']>>>
    }
  }
  'wifiConfig.networks.index': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/wifi/networks'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/wifi_config_networks_controller').default['index']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/wifi_config_networks_controller').default['index']>>>
    }
  }
  'wifiConfig.networks.show': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/wifi/networks/:id'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/wifi_config_networks_controller').default['show']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/wifi_config_networks_controller').default['show']>>>
    }
  }
  'wifiConfig.networks.store': {
    methods: ["POST"]
    pattern: '/api/v1/wifi/networks'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/wifi_config').networkCreateValidator)>>
      paramsTuple: []
      params: {}
      query: ExtractQuery<InferInput<(typeof import('#validators/wifi_config').networkCreateValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/wifi_config_networks_controller').default['store']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/wifi_config_networks_controller').default['store']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'wifiConfig.networks.update': {
    methods: ["PATCH"]
    pattern: '/api/v1/wifi/networks/:id'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/wifi_config').networkPatchValidator)>>
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/wifi_config').networkPatchValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/wifi_config_networks_controller').default['update']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/wifi_config_networks_controller').default['update']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'wifiConfig.networks.destroy': {
    methods: ["DELETE"]
    pattern: '/api/v1/wifi/networks/:id'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/wifi_config_networks_controller').default['destroy']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/wifi_config_networks_controller').default['destroy']>>>
    }
  }
  'wifiConfig.networks.setPassphrase': {
    methods: ["POST"]
    pattern: '/api/v1/wifi/networks/:id/passphrase'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/wifi_config').passphraseValidator)>>
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/wifi_config').passphraseValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/wifi_config_networks_controller').default['setPassphrase']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/wifi_config_networks_controller').default['setPassphrase']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'wifiConfig.networks.revealPassphrase': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/wifi/networks/:id/passphrase'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/wifi_config_networks_controller').default['revealPassphrase']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/wifi_config_networks_controller').default['revealPassphrase']>>>
    }
  }
  'wifiConfig.networks.putAp': {
    methods: ["PUT"]
    pattern: '/api/v1/wifi/networks/:id/aps/:apId'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/wifi_config').networkApValidator)>>
      paramsTuple: [ParamValue, ParamValue]
      params: { id: ParamValue; apId: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/wifi_config').networkApValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/wifi_config_networks_controller').default['putAp']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/wifi_config_networks_controller').default['putAp']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'wifiConfig.networks.resetAp': {
    methods: ["DELETE"]
    pattern: '/api/v1/wifi/networks/:id/aps/:apId/overrides'
    types: {
      body: {}
      paramsTuple: [ParamValue, ParamValue]
      params: { id: ParamValue; apId: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/wifi_config_networks_controller').default['resetAp']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/wifi_config_networks_controller').default['resetAp']>>>
    }
  }
  'wifiConfig.divergences.index': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/wifi/divergences'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: ExtractQueryForGet<InferInput<(typeof import('#validators/wifi_config').divergenceFilterValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/wifi_config_divergences_controller').default['index']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/wifi_config_divergences_controller').default['index']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'wifiConfig.adoption.show': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/wifi/adoption'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/wifi_config_adoption_controller').default['show']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/wifi_config_adoption_controller').default['show']>>>
    }
  }
  'wifiConfig.divergences.resolve': {
    methods: ["POST"]
    pattern: '/api/v1/wifi/divergences/resolve'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/wifi_config').divergenceResolveValidator)>>
      paramsTuple: []
      params: {}
      query: ExtractQuery<InferInput<(typeof import('#validators/wifi_config').divergenceResolveValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/wifi_config_divergences_controller').default['resolve']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/wifi_config_divergences_controller').default['resolve']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'wifiConfig.adoption.accept': {
    methods: ["POST"]
    pattern: '/api/v1/wifi/adoption'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/wifi_config').adoptionValidator)>>
      paramsTuple: []
      params: {}
      query: ExtractQuery<InferInput<(typeof import('#validators/wifi_config').adoptionValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/wifi_config_adoption_controller').default['accept']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/wifi_config_adoption_controller').default['accept']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'wifiConfig.rollouts.index': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/wifi/rollouts'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: ExtractQueryForGet<InferInput<(typeof import('#validators/wifi_config').wifiPagingValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/wifi_config_rollouts_controller').default['index']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/wifi_config_rollouts_controller').default['index']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'wifiConfig.rollouts.current': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/wifi/rollouts/current'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/wifi_config_rollouts_controller').default['current']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/wifi_config_rollouts_controller').default['current']>>>
    }
  }
  'wifiConfig.rollouts.show': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/wifi/rollouts/:rolloutId'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { rolloutId: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/wifi_config_rollouts_controller').default['show']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/wifi_config_rollouts_controller').default['show']>>>
    }
  }
  'wifiConfig.rollouts.preview': {
    methods: ["POST"]
    pattern: '/api/v1/wifi/rollouts/preview'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/wifi_config').rolloutPreviewValidator)>>
      paramsTuple: []
      params: {}
      query: ExtractQuery<InferInput<(typeof import('#validators/wifi_config').rolloutPreviewValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/wifi_config_rollouts_controller').default['preview']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/wifi_config_rollouts_controller').default['preview']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'wifiConfig.rollouts.store': {
    methods: ["POST"]
    pattern: '/api/v1/wifi/rollouts'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/wifi_config').rolloutCreateValidator)>>
      paramsTuple: []
      params: {}
      query: ExtractQuery<InferInput<(typeof import('#validators/wifi_config').rolloutCreateValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/wifi_config_rollouts_controller').default['store']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/wifi_config_rollouts_controller').default['store']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'wifiConfig.rollouts.action': {
    methods: ["POST"]
    pattern: '/api/v1/wifi/rollouts/:rolloutId/:action'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/wifi_config').rolloutActionValidator)>>
      paramsTuple: [ParamValue, ParamValue]
      params: { rolloutId: ParamValue; action: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/wifi_config').rolloutActionValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/wifi_config_rollouts_controller').default['action']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/wifi_config_rollouts_controller').default['action']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'wifiConfigSettings.show': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/settings/wifi-config'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/wifi_config_settings_controller').default['show']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/wifi_config_settings_controller').default['show']>>>
    }
  }
  'wifiConfigSettings.update': {
    methods: ["PATCH"]
    pattern: '/api/v1/settings/wifi-config'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/wifi_config_settings_controller').default['update']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/wifi_config_settings_controller').default['update']>>>
    }
  }
}
