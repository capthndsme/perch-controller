import { AgentHub } from '#services/agent_hub'

/**
 * Live collector sessions, keyed by `collectors.id` (docs/collector-agent.md
 * section 3). A session is registered only after its `collector.hello` has
 * been accepted, so every id here is a row that exists.
 */
export * from '#services/agent_hub'

const collectorHub = new AgentHub('collector')
export default collectorHub
