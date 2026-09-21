import type WifiAccessPoint from '#models/wifi_access_point'
import hub, {
  AgentOfflineError,
  AgentRpcError,
  AgentTimeoutError,
  DEFAULT_REQUEST_TIMEOUT_MS,
  RPC_ERRORS,
} from '#services/ap_agent_hub'
import type { WifiCommandResult } from '#services/wifi_command_runner'

/**
 * Which channel a two-way command takes to an AP (docs/ap-controller.md
 * section 3.2): the Perch AP Daemon session for agent rows, SSH for scrape
 * rows that have it configured, nothing otherwise.
 */

export type CommandVia = 'agent' | 'ssh'

export type CommandControls = {
  via: CommandVia | null
  online: boolean
  kick: boolean
  steer: boolean
  locate: boolean
  reboot: boolean
}

/** SSH two-way commands are usable on this (scrape) row. */
export function isSshCommandEnabled(ap: WifiAccessPoint): boolean {
  return ap.enableTwoWayCommands && Boolean(ap.sshHost?.trim()) && Boolean(ap.sshUsername?.trim())
}

export function commandChannel(ap: WifiAccessPoint): CommandVia | null {
  if (ap.transport === 'agent') return 'agent'
  if (isSshCommandEnabled(ap)) return 'ssh'
  return null
}

/**
 * What the dashboard may offer for this AP right now. An agent's buttons
 * follow its session and the capabilities it reported in `system.info`;
 * SSH is assumed to work whenever it is configured.
 */
export function commandControls(ap: WifiAccessPoint): CommandControls {
  const via = commandChannel(ap)
  if (via === 'agent') {
    const online = hub.isOnline(ap.id)
    const capabilities = new Set(ap.agentInfo?.capabilities ?? [])
    const can = (capability: string) => online && capabilities.has(capability)
    return {
      via,
      online,
      kick: can('kick'),
      steer: can('kick'),
      locate: can('locate'),
      reboot: can('reboot'),
    }
  }
  if (via === 'ssh') {
    return { via, online: true, kick: true, steer: true, locate: true, reboot: true }
  }
  return { via: null, online: false, kick: false, steer: false, locate: false, reboot: false }
}

let commandTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS

/** Test-only: shorten (or restore, with null) how long a command waits for the agent. */
export function setAgentCommandTimeoutForTesting(timeoutMs: number | null) {
  commandTimeoutMs = timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
}

export type AgentCommandOutcome<T> =
  | { ok: true; result: T; latencyMs: number }
  | { ok: false; error: Error; latencyMs: number }

/** One JSON-RPC call to the AP's agent, timed, never throwing. */
export async function runAgentCommand<T = Record<string, unknown>>(
  apId: number,
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs: number = commandTimeoutMs
): Promise<AgentCommandOutcome<T>> {
  const start = performance.now()
  try {
    const result = await hub.request<T>(apId, method, params, { timeoutMs })
    return { ok: true, result, latencyMs: Math.round(performance.now() - start) }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error : new Error(String(error)),
      latencyMs: Math.round(performance.now() - start),
    }
  }
}

/** Audit-row shape (`wifi_command_audits`) of an agent call. */
export function agentAuditResult(outcome: AgentCommandOutcome<unknown>): WifiCommandResult {
  if (outcome.ok) {
    return {
      ok: true,
      stdout: JSON.stringify(outcome.result ?? null),
      stderr: '',
      latencyMs: outcome.latencyMs,
    }
  }
  return {
    ok: false,
    stdout: '',
    stderr: outcome.error.message,
    latencyMs: outcome.latencyMs,
    error: outcome.error.message,
  }
}

/** HTTP status + body for a failed agent command. */
export function agentErrorResponse(error: Error): {
  status: number
  body: { error: string; message: string }
} {
  if (error instanceof AgentOfflineError) {
    return {
      status: 409,
      body: {
        error: 'agent_offline',
        message: 'The Perch AP Daemon on this AP is not connected.',
      },
    }
  }
  if (error instanceof AgentTimeoutError) {
    return {
      status: 504,
      body: {
        error: 'agent_timeout',
        message: `The Perch AP Daemon did not answer within ${error.timeoutMs} ms.`,
      },
    }
  }
  if (error instanceof AgentRpcError) {
    if (error.code === RPC_ERRORS.NOT_FOUND) {
      return { status: 404, body: { error: 'wifi_client_not_associated', message: error.message } }
    }
    if (error.code === RPC_ERRORS.UNSUPPORTED) {
      return { status: 400, body: { error: 'wifi_command_unsupported', message: error.message } }
    }
    return { status: 400, body: { error: 'wifi_command_failed', message: error.message } }
  }
  return { status: 400, body: { error: 'wifi_command_failed', message: error.message } }
}
