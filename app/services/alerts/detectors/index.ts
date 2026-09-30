/**
 * Imports every detector module; each registers itself with `registerDetector`
 * (`#services/alerts/registry`) when imported. The evaluate task imports this file.
 * Created by WP-A1; the detector files belong to WP-A5a (agents, devices, system) and
 * WP-A5b (wan, gateway, ports, portal, scans).
 */
import './agents.js'
import './devices.js'
import './system.js'
import './wan.js'
import './gateway.js'
import './ports.js'
import './portal.js'
import './scans.js'
