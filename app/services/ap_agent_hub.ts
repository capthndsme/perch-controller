import { AgentHub } from '#services/agent_hub'

/**
 * Live Perch AP Daemon sessions, keyed by `wifi_access_points.id`
 * (docs/ap-controller.md section 2.3). The class, errors and codes live in
 * `agent_hub.ts` and are re-exported here for the AP code paths.
 */
export * from '#services/agent_hub'

const hub = new AgentHub('ap')
export default hub
