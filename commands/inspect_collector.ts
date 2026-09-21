import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import Collector from '#models/collector'
import { probeCollector } from '#services/collector_probe'

/**
 * `node ace inspect:collector [--id=N] [--top=10]`
 *
 * Operator escape hatch for "why is the dashboard empty?" debugging
 * without the dashboard. Probes each enabled collector, lists its top
 * devices by total bytes, and prints the latest probe status. Works
 * before and after setup is complete (it talks to the DB directly, no
 * HTTP), so it can be wired into systemd `ExecStartPost` health checks
 * eventually.
 */
export default class InspectCollectorCommand extends BaseCommand {
  static commandName = 'inspect:collector'
  static description =
    'Probe registered collectors and print their top devices. Useful for debug-without-dashboard.'

  static options: CommandOptions = {
    startApp: true, // needs the DB + encryption services
  }

  @flags.number({
    description:
      'Restrict to a single collector by id. When omitted, inspects every enabled collector.',
  })
  declare id?: number

  @flags.number({
    description: 'How many top devices to print per collector. Default 10.',
    default: 10,
  })
  declare top: number

  async run(): Promise<void> {
    // Same filter the poller uses, so the debug command shows exactly what
    // the scheduler would touch.
    const query = Collector.query().where('enabled', true).where('lifecycle', 'adopted')
    if (this.id !== undefined) query.where('id', this.id)
    const collectors = await query

    if (collectors.length === 0) {
      this.logger.warning(
        this.id !== undefined
          ? `No enabled, adopted collector found with id=${this.id}.`
          : 'No enabled collectors registered. Run the setup wizard or POST /api/v1/setup/collector.'
      )
      this.exitCode = 0
      return
    }

    for (const collector of collectors) {
      this.logger.log(
        this.colors.bold(
          `\n=== Collector #${collector.id} ${this.colors.dim(`(${collector.name})`)} ===`
        )
      )
      this.logger.log(
        `${this.colors.dim('URL:'.padEnd(10))}${collector.baseUrl ?? '(none)'}  ` +
          `${this.colors.dim('transport:')} ${collector.transport}  ` +
          `${this.colors.dim('interval:')} ${collector.pollIntervalSeconds}s  ` +
          `${this.colors.dim('apiKey:')} ${collector.apiKey ? this.colors.green('set') : this.colors.gray('unset')}`
      )

      // A socket collector pushes to the running server; this CLI process has
      // no session to it, and its HTTP API usually answers on loopback only.
      if (collector.transport === 'agent' || !collector.baseUrl) {
        this.logger.info(
          '  Socket collector: nothing to probe from here. Its last status: ' +
            (collector.lastStatus?.ok
              ? `ok at ${collector.lastStatus.checkedAt}`
              : (collector.lastStatus?.error ?? 'none yet'))
        )
        continue
      }

      const status = await probeCollector(collector.baseUrl, {
        apiKey: collector.apiKey,
      })
      if (!status.ok) {
        this.logger.error(
          `Probe failed: ${status.error ?? 'unknown error'} (after ${status.latencyMs ?? '?'} ms)`
        )
        continue
      }
      this.logger.log(
        `${this.colors.dim('Probe:'.padEnd(10))}${this.colors.green('ok')}  ` +
          `${this.colors.dim('latency:')} ${status.latencyMs ?? '?'}ms  ` +
          `${this.colors.dim('devices:')} ${status.totalDevices ?? '?'}  ` +
          `${this.colors.dim('iface:')} ${status.captureInterface ?? '?'}`
      )

      const devices = await this.fetchTopDevices(collector.baseUrl, collector.apiKey)
      if (devices.length === 0) {
        this.logger.warning('  (no devices reported)')
        continue
      }
      const table = this.ui.table()
      table.head(['MAC', 'IPs', 'bytes in', 'bytes out', '# WAN peers', '# LAN peers'])
      for (const d of devices.slice(0, this.top)) {
        table.row([
          d.mac,
          truncate((d.ips ?? []).join(', '), 32),
          fmtBytes(d.bytes_in),
          fmtBytes(d.bytes_out),
          String((d.top_peers ?? []).length),
          String((d.top_lan_peers ?? []).length),
        ])
      }
      table.render()
    }
  }

  /**
   * Fan-out to GET /api/v1/devices through the same fetcher conventions
   * as the poller (Accept, Bearer, abortable). Returns [] on failure so
   * the table just prints "no devices reported" instead of bubbling the
   * error up and aborting the whole inspection run.
   */
  private async fetchTopDevices(baseUrl: string, apiKey: string | null) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5000)
    try {
      const headers: Record<string, string> = { Accept: 'application/json' }
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`
      const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/v1/devices`, {
        headers,
        signal: controller.signal,
      })
      if (!res.ok) {
        this.logger.warning(`  /devices returned ${res.status}; skipping device table.`)
        return []
      }
      const body = (await res.json()) as {
        devices?: Array<{
          mac: string
          ips?: string[]
          bytes_in: number
          bytes_out: number
          top_peers?: unknown[]
          top_lan_peers?: unknown[]
        }>
      }
      return body.devices ?? []
    } catch (err) {
      this.logger.warning(`  /devices fetch failed: ${err instanceof Error ? err.message : err}`)
      return []
    } finally {
      clearTimeout(timer)
    }
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`
}

/**
 * Compact byte formatting. Same flavour as `du -h` so the output fits
 * comfortably in a terminal column.
 */
function fmtBytes(n: number | bigint | null | undefined): string {
  let v = typeof n === 'bigint' ? Number(n) : Number(n ?? 0)
  if (!Number.isFinite(v) || v < 0) return '0B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let unit = 0
  while (v >= 1024 && unit < units.length - 1) {
    v /= 1024
    unit++
  }
  return `${v.toFixed(unit === 0 ? 0 : 1)}${units[unit]}`
}
