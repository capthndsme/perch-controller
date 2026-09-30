/*
|--------------------------------------------------------------------------
| Gateway sync routes (docs/design/gateway-sync/rest.md)
|--------------------------------------------------------------------------
|
| The rest of the managed gateway's native OpenWrt settings: WAN, WireGuard,
| IPv6, ambiguous sections, firewall defaults, UPnP, DDNS, multi-WAN and the
| Settings → Gateway sync page. Imported by `start/routes.ts` before its body
| runs, so these groups register before the SPA catch-all.
|
| Every route here is admin-only, reads included (rest.md "Auth": WAN, VPN,
| IPv6, DDNS and UPnP config carry user names, endpoints and ACLs). The
| observation reads any signed-in user may see (`wan-status`, `upnp`,
| `wireguard` under `:gatewayId`) stay in `start/routes.ts`.
|
| Each work package owns its own block below. Routes of a package that is not
| built yet answer 501 `not_built`. Static segments come before `:perchId` in
| each block (`wan/history`, `wan/order`, `wan/aliases/…` before
| `wan/:perchId`), as `networks/history` does in `start/routes.ts`.
*/

import router from '@adonisjs/core/services/router'
import { middleware } from '#start/kernel'

const GatewayWanController = () => import('#controllers/gateway_wan_controller')
const GatewayWireguardController = () => import('#controllers/gateway_wireguard_controller')
const GatewayIpv6Controller = () => import('#controllers/gateway_ipv6_controller')
const GatewayAmbiguitiesController = () => import('#controllers/gateway_ambiguities_controller')
const GatewayFirewallDefaultsController = () =>
  import('#controllers/gateway_firewall_defaults_controller')
const GatewayUpnpController = () => import('#controllers/gateway_upnp_controller')
const GatewayDdnsController = () => import('#controllers/gateway_ddns_controller')
const GatewayMultiwanController = () => import('#controllers/gateway_multiwan_controller')
const GatewaySyncSettingsController = () => import('#controllers/gateway_sync_settings_controller')

router
  .group(() => {
    router
      .group(() => {
        // ── B1: WAN (rest.md 3) ────────────────────────────────────────────
        router.get(':id/wan', [GatewayWanController, 'index']).as('wan')
        router.get(':id/wan/history', [GatewayWanController, 'history']).as('wanHistory')
        router.put(':id/wan/order', [GatewayWanController, 'order']).as('wanOrder')
        router.post(':id/wan', [GatewayWanController, 'create']).as('wanCreate')
        router
          .patch(':id/wan/aliases/:perchId', [GatewayWanController, 'updateAlias'])
          .as('wanAliasUpdate')
        router
          .delete(':id/wan/aliases/:perchId', [GatewayWanController, 'deleteAlias'])
          .as('wanAliasDelete')
        router.get(':id/wan/:perchId', [GatewayWanController, 'show']).as('wanShow')
        router.patch(':id/wan/:perchId', [GatewayWanController, 'update']).as('wanUpdate')
        router.delete(':id/wan/:perchId', [GatewayWanController, 'destroy']).as('wanDelete')
        router
          .post(':id/wan/:perchId/aliases', [GatewayWanController, 'createAlias'])
          .as('wanAliasCreate')

        // ── B2: WireGuard (rest.md 4) ──────────────────────────────────────
        router
          .get(':id/wireguard/config', [GatewayWireguardController, 'index'])
          .as('wireguardConfig')
        router
          .post(':id/wireguard/interfaces', [GatewayWireguardController, 'createInterface'])
          .as('wireguardInterfaceCreate')
        router
          .patch(':id/wireguard/interfaces/:perchId', [
            GatewayWireguardController,
            'updateInterface',
          ])
          .as('wireguardInterfaceUpdate')
        router
          .delete(':id/wireguard/interfaces/:perchId', [
            GatewayWireguardController,
            'deleteInterface',
          ])
          .as('wireguardInterfaceDelete')
        router
          .post(':id/wireguard/interfaces/:perchId/rotate-key', [
            GatewayWireguardController,
            'rotateKey',
          ])
          .as('wireguardRotateKey')
        router
          .post(':id/wireguard/interfaces/:perchId/peers', [
            GatewayWireguardController,
            'createPeer',
          ])
          .as('wireguardPeerCreate')
        router
          .patch(':id/wireguard/peers/:perchId', [GatewayWireguardController, 'updatePeer'])
          .as('wireguardPeerUpdate')
        router
          .delete(':id/wireguard/peers/:perchId', [GatewayWireguardController, 'deletePeer'])
          .as('wireguardPeerDelete')

        // ── B4: IPv6 (rest.md 5) ───────────────────────────────────────────
        router.get(':id/ipv6', [GatewayIpv6Controller, 'show']).as('ipv6')
        router.patch(':id/ipv6', [GatewayIpv6Controller, 'update']).as('ipv6Update')
        router
          .patch(':id/ipv6/lans/:network', [GatewayIpv6Controller, 'updateLan'])
          .as('ipv6LanUpdate')
          .where('network', /^[A-Za-z0-9_.-]{1,32}$/)

        // ── B3: ambiguous sections (rest.md 6) ─────────────────────────────
        router.get(':id/ambiguities', [GatewayAmbiguitiesController, 'index']).as('ambiguities')
        router
          .post(':id/ambiguities/resolve', [GatewayAmbiguitiesController, 'resolve'])
          .as('ambiguitiesResolve')

        // ── B3: firewall defaults (rest.md 7) ──────────────────────────────
        router
          .get(':id/firewall/defaults', [GatewayFirewallDefaultsController, 'show'])
          .as('firewallDefaults')
        router
          .patch(':id/firewall/defaults', [GatewayFirewallDefaultsController, 'update'])
          .as('firewallDefaultsUpdate')

        // ── B5: UPnP (rest.md 8) ───────────────────────────────────────────
        router.get(':id/upnp/config', [GatewayUpnpController, 'show']).as('upnpConfig')
        router.patch(':id/upnp/config', [GatewayUpnpController, 'update']).as('upnpConfigUpdate')
        router.put(':id/upnp/acl/order', [GatewayUpnpController, 'orderAcl']).as('upnpAclOrder')
        router.post(':id/upnp/acl', [GatewayUpnpController, 'createAcl']).as('upnpAclCreate')
        router
          .patch(':id/upnp/acl/:perchId', [GatewayUpnpController, 'updateAcl'])
          .as('upnpAclUpdate')
        router
          .delete(':id/upnp/acl/:perchId', [GatewayUpnpController, 'deleteAcl'])
          .as('upnpAclDelete')
        router
          .post(':id/upnp/mappings/delete', [GatewayUpnpController, 'deleteMappings'])
          .as('upnpMappingsDelete')
        router
          .put(':id/upnp/devices/:mac', [GatewayUpnpController, 'blockDevice'])
          .as('upnpDeviceBlock')

        // ── B6: DDNS (rest.md 9) ───────────────────────────────────────────
        router.get(':id/ddns', [GatewayDdnsController, 'index']).as('ddns')
        router
          .post(':id/ddns/services', [GatewayDdnsController, 'createService'])
          .as('ddnsServiceCreate')
        router
          .patch(':id/ddns/services/:perchId', [GatewayDdnsController, 'updateService'])
          .as('ddnsServiceUpdate')
        router
          .delete(':id/ddns/services/:perchId', [GatewayDdnsController, 'deleteService'])
          .as('ddnsServiceDelete')
        router
          .post(':id/ddns/services/:perchId/update-now', [GatewayDdnsController, 'updateNow'])
          .as('ddnsUpdateNow')

        // ── B7a: multi-WAN, read only (rest.md 10; decision 12 stands, no PUT) ─
        router.get(':id/multiwan', [GatewayMultiwanController, 'show']).as('multiwan')
      })
      .prefix('gateways')
      .as('gatewaySync')
      .where('id', router.matchers.number())
      .use([middleware.auth(), middleware.requirePasswordChange(), middleware.requireAdmin()])

    // ── B1: Settings → Gateway sync (rest.md 11) ───────────────────────────
    router
      .group(() => {
        router.get('gateway-sync', [GatewaySyncSettingsController, 'show']).as('show')
        router.patch('gateway-sync', [GatewaySyncSettingsController, 'update']).as('update')
      })
      .prefix('settings')
      .as('gatewaySyncSettings')
      .use([middleware.auth(), middleware.requirePasswordChange(), middleware.requireAdmin()])
  })
  .prefix('/api/v1')
  .use(middleware.requireSetupComplete())
