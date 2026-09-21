import type { ApplicationService } from '@adonisjs/core/types'
import type { AgentGateway } from '#services/agent_gateway'

/**
 * Mounts the device-agent WebSocket endpoints (`/api/v1/ap-agent/ws` for the
 * Perch AP Daemon, `/api/v1/collector-agent/ws` for the collector) on the
 * HTTP server. Web environment only: `ready()` runs after the ignitor has
 * created and started the Node server, which is what the gateway hooks.
 *
 * Shutdown order matters. On SIGTERM the ignitor's own `terminating` hook
 * awaits `server.close()`, which waits for every open connection — upgraded
 * WebSockets included — so the agents have to be sent away first. Hooks run
 * in reverse registration order and this one is registered after the
 * ignitor's, so it runs before it. `shutdown()` is the belt to that brace.
 */
export default class AgentGatewayProvider {
  #gateway: AgentGateway | null = null

  constructor(protected app: ApplicationService) {}

  async ready() {
    if (this.app.getEnvironment() !== 'web') return
    const server = await this.app.container.make('server')
    const nodeServer = server.getNodeServer()
    if (!nodeServer) return

    const { attachAgentGateway } = await import('#services/agent_gateway')
    this.#gateway = await attachAgentGateway(nodeServer)
    this.app.terminating(async () => {
      await this.#gateway?.close()
    })
  }

  async shutdown() {
    await this.#gateway?.close()
    this.#gateway = null
  }
}
