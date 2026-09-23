import Collector from '#models/collector'
import { isLockContentionError } from '#services/db_errors'
import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import db from '@adonisjs/lucid/services/db'

/**
 * Every table that carries `collector_id … onDelete('CASCADE')`, densest
 * first. The cascade would do this on its own — in one transaction, on the
 * largest tables in the database, while the poller and the dashboard wait.
 * This command deletes the children itself, in batches, and leaves the
 * cascade as the safety net.
 */
const CHILD_TABLES = [
  'device_protocol_buckets',
  'device_traffic_buckets',
  'device_protocol_buckets_5m',
  'device_traffic_buckets_5m',
  'device_protocol_buckets_hourly',
  'device_traffic_buckets_hourly',
  'device_protocol_buckets_daily',
  'device_traffic_buckets_daily',
  'device_peer_buckets_hourly',
  'device_service_buckets',
  'device_service_buckets_5m',
  'device_service_buckets_hourly',
  'device_destination_buckets_hourly',
  'device_top_peers',
  'device_identities',
] as const

/**
 * Rows deleted per statement. Same batch size as
 * `app/services/bucket_retention.ts`, and for the same reason: each DELETE
 * stays short instead of holding one long lock.
 */
const BATCH_SIZE = 50_000

/**
 * A batch that loses a deadlock or a lock-wait race against the live poller
 * is retried rather than aborting a half-finished purge. Every batch is
 * idempotent (`DELETE … WHERE collector_id = ? LIMIT n`), so a retry — or a
 * re-run of the whole command after a crash — simply continues.
 */
const LOCK_RETRIES = 3
const LOCK_RETRY_BACKOFF_MS = 250

/** Upper bound on the grace period, however long the poll interval is. */
const MAX_GRACE_SECONDS = 60

/**
 * `node ace collectors:purge --id=N [--dry-run] [--grace=SECONDS]`
 *
 * The explicit, chunked counterpart to `DELETE /api/v1/settings/collectors/:id`,
 * which refuses once a collector owns data. This is destructive and
 * irreversible: it removes every bucket, peer, identity and rollup row that
 * collector recorded, then the collector itself. Disabling the collector
 * (`enabled = false`) stops polling and keeps all of it — prefer that unless
 * the history is genuinely unwanted.
 *
 * The command runs in its own process, so it cannot see the server's
 * in-flight poll set. Instead it disables the collector first (the
 * dispatcher's own filter is `enabled = true AND lifecycle = 'adopted'`) and
 * then waits out one poll interval, which bounds any cycle already in
 * progress — every collector HTTP call is capped at 5 s. Without that, a
 * poll landing mid-purge would write fresh rows behind the sweep.
 */
export default class PurgeCollector extends BaseCommand {
  static commandName = 'collectors:purge'
  static description =
    'Delete one collector and every row it recorded, in batches. --dry-run only counts.'

  static options: CommandOptions = { startApp: true }

  @flags.number({ description: 'Id of the collector to purge (required)' })
  declare id: number

  @flags.boolean({ description: 'Count rows that would be deleted without deleting' })
  declare dryRun: boolean

  @flags.number({
    description:
      'Seconds to wait after disabling the collector, so an in-flight poll finishes ' +
      'before the sweep starts. Defaults to the poll interval; 0 skips the wait.',
  })
  declare grace: number

  async run(): Promise<void> {
    if (this.id === undefined) {
      this.logger.error('Pass the collector to purge, e.g. `node ace collectors:purge --id=2`.')
      this.exitCode = 1
      return
    }

    const collector = await Collector.find(this.id)
    if (!collector) {
      this.logger.error(`No collector with id=${this.id}.`)
      this.exitCode = 1
      return
    }

    const dryRun = this.dryRun ?? false
    this.logger.info(
      `${dryRun ? 'Counting' : 'Purging'} history for collector #${collector.id} ` +
        `(${collector.name}, ${collector.baseUrl})`
    )

    if (!dryRun) {
      await this.quiesce(collector)
    }

    const table = this.ui.table()
    table.head(['table', dryRun ? 'would delete' : 'deleted'])

    let total = 0
    for (const child of CHILD_TABLES) {
      const affected = await this.purgeTable(child, collector.id, dryRun)
      total += affected
      table.row([child, String(affected)])
    }

    // Its node on the infrastructure view is layout, not history: the FK
    // (ON DELETE SET NULL) detaches it, with its ports, cables and position.
    const node = await db.from('infra_nodes').where('collector_id', collector.id).first()

    if (!dryRun) {
      await collector.delete()
    }
    table.row(['collectors', '1'])
    table.render()

    if (node) {
      this.logger.info(
        `Infrastructure view: node #${node.id} ${dryRun ? 'would be' : 'is'} detached, not ` +
          'deleted: it keeps its ports, cables and position (delete or re-bind it on the ' +
          'Infrastructure page).'
      )
    }

    if (dryRun) {
      this.logger.success(
        `Would delete ${total} history rows and collector #${collector.id}. Nothing was changed.`
      )
      return
    }
    this.logger.success(`Deleted ${total} history rows and collector #${collector.id}.`)
  }

  /**
   * Takes the collector out of service and gives any poll cycle that is
   * already running time to finish. Persisting `enabled = false` first also
   * means a crash mid-purge leaves the collector stopped rather than
   * re-filling the tables the next command run is about to clear.
   */
  private async quiesce(collector: Collector): Promise<void> {
    if (collector.enabled) {
      collector.enabled = false
      await collector.save()
      this.logger.info(`Disabled collector #${collector.id} so the poller stops writing.`)
    }

    const graceSeconds = Math.min(this.grace ?? collector.pollIntervalSeconds, MAX_GRACE_SECONDS)
    if (graceSeconds <= 0) return

    this.logger.info(`Waiting ${graceSeconds}s for an in-flight poll to finish…`)
    await new Promise((resolve) => setTimeout(resolve, graceSeconds * 1000))
  }

  /**
   * Counts (dry run) or deletes one child table's rows for this collector.
   * Terminates even if the driver ignores LIMIT on DELETE: the first pass
   * removes everything and the next returns 0.
   */
  private async purgeTable(table: string, collectorId: number, dryRun: boolean): Promise<number> {
    if (dryRun) {
      const rows = await db.from(table).where('collector_id', collectorId).count('* as total')
      const row = rows[0] as { total?: unknown } | undefined
      return Number(row?.total ?? 0)
    }

    let deleted = 0
    for (;;) {
      const n = await this.deleteBatch(table, collectorId)
      deleted += n
      if (n < BATCH_SIZE) break
    }
    return deleted
  }

  /**
   * One batch, retried on the two errors a concurrent writer can produce.
   * The statement is idempotent, so a retry can only ever delete rows the
   * previous attempt rolled back.
   */
  private async deleteBatch(table: string, collectorId: number): Promise<number> {
    for (let attempt = 1; ; attempt++) {
      try {
        const affected = await db
          .from(table)
          .where('collector_id', collectorId)
          .limit(BATCH_SIZE)
          .delete()
        return Number(Array.isArray(affected) ? affected[0] : affected) || 0
      } catch (err) {
        if (attempt >= LOCK_RETRIES || !isLockContentionError(err)) throw err
        this.logger.warning(
          `${table}: lock contention on batch ${attempt}/${LOCK_RETRIES}, retrying…`
        )
        await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_BACKOFF_MS * attempt))
      }
    }
  }
}
