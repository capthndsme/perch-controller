/* eslint-disable prettier/prettier */
import type { AdonisEndpoint } from '@tuyau/core/types'
import type { Registry } from './schema.d.ts'
import type { ApiDefinition } from './tree.d.ts'

const placeholder: any = {}

const routes = {
  'setup.status': {
    methods: ["GET","HEAD"],
    pattern: '/api/v1/setup/status',
    tokens: [{"old":"/api/v1/setup/status","type":0,"val":"api","end":""},{"old":"/api/v1/setup/status","type":0,"val":"v1","end":""},{"old":"/api/v1/setup/status","type":0,"val":"setup","end":""},{"old":"/api/v1/setup/status","type":0,"val":"status","end":""}],
    types: placeholder as Registry['setup.status']['types'],
  },
  'setup.admin': {
    methods: ["POST"],
    pattern: '/api/v1/setup/admin',
    tokens: [{"old":"/api/v1/setup/admin","type":0,"val":"api","end":""},{"old":"/api/v1/setup/admin","type":0,"val":"v1","end":""},{"old":"/api/v1/setup/admin","type":0,"val":"setup","end":""},{"old":"/api/v1/setup/admin","type":0,"val":"admin","end":""}],
    types: placeholder as Registry['setup.admin']['types'],
  },
  'setup.instance': {
    methods: ["POST"],
    pattern: '/api/v1/setup/instance',
    tokens: [{"old":"/api/v1/setup/instance","type":0,"val":"api","end":""},{"old":"/api/v1/setup/instance","type":0,"val":"v1","end":""},{"old":"/api/v1/setup/instance","type":0,"val":"setup","end":""},{"old":"/api/v1/setup/instance","type":0,"val":"instance","end":""}],
    types: placeholder as Registry['setup.instance']['types'],
  },
  'setup.collector': {
    methods: ["POST"],
    pattern: '/api/v1/setup/collector',
    tokens: [{"old":"/api/v1/setup/collector","type":0,"val":"api","end":""},{"old":"/api/v1/setup/collector","type":0,"val":"v1","end":""},{"old":"/api/v1/setup/collector","type":0,"val":"setup","end":""},{"old":"/api/v1/setup/collector","type":0,"val":"collector","end":""}],
    types: placeholder as Registry['setup.collector']['types'],
  },
  'auth.new_account.store': {
    methods: ["POST"],
    pattern: '/api/v1/auth/signup',
    tokens: [{"old":"/api/v1/auth/signup","type":0,"val":"api","end":""},{"old":"/api/v1/auth/signup","type":0,"val":"v1","end":""},{"old":"/api/v1/auth/signup","type":0,"val":"auth","end":""},{"old":"/api/v1/auth/signup","type":0,"val":"signup","end":""}],
    types: placeholder as Registry['auth.new_account.store']['types'],
  },
  'auth.access_tokens.store': {
    methods: ["POST"],
    pattern: '/api/v1/auth/login',
    tokens: [{"old":"/api/v1/auth/login","type":0,"val":"api","end":""},{"old":"/api/v1/auth/login","type":0,"val":"v1","end":""},{"old":"/api/v1/auth/login","type":0,"val":"auth","end":""},{"old":"/api/v1/auth/login","type":0,"val":"login","end":""}],
    types: placeholder as Registry['auth.access_tokens.store']['types'],
  },
  'profile.profile.show': {
    methods: ["GET","HEAD"],
    pattern: '/api/v1/account/profile',
    tokens: [{"old":"/api/v1/account/profile","type":0,"val":"api","end":""},{"old":"/api/v1/account/profile","type":0,"val":"v1","end":""},{"old":"/api/v1/account/profile","type":0,"val":"account","end":""},{"old":"/api/v1/account/profile","type":0,"val":"profile","end":""}],
    types: placeholder as Registry['profile.profile.show']['types'],
  },
  'profile.profile.change_password': {
    methods: ["PATCH"],
    pattern: '/api/v1/account/password',
    tokens: [{"old":"/api/v1/account/password","type":0,"val":"api","end":""},{"old":"/api/v1/account/password","type":0,"val":"v1","end":""},{"old":"/api/v1/account/password","type":0,"val":"account","end":""},{"old":"/api/v1/account/password","type":0,"val":"password","end":""}],
    types: placeholder as Registry['profile.profile.change_password']['types'],
  },
  'profile.access_tokens.destroy': {
    methods: ["POST"],
    pattern: '/api/v1/account/logout',
    tokens: [{"old":"/api/v1/account/logout","type":0,"val":"api","end":""},{"old":"/api/v1/account/logout","type":0,"val":"v1","end":""},{"old":"/api/v1/account/logout","type":0,"val":"account","end":""},{"old":"/api/v1/account/logout","type":0,"val":"logout","end":""}],
    types: placeholder as Registry['profile.access_tokens.destroy']['types'],
  },
  'settings.settings.hostname_enrichment': {
    methods: ["GET","HEAD"],
    pattern: '/api/v1/settings/hostname-enrichment',
    tokens: [{"old":"/api/v1/settings/hostname-enrichment","type":0,"val":"api","end":""},{"old":"/api/v1/settings/hostname-enrichment","type":0,"val":"v1","end":""},{"old":"/api/v1/settings/hostname-enrichment","type":0,"val":"settings","end":""},{"old":"/api/v1/settings/hostname-enrichment","type":0,"val":"hostname-enrichment","end":""}],
    types: placeholder as Registry['settings.settings.hostname_enrichment']['types'],
  },
  'settings.settings.update_hostname_enrichment': {
    methods: ["PATCH"],
    pattern: '/api/v1/settings/hostname-enrichment',
    tokens: [{"old":"/api/v1/settings/hostname-enrichment","type":0,"val":"api","end":""},{"old":"/api/v1/settings/hostname-enrichment","type":0,"val":"v1","end":""},{"old":"/api/v1/settings/hostname-enrichment","type":0,"val":"settings","end":""},{"old":"/api/v1/settings/hostname-enrichment","type":0,"val":"hostname-enrichment","end":""}],
    types: placeholder as Registry['settings.settings.update_hostname_enrichment']['types'],
  },
  'settings.settings.wifi_sources': {
    methods: ["GET","HEAD"],
    pattern: '/api/v1/settings/wifi-sources',
    tokens: [{"old":"/api/v1/settings/wifi-sources","type":0,"val":"api","end":""},{"old":"/api/v1/settings/wifi-sources","type":0,"val":"v1","end":""},{"old":"/api/v1/settings/wifi-sources","type":0,"val":"settings","end":""},{"old":"/api/v1/settings/wifi-sources","type":0,"val":"wifi-sources","end":""}],
    types: placeholder as Registry['settings.settings.wifi_sources']['types'],
  },
  'settings.settings.probe_wifi_source_draft': {
    methods: ["POST"],
    pattern: '/api/v1/settings/wifi-sources/probe',
    tokens: [{"old":"/api/v1/settings/wifi-sources/probe","type":0,"val":"api","end":""},{"old":"/api/v1/settings/wifi-sources/probe","type":0,"val":"v1","end":""},{"old":"/api/v1/settings/wifi-sources/probe","type":0,"val":"settings","end":""},{"old":"/api/v1/settings/wifi-sources/probe","type":0,"val":"wifi-sources","end":""},{"old":"/api/v1/settings/wifi-sources/probe","type":0,"val":"probe","end":""}],
    types: placeholder as Registry['settings.settings.probe_wifi_source_draft']['types'],
  },
  'settings.settings.create_wifi_source': {
    methods: ["POST"],
    pattern: '/api/v1/settings/wifi-sources',
    tokens: [{"old":"/api/v1/settings/wifi-sources","type":0,"val":"api","end":""},{"old":"/api/v1/settings/wifi-sources","type":0,"val":"v1","end":""},{"old":"/api/v1/settings/wifi-sources","type":0,"val":"settings","end":""},{"old":"/api/v1/settings/wifi-sources","type":0,"val":"wifi-sources","end":""}],
    types: placeholder as Registry['settings.settings.create_wifi_source']['types'],
  },
  'settings.settings.update_wifi_source': {
    methods: ["PUT"],
    pattern: '/api/v1/settings/wifi-sources/:id',
    tokens: [{"old":"/api/v1/settings/wifi-sources/:id","type":0,"val":"api","end":""},{"old":"/api/v1/settings/wifi-sources/:id","type":0,"val":"v1","end":""},{"old":"/api/v1/settings/wifi-sources/:id","type":0,"val":"settings","end":""},{"old":"/api/v1/settings/wifi-sources/:id","type":0,"val":"wifi-sources","end":""},{"old":"/api/v1/settings/wifi-sources/:id","type":1,"val":"id","end":""}],
    types: placeholder as Registry['settings.settings.update_wifi_source']['types'],
  },
  'settings.settings.delete_wifi_source': {
    methods: ["DELETE"],
    pattern: '/api/v1/settings/wifi-sources/:id',
    tokens: [{"old":"/api/v1/settings/wifi-sources/:id","type":0,"val":"api","end":""},{"old":"/api/v1/settings/wifi-sources/:id","type":0,"val":"v1","end":""},{"old":"/api/v1/settings/wifi-sources/:id","type":0,"val":"settings","end":""},{"old":"/api/v1/settings/wifi-sources/:id","type":0,"val":"wifi-sources","end":""},{"old":"/api/v1/settings/wifi-sources/:id","type":1,"val":"id","end":""}],
    types: placeholder as Registry['settings.settings.delete_wifi_source']['types'],
  },
  'settings.settings.probe_wifi_source': {
    methods: ["POST"],
    pattern: '/api/v1/settings/wifi-sources/:id/probe',
    tokens: [{"old":"/api/v1/settings/wifi-sources/:id/probe","type":0,"val":"api","end":""},{"old":"/api/v1/settings/wifi-sources/:id/probe","type":0,"val":"v1","end":""},{"old":"/api/v1/settings/wifi-sources/:id/probe","type":0,"val":"settings","end":""},{"old":"/api/v1/settings/wifi-sources/:id/probe","type":0,"val":"wifi-sources","end":""},{"old":"/api/v1/settings/wifi-sources/:id/probe","type":1,"val":"id","end":""},{"old":"/api/v1/settings/wifi-sources/:id/probe","type":0,"val":"probe","end":""}],
    types: placeholder as Registry['settings.settings.probe_wifi_source']['types'],
  },
  'settings.users.index': {
    methods: ["GET","HEAD"],
    pattern: '/api/v1/settings/users',
    tokens: [{"old":"/api/v1/settings/users","type":0,"val":"api","end":""},{"old":"/api/v1/settings/users","type":0,"val":"v1","end":""},{"old":"/api/v1/settings/users","type":0,"val":"settings","end":""},{"old":"/api/v1/settings/users","type":0,"val":"users","end":""}],
    types: placeholder as Registry['settings.users.index']['types'],
  },
  'settings.users.store': {
    methods: ["POST"],
    pattern: '/api/v1/settings/users',
    tokens: [{"old":"/api/v1/settings/users","type":0,"val":"api","end":""},{"old":"/api/v1/settings/users","type":0,"val":"v1","end":""},{"old":"/api/v1/settings/users","type":0,"val":"settings","end":""},{"old":"/api/v1/settings/users","type":0,"val":"users","end":""}],
    types: placeholder as Registry['settings.users.store']['types'],
  },
  'settings.users.updateRole': {
    methods: ["PATCH"],
    pattern: '/api/v1/settings/users/:id/role',
    tokens: [{"old":"/api/v1/settings/users/:id/role","type":0,"val":"api","end":""},{"old":"/api/v1/settings/users/:id/role","type":0,"val":"v1","end":""},{"old":"/api/v1/settings/users/:id/role","type":0,"val":"settings","end":""},{"old":"/api/v1/settings/users/:id/role","type":0,"val":"users","end":""},{"old":"/api/v1/settings/users/:id/role","type":1,"val":"id","end":""},{"old":"/api/v1/settings/users/:id/role","type":0,"val":"role","end":""}],
    types: placeholder as Registry['settings.users.updateRole']['types'],
  },
  'settings.users.destroy': {
    methods: ["DELETE"],
    pattern: '/api/v1/settings/users/:id',
    tokens: [{"old":"/api/v1/settings/users/:id","type":0,"val":"api","end":""},{"old":"/api/v1/settings/users/:id","type":0,"val":"v1","end":""},{"old":"/api/v1/settings/users/:id","type":0,"val":"settings","end":""},{"old":"/api/v1/settings/users/:id","type":0,"val":"users","end":""},{"old":"/api/v1/settings/users/:id","type":1,"val":"id","end":""}],
    types: placeholder as Registry['settings.users.destroy']['types'],
  },
  'aggregateTraffic': {
    methods: ["GET","HEAD"],
    pattern: '/api/v1/traffic',
    tokens: [{"old":"/api/v1/traffic","type":0,"val":"api","end":""},{"old":"/api/v1/traffic","type":0,"val":"v1","end":""},{"old":"/api/v1/traffic","type":0,"val":"traffic","end":""}],
    types: placeholder as Registry['aggregateTraffic']['types'],
  },
  'topTraffic': {
    methods: ["GET","HEAD"],
    pattern: '/api/v1/traffic/top',
    tokens: [{"old":"/api/v1/traffic/top","type":0,"val":"api","end":""},{"old":"/api/v1/traffic/top","type":0,"val":"v1","end":""},{"old":"/api/v1/traffic/top","type":0,"val":"traffic","end":""},{"old":"/api/v1/traffic/top","type":0,"val":"top","end":""}],
    types: placeholder as Registry['topTraffic']['types'],
  },
  'aggregateProtocols': {
    methods: ["GET","HEAD"],
    pattern: '/api/v1/protocols',
    tokens: [{"old":"/api/v1/protocols","type":0,"val":"api","end":""},{"old":"/api/v1/protocols","type":0,"val":"v1","end":""},{"old":"/api/v1/protocols","type":0,"val":"protocols","end":""}],
    types: placeholder as Registry['aggregateProtocols']['types'],
  },
  'aggregateProtocolDevices': {
    methods: ["GET","HEAD"],
    pattern: '/api/v1/protocols/:protocol/devices',
    tokens: [{"old":"/api/v1/protocols/:protocol/devices","type":0,"val":"api","end":""},{"old":"/api/v1/protocols/:protocol/devices","type":0,"val":"v1","end":""},{"old":"/api/v1/protocols/:protocol/devices","type":0,"val":"protocols","end":""},{"old":"/api/v1/protocols/:protocol/devices","type":1,"val":"protocol","end":""},{"old":"/api/v1/protocols/:protocol/devices","type":0,"val":"devices","end":""}],
    types: placeholder as Registry['aggregateProtocolDevices']['types'],
  },
  'topPeers': {
    methods: ["GET","HEAD"],
    pattern: '/api/v1/peers/top',
    tokens: [{"old":"/api/v1/peers/top","type":0,"val":"api","end":""},{"old":"/api/v1/peers/top","type":0,"val":"v1","end":""},{"old":"/api/v1/peers/top","type":0,"val":"peers","end":""},{"old":"/api/v1/peers/top","type":0,"val":"top","end":""}],
    types: placeholder as Registry['topPeers']['types'],
  },
  'services.index': {
    methods: ["GET","HEAD"],
    pattern: '/api/v1/services',
    tokens: [{"old":"/api/v1/services","type":0,"val":"api","end":""},{"old":"/api/v1/services","type":0,"val":"v1","end":""},{"old":"/api/v1/services","type":0,"val":"services","end":""}],
    types: placeholder as Registry['services.index']['types'],
  },
  'services.traffic': {
    methods: ["GET","HEAD"],
    pattern: '/api/v1/services/:serverName/traffic',
    tokens: [{"old":"/api/v1/services/:serverName/traffic","type":0,"val":"api","end":""},{"old":"/api/v1/services/:serverName/traffic","type":0,"val":"v1","end":""},{"old":"/api/v1/services/:serverName/traffic","type":0,"val":"services","end":""},{"old":"/api/v1/services/:serverName/traffic","type":1,"val":"serverName","end":""},{"old":"/api/v1/services/:serverName/traffic","type":0,"val":"traffic","end":""}],
    types: placeholder as Registry['services.traffic']['types'],
  },
  'router': {
    methods: ["GET","HEAD"],
    pattern: '/api/v1/router',
    tokens: [{"old":"/api/v1/router","type":0,"val":"api","end":""},{"old":"/api/v1/router","type":0,"val":"v1","end":""},{"old":"/api/v1/router","type":0,"val":"router","end":""}],
    types: placeholder as Registry['router']['types'],
  },
  'usage.index': {
    methods: ["GET","HEAD"],
    pattern: '/api/v1/usage',
    tokens: [{"old":"/api/v1/usage","type":0,"val":"api","end":""},{"old":"/api/v1/usage","type":0,"val":"v1","end":""},{"old":"/api/v1/usage","type":0,"val":"usage","end":""}],
    types: placeholder as Registry['usage.index']['types'],
  },
  'usage.intervals': {
    methods: ["GET","HEAD"],
    pattern: '/api/v1/usage/intervals',
    tokens: [{"old":"/api/v1/usage/intervals","type":0,"val":"api","end":""},{"old":"/api/v1/usage/intervals","type":0,"val":"v1","end":""},{"old":"/api/v1/usage/intervals","type":0,"val":"usage","end":""},{"old":"/api/v1/usage/intervals","type":0,"val":"intervals","end":""}],
    types: placeholder as Registry['usage.intervals']['types'],
  },
  'destinations.index': {
    methods: ["GET","HEAD"],
    pattern: '/api/v1/destinations',
    tokens: [{"old":"/api/v1/destinations","type":0,"val":"api","end":""},{"old":"/api/v1/destinations","type":0,"val":"v1","end":""},{"old":"/api/v1/destinations","type":0,"val":"destinations","end":""}],
    types: placeholder as Registry['destinations.index']['types'],
  },
  'destinations.traffic': {
    methods: ["GET","HEAD"],
    pattern: '/api/v1/destinations/:serverName/traffic',
    tokens: [{"old":"/api/v1/destinations/:serverName/traffic","type":0,"val":"api","end":""},{"old":"/api/v1/destinations/:serverName/traffic","type":0,"val":"v1","end":""},{"old":"/api/v1/destinations/:serverName/traffic","type":0,"val":"destinations","end":""},{"old":"/api/v1/destinations/:serverName/traffic","type":1,"val":"serverName","end":""},{"old":"/api/v1/destinations/:serverName/traffic","type":0,"val":"traffic","end":""}],
    types: placeholder as Registry['destinations.traffic']['types'],
  },
  'devices.index': {
    methods: ["GET","HEAD"],
    pattern: '/api/v1/devices',
    tokens: [{"old":"/api/v1/devices","type":0,"val":"api","end":""},{"old":"/api/v1/devices","type":0,"val":"v1","end":""},{"old":"/api/v1/devices","type":0,"val":"devices","end":""}],
    types: placeholder as Registry['devices.index']['types'],
  },
  'devices.labels': {
    methods: ["GET","HEAD"],
    pattern: '/api/v1/devices/labels',
    tokens: [{"old":"/api/v1/devices/labels","type":0,"val":"api","end":""},{"old":"/api/v1/devices/labels","type":0,"val":"v1","end":""},{"old":"/api/v1/devices/labels","type":0,"val":"devices","end":""},{"old":"/api/v1/devices/labels","type":0,"val":"labels","end":""}],
    types: placeholder as Registry['devices.labels']['types'],
  },
  'devices.label': {
    methods: ["GET","HEAD"],
    pattern: '/api/v1/devices/:mac/label',
    tokens: [{"old":"/api/v1/devices/:mac/label","type":0,"val":"api","end":""},{"old":"/api/v1/devices/:mac/label","type":0,"val":"v1","end":""},{"old":"/api/v1/devices/:mac/label","type":0,"val":"devices","end":""},{"old":"/api/v1/devices/:mac/label","type":1,"val":"mac","end":""},{"old":"/api/v1/devices/:mac/label","type":0,"val":"label","end":""}],
    types: placeholder as Registry['devices.label']['types'],
  },
  'devices.updateLabel': {
    methods: ["PATCH"],
    pattern: '/api/v1/devices/:mac/label',
    tokens: [{"old":"/api/v1/devices/:mac/label","type":0,"val":"api","end":""},{"old":"/api/v1/devices/:mac/label","type":0,"val":"v1","end":""},{"old":"/api/v1/devices/:mac/label","type":0,"val":"devices","end":""},{"old":"/api/v1/devices/:mac/label","type":1,"val":"mac","end":""},{"old":"/api/v1/devices/:mac/label","type":0,"val":"label","end":""}],
    types: placeholder as Registry['devices.updateLabel']['types'],
  },
  'devices.destroyLabel': {
    methods: ["DELETE"],
    pattern: '/api/v1/devices/:mac/label',
    tokens: [{"old":"/api/v1/devices/:mac/label","type":0,"val":"api","end":""},{"old":"/api/v1/devices/:mac/label","type":0,"val":"v1","end":""},{"old":"/api/v1/devices/:mac/label","type":0,"val":"devices","end":""},{"old":"/api/v1/devices/:mac/label","type":1,"val":"mac","end":""},{"old":"/api/v1/devices/:mac/label","type":0,"val":"label","end":""}],
    types: placeholder as Registry['devices.destroyLabel']['types'],
  },
  'devices.traffic': {
    methods: ["GET","HEAD"],
    pattern: '/api/v1/devices/:mac/traffic',
    tokens: [{"old":"/api/v1/devices/:mac/traffic","type":0,"val":"api","end":""},{"old":"/api/v1/devices/:mac/traffic","type":0,"val":"v1","end":""},{"old":"/api/v1/devices/:mac/traffic","type":0,"val":"devices","end":""},{"old":"/api/v1/devices/:mac/traffic","type":1,"val":"mac","end":""},{"old":"/api/v1/devices/:mac/traffic","type":0,"val":"traffic","end":""}],
    types: placeholder as Registry['devices.traffic']['types'],
  },
  'devices.peers': {
    methods: ["GET","HEAD"],
    pattern: '/api/v1/devices/:mac/peers',
    tokens: [{"old":"/api/v1/devices/:mac/peers","type":0,"val":"api","end":""},{"old":"/api/v1/devices/:mac/peers","type":0,"val":"v1","end":""},{"old":"/api/v1/devices/:mac/peers","type":0,"val":"devices","end":""},{"old":"/api/v1/devices/:mac/peers","type":1,"val":"mac","end":""},{"old":"/api/v1/devices/:mac/peers","type":0,"val":"peers","end":""}],
    types: placeholder as Registry['devices.peers']['types'],
  },
  'devices.peersHistory': {
    methods: ["GET","HEAD"],
    pattern: '/api/v1/devices/:mac/peers/history',
    tokens: [{"old":"/api/v1/devices/:mac/peers/history","type":0,"val":"api","end":""},{"old":"/api/v1/devices/:mac/peers/history","type":0,"val":"v1","end":""},{"old":"/api/v1/devices/:mac/peers/history","type":0,"val":"devices","end":""},{"old":"/api/v1/devices/:mac/peers/history","type":1,"val":"mac","end":""},{"old":"/api/v1/devices/:mac/peers/history","type":0,"val":"peers","end":""},{"old":"/api/v1/devices/:mac/peers/history","type":0,"val":"history","end":""}],
    types: placeholder as Registry['devices.peersHistory']['types'],
  },
  'devices.services': {
    methods: ["GET","HEAD"],
    pattern: '/api/v1/devices/:mac/services',
    tokens: [{"old":"/api/v1/devices/:mac/services","type":0,"val":"api","end":""},{"old":"/api/v1/devices/:mac/services","type":0,"val":"v1","end":""},{"old":"/api/v1/devices/:mac/services","type":0,"val":"devices","end":""},{"old":"/api/v1/devices/:mac/services","type":1,"val":"mac","end":""},{"old":"/api/v1/devices/:mac/services","type":0,"val":"services","end":""}],
    types: placeholder as Registry['devices.services']['types'],
  },
  'devices.destinations': {
    methods: ["GET","HEAD"],
    pattern: '/api/v1/devices/:mac/destinations',
    tokens: [{"old":"/api/v1/devices/:mac/destinations","type":0,"val":"api","end":""},{"old":"/api/v1/devices/:mac/destinations","type":0,"val":"v1","end":""},{"old":"/api/v1/devices/:mac/destinations","type":0,"val":"devices","end":""},{"old":"/api/v1/devices/:mac/destinations","type":1,"val":"mac","end":""},{"old":"/api/v1/devices/:mac/destinations","type":0,"val":"destinations","end":""}],
    types: placeholder as Registry['devices.destinations']['types'],
  },
  'devices.overview': {
    methods: ["GET","HEAD"],
    pattern: '/api/v1/devices/:mac/overview',
    tokens: [{"old":"/api/v1/devices/:mac/overview","type":0,"val":"api","end":""},{"old":"/api/v1/devices/:mac/overview","type":0,"val":"v1","end":""},{"old":"/api/v1/devices/:mac/overview","type":0,"val":"devices","end":""},{"old":"/api/v1/devices/:mac/overview","type":1,"val":"mac","end":""},{"old":"/api/v1/devices/:mac/overview","type":0,"val":"overview","end":""}],
    types: placeholder as Registry['devices.overview']['types'],
  },
  'devices.protocols': {
    methods: ["GET","HEAD"],
    pattern: '/api/v1/devices/:mac/protocols',
    tokens: [{"old":"/api/v1/devices/:mac/protocols","type":0,"val":"api","end":""},{"old":"/api/v1/devices/:mac/protocols","type":0,"val":"v1","end":""},{"old":"/api/v1/devices/:mac/protocols","type":0,"val":"devices","end":""},{"old":"/api/v1/devices/:mac/protocols","type":1,"val":"mac","end":""},{"old":"/api/v1/devices/:mac/protocols","type":0,"val":"protocols","end":""}],
    types: placeholder as Registry['devices.protocols']['types'],
  },
  'wifi.wifi.overview': {
    methods: ["GET","HEAD"],
    pattern: '/api/v1/wifi/overview',
    tokens: [{"old":"/api/v1/wifi/overview","type":0,"val":"api","end":""},{"old":"/api/v1/wifi/overview","type":0,"val":"v1","end":""},{"old":"/api/v1/wifi/overview","type":0,"val":"wifi","end":""},{"old":"/api/v1/wifi/overview","type":0,"val":"overview","end":""}],
    types: placeholder as Registry['wifi.wifi.overview']['types'],
  },
  'wifi.wifi.ssids': {
    methods: ["GET","HEAD"],
    pattern: '/api/v1/wifi/ssids',
    tokens: [{"old":"/api/v1/wifi/ssids","type":0,"val":"api","end":""},{"old":"/api/v1/wifi/ssids","type":0,"val":"v1","end":""},{"old":"/api/v1/wifi/ssids","type":0,"val":"wifi","end":""},{"old":"/api/v1/wifi/ssids","type":0,"val":"ssids","end":""}],
    types: placeholder as Registry['wifi.wifi.ssids']['types'],
  },
  'wifi.wifi.ssid_clients': {
    methods: ["GET","HEAD"],
    pattern: '/api/v1/wifi/ssids/:ssid/clients',
    tokens: [{"old":"/api/v1/wifi/ssids/:ssid/clients","type":0,"val":"api","end":""},{"old":"/api/v1/wifi/ssids/:ssid/clients","type":0,"val":"v1","end":""},{"old":"/api/v1/wifi/ssids/:ssid/clients","type":0,"val":"wifi","end":""},{"old":"/api/v1/wifi/ssids/:ssid/clients","type":0,"val":"ssids","end":""},{"old":"/api/v1/wifi/ssids/:ssid/clients","type":1,"val":"ssid","end":""},{"old":"/api/v1/wifi/ssids/:ssid/clients","type":0,"val":"clients","end":""}],
    types: placeholder as Registry['wifi.wifi.ssid_clients']['types'],
  },
  'wifi.wifi.ssid_throughput': {
    methods: ["GET","HEAD"],
    pattern: '/api/v1/wifi/ssids/:ssid/throughput',
    tokens: [{"old":"/api/v1/wifi/ssids/:ssid/throughput","type":0,"val":"api","end":""},{"old":"/api/v1/wifi/ssids/:ssid/throughput","type":0,"val":"v1","end":""},{"old":"/api/v1/wifi/ssids/:ssid/throughput","type":0,"val":"wifi","end":""},{"old":"/api/v1/wifi/ssids/:ssid/throughput","type":0,"val":"ssids","end":""},{"old":"/api/v1/wifi/ssids/:ssid/throughput","type":1,"val":"ssid","end":""},{"old":"/api/v1/wifi/ssids/:ssid/throughput","type":0,"val":"throughput","end":""}],
    types: placeholder as Registry['wifi.wifi.ssid_throughput']['types'],
  },
  'wifi.wifi.clients': {
    methods: ["GET","HEAD"],
    pattern: '/api/v1/wifi/clients',
    tokens: [{"old":"/api/v1/wifi/clients","type":0,"val":"api","end":""},{"old":"/api/v1/wifi/clients","type":0,"val":"v1","end":""},{"old":"/api/v1/wifi/clients","type":0,"val":"wifi","end":""},{"old":"/api/v1/wifi/clients","type":0,"val":"clients","end":""}],
    types: placeholder as Registry['wifi.wifi.clients']['types'],
  },
  'wifi.wifi.clients_history': {
    methods: ["GET","HEAD"],
    pattern: '/api/v1/wifi/clients/history',
    tokens: [{"old":"/api/v1/wifi/clients/history","type":0,"val":"api","end":""},{"old":"/api/v1/wifi/clients/history","type":0,"val":"v1","end":""},{"old":"/api/v1/wifi/clients/history","type":0,"val":"wifi","end":""},{"old":"/api/v1/wifi/clients/history","type":0,"val":"clients","end":""},{"old":"/api/v1/wifi/clients/history","type":0,"val":"history","end":""}],
    types: placeholder as Registry['wifi.wifi.clients_history']['types'],
  },
  'wifi.wifi.client': {
    methods: ["GET","HEAD"],
    pattern: '/api/v1/wifi/clients/:mac',
    tokens: [{"old":"/api/v1/wifi/clients/:mac","type":0,"val":"api","end":""},{"old":"/api/v1/wifi/clients/:mac","type":0,"val":"v1","end":""},{"old":"/api/v1/wifi/clients/:mac","type":0,"val":"wifi","end":""},{"old":"/api/v1/wifi/clients/:mac","type":0,"val":"clients","end":""},{"old":"/api/v1/wifi/clients/:mac","type":1,"val":"mac","end":""}],
    types: placeholder as Registry['wifi.wifi.client']['types'],
  },
  'wifi.wifi.client_signal': {
    methods: ["GET","HEAD"],
    pattern: '/api/v1/wifi/clients/:mac/signal',
    tokens: [{"old":"/api/v1/wifi/clients/:mac/signal","type":0,"val":"api","end":""},{"old":"/api/v1/wifi/clients/:mac/signal","type":0,"val":"v1","end":""},{"old":"/api/v1/wifi/clients/:mac/signal","type":0,"val":"wifi","end":""},{"old":"/api/v1/wifi/clients/:mac/signal","type":0,"val":"clients","end":""},{"old":"/api/v1/wifi/clients/:mac/signal","type":1,"val":"mac","end":""},{"old":"/api/v1/wifi/clients/:mac/signal","type":0,"val":"signal","end":""}],
    types: placeholder as Registry['wifi.wifi.client_signal']['types'],
  },
  'wifi.wifi.rf': {
    methods: ["GET","HEAD"],
    pattern: '/api/v1/wifi/rf',
    tokens: [{"old":"/api/v1/wifi/rf","type":0,"val":"api","end":""},{"old":"/api/v1/wifi/rf","type":0,"val":"v1","end":""},{"old":"/api/v1/wifi/rf","type":0,"val":"wifi","end":""},{"old":"/api/v1/wifi/rf","type":0,"val":"rf","end":""}],
    types: placeholder as Registry['wifi.wifi.rf']['types'],
  },
  'wifi.wifi.rf_history': {
    methods: ["GET","HEAD"],
    pattern: '/api/v1/wifi/rf/history',
    tokens: [{"old":"/api/v1/wifi/rf/history","type":0,"val":"api","end":""},{"old":"/api/v1/wifi/rf/history","type":0,"val":"v1","end":""},{"old":"/api/v1/wifi/rf/history","type":0,"val":"wifi","end":""},{"old":"/api/v1/wifi/rf/history","type":0,"val":"rf","end":""},{"old":"/api/v1/wifi/rf/history","type":0,"val":"history","end":""}],
    types: placeholder as Registry['wifi.wifi.rf_history']['types'],
  },
  'wifi.wifi.aps': {
    methods: ["GET","HEAD"],
    pattern: '/api/v1/wifi/aps',
    tokens: [{"old":"/api/v1/wifi/aps","type":0,"val":"api","end":""},{"old":"/api/v1/wifi/aps","type":0,"val":"v1","end":""},{"old":"/api/v1/wifi/aps","type":0,"val":"wifi","end":""},{"old":"/api/v1/wifi/aps","type":0,"val":"aps","end":""}],
    types: placeholder as Registry['wifi.wifi.aps']['types'],
  },
  'wifi.wifi.aps_throughput': {
    methods: ["GET","HEAD"],
    pattern: '/api/v1/wifi/aps/throughput',
    tokens: [{"old":"/api/v1/wifi/aps/throughput","type":0,"val":"api","end":""},{"old":"/api/v1/wifi/aps/throughput","type":0,"val":"v1","end":""},{"old":"/api/v1/wifi/aps/throughput","type":0,"val":"wifi","end":""},{"old":"/api/v1/wifi/aps/throughput","type":0,"val":"aps","end":""},{"old":"/api/v1/wifi/aps/throughput","type":0,"val":"throughput","end":""}],
    types: placeholder as Registry['wifi.wifi.aps_throughput']['types'],
  },
  'wifi.wifi.ap_health': {
    methods: ["GET","HEAD"],
    pattern: '/api/v1/wifi/aps/:id/health',
    tokens: [{"old":"/api/v1/wifi/aps/:id/health","type":0,"val":"api","end":""},{"old":"/api/v1/wifi/aps/:id/health","type":0,"val":"v1","end":""},{"old":"/api/v1/wifi/aps/:id/health","type":0,"val":"wifi","end":""},{"old":"/api/v1/wifi/aps/:id/health","type":0,"val":"aps","end":""},{"old":"/api/v1/wifi/aps/:id/health","type":1,"val":"id","end":""},{"old":"/api/v1/wifi/aps/:id/health","type":0,"val":"health","end":""}],
    types: placeholder as Registry['wifi.wifi.ap_health']['types'],
  },
  'wifi.wifi.kick_client': {
    methods: ["POST"],
    pattern: '/api/v1/wifi/clients/:mac/kick',
    tokens: [{"old":"/api/v1/wifi/clients/:mac/kick","type":0,"val":"api","end":""},{"old":"/api/v1/wifi/clients/:mac/kick","type":0,"val":"v1","end":""},{"old":"/api/v1/wifi/clients/:mac/kick","type":0,"val":"wifi","end":""},{"old":"/api/v1/wifi/clients/:mac/kick","type":0,"val":"clients","end":""},{"old":"/api/v1/wifi/clients/:mac/kick","type":1,"val":"mac","end":""},{"old":"/api/v1/wifi/clients/:mac/kick","type":0,"val":"kick","end":""}],
    types: placeholder as Registry['wifi.wifi.kick_client']['types'],
  },
  'wifi.wifi.steer_client': {
    methods: ["POST"],
    pattern: '/api/v1/wifi/clients/:mac/steer',
    tokens: [{"old":"/api/v1/wifi/clients/:mac/steer","type":0,"val":"api","end":""},{"old":"/api/v1/wifi/clients/:mac/steer","type":0,"val":"v1","end":""},{"old":"/api/v1/wifi/clients/:mac/steer","type":0,"val":"wifi","end":""},{"old":"/api/v1/wifi/clients/:mac/steer","type":0,"val":"clients","end":""},{"old":"/api/v1/wifi/clients/:mac/steer","type":1,"val":"mac","end":""},{"old":"/api/v1/wifi/clients/:mac/steer","type":0,"val":"steer","end":""}],
    types: placeholder as Registry['wifi.wifi.steer_client']['types'],
  },
  'wifi.wifi.reboot_ap': {
    methods: ["POST"],
    pattern: '/api/v1/wifi/aps/:id/reboot',
    tokens: [{"old":"/api/v1/wifi/aps/:id/reboot","type":0,"val":"api","end":""},{"old":"/api/v1/wifi/aps/:id/reboot","type":0,"val":"v1","end":""},{"old":"/api/v1/wifi/aps/:id/reboot","type":0,"val":"wifi","end":""},{"old":"/api/v1/wifi/aps/:id/reboot","type":0,"val":"aps","end":""},{"old":"/api/v1/wifi/aps/:id/reboot","type":1,"val":"id","end":""},{"old":"/api/v1/wifi/aps/:id/reboot","type":0,"val":"reboot","end":""}],
    types: placeholder as Registry['wifi.wifi.reboot_ap']['types'],
  },
  'wifi.wifi.locate_ap': {
    methods: ["POST"],
    pattern: '/api/v1/wifi/aps/:id/locate',
    tokens: [{"old":"/api/v1/wifi/aps/:id/locate","type":0,"val":"api","end":""},{"old":"/api/v1/wifi/aps/:id/locate","type":0,"val":"v1","end":""},{"old":"/api/v1/wifi/aps/:id/locate","type":0,"val":"wifi","end":""},{"old":"/api/v1/wifi/aps/:id/locate","type":0,"val":"aps","end":""},{"old":"/api/v1/wifi/aps/:id/locate","type":1,"val":"id","end":""},{"old":"/api/v1/wifi/aps/:id/locate","type":0,"val":"locate","end":""}],
    types: placeholder as Registry['wifi.wifi.locate_ap']['types'],
  },
} as const satisfies Record<string, AdonisEndpoint>

export { routes }

export const registry = {
  routes,
  $tree: {} as ApiDefinition,
}

declare module '@tuyau/core/types' {
  export interface UserRegistry {
    routes: typeof routes
    $tree: ApiDefinition
  }
}
