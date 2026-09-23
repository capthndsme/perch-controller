import Collector from '#models/collector'
import {
  AUTO_REPLACE_MAX_OVERLAP_SECONDS,
  CollectorMergeError,
  describeDuration,
  describeInfraNodeMove,
  executeCollectorMerge,
  MERGE_OVERLAP_POLICIES,
  planCollectorMerge,
  type CollectorMergePlan,
  type CollectorMergeResult,
  type CollisionRule,
  type MergeOverlapPolicy,
  type MergeSide,
} from '#services/collector_merge'
import { isLockContentionError } from '#services/db_errors'
import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import db from '@adonisjs/lucid/services/db'
import type { DateTime } from 'luxon'

/** Whole-transaction retries after losing a deadlock to the live poller or maintainer. */
const LOCK_RETRIES = 3
const LOCK_RETRY_BACKOFF_MS = 500

/**
 * Default wait after disabling both collectors. One poll cycle can run past
 * the 5 s tick (a 5 s fetch, a protocols fetch, then the writes), so the
 * default is the longer poll interval but never under 15 s; 60 s at most.
 */
const MIN_DEFAULT_GRACE_SECONDS = 15
const MAX_GRACE_SECONDS = 60

/** Signals held back while the collectors are disabled and the merge runs. */
const DEFERRED_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP']

/**
 * `node ace collectors:merge --from=OLD --into=NEW [--dry-run] [--overlap=replace|into|sum] [--grace=S]`
 *
 * Folds the history of collector OLD into collector NEW and removes OLD, so
 * a replaced capture box and its successor read as one continuous history.
 * The rules live in `app/services/collector_merge.ts`; this command prints
 * the plan, takes both collectors out of service, runs the merge in one
 * transaction and puts the result back in service.
 *
 * Like `collectors:purge`, it runs in its own process and cannot see the
 * server's in-flight polls, so it disables both collectors first and waits
 * out a poll cycle. The merged collector ends up enabled exactly when NEW
 * was. If the merge fails, it is rolled back and both flags are restored; a
 * first Ctrl-C or SIGTERM waits for that instead of leaving both disabled.
 */
export default class MergeCollectors extends BaseCommand {
  static commandName = 'collectors:merge'
  static description =
    "Fold one collector's history into another (hardware replacement) and remove it. --dry-run only plans."

  static options: CommandOptions = { startApp: true }

  @flags.number({
    description: 'Collector whose history moves; it is removed afterwards (required)',
  })
  declare from: number

  @flags.number({
    description:
      'Collector that carries on: the result keeps its name, address, key and instance id (required)',
  })
  declare into: number

  @flags.string({
    description:
      'Slots both collectors recorded: replace (hand-over, the default up to a 15 min overlap), ' +
      'into (same traffic, target wins) or sum (different traffic, added)',
  })
  declare overlap: string

  @flags.boolean({ description: 'Print the plan without changing anything' })
  declare dryRun: boolean

  @flags.number({
    description:
      'Seconds to wait after disabling both collectors, so an in-flight poll finishes first. ' +
      'Defaults to the longer poll interval, at least 15; 0 skips the wait.',
  })
  declare grace: number

  async run(): Promise<void> {
    if (this.from === undefined || this.into === undefined) {
      this.logger.error(
        'Pass both collectors, e.g. `node ace collectors:merge --from=1 --into=5 --dry-run`.'
      )
      this.exitCode = 1
      return
    }
    if (this.overlap !== undefined && !isPolicy(this.overlap)) {
      this.logger.error(`--overlap must be one of ${MERGE_OVERLAP_POLICIES.join(', ')}.`)
      this.exitCode = 1
      return
    }

    let plan: CollectorMergePlan
    try {
      plan = await planCollectorMerge({
        fromId: this.from,
        intoId: this.into,
        overlap: this.overlap as MergeOverlapPolicy | undefined,
      })
    } catch (err) {
      if (!(err instanceof CollectorMergeError)) throw err
      this.logger.error(err.message)
      this.exitCode = 1
      return
    }

    this.printPlan(plan)
    if (plan.refusals.length > 0) {
      for (const refusal of plan.refusals) this.logger.error(refusal)
      this.exitCode = 1
      return
    }
    if (this.dryRun) {
      this.logger.success('Dry run: nothing was changed.')
      return
    }

    const releaseSignals = this.holdSignals(plan)
    let result: CollectorMergeResult | null = null
    let failure: unknown = null
    try {
      await this.quiesce(plan)
      result = await this.executeWithRetries(plan)
    } catch (err) {
      failure = err
      await this.restoreFlags(plan)
    } finally {
      releaseSignals()
    }
    if (failure || !result) {
      if (!(failure instanceof CollectorMergeError)) throw failure
      this.logger.error(`${failure.message} The merge was rolled back.`)
      this.exitCode = 1
      return
    }
    this.printResult(plan, result)
  }

  /**
   * From the moment both collectors are disabled until the merge has
   * committed, or rolled back and re-enabled them, an interrupt would leave
   * the live collector switched off. The first signal is therefore held until
   * that point; a second one exits at once and says what to re-enable.
   */
  private holdSignals(plan: CollectorMergePlan): () => void {
    let received = 0
    const onSignal = (signal: NodeJS.Signals) => {
      received++
      if (received === 1) {
        this.logger.warning(
          `${signal}: finishing the merge (or rolling it back and re-enabling both collectors) ` +
            'before exiting. Send it again to exit now.'
        )
        return
      }
      this.logger.error(
        `${signal}: exiting now. The transaction rolls back, but #${plan.from.id} and ` +
          `#${plan.into.id} may stay disabled: re-enable them under Settings → Collectors.`
      )
      process.exit(130)
    }
    for (const signal of DEFERRED_SIGNALS) process.on(signal, onSignal)
    return () => {
      for (const signal of DEFERRED_SIGNALS) process.off(signal, onSignal)
    }
  }

  private printPlan(plan: CollectorMergePlan) {
    const { from, into } = plan
    this.logger.info(`Merging the history of ${label(from)} into ${label(into)}.`)
    this.logger.info(`  ${describeSide(from)}`)
    this.logger.info(`  ${describeSide(into)}`)

    if (!plan.overlap) {
      this.logger.info('  Overlap: none (one of them has no traffic history).')
    } else if (plan.overlap.seconds <= 0) {
      this.logger.info(
        `  Overlap: none, ${describeDuration(-plan.overlap.seconds)} between the old one's last ` +
          `and the new one's first bucket.`
      )
    } else {
      this.logger.info(
        `  Overlap: ${describeDuration(plan.overlap.seconds)}, ` +
          `${stamp(plan.overlap.start)} to ${stamp(plan.overlap.end)} UTC.`
      )
    }
    if (plan.policy) {
      const why =
        plan.policySource === 'explicit'
          ? 'as asked'
          : `automatic, the overlap is at most ${AUTO_REPLACE_MAX_OVERLAP_SECONDS / 60} min`
      this.logger.info(`  Overlap rule: ${plan.policy} (${why}).`)
    }

    const survivor = plan.survivorId === from.id ? from : into
    const removed = plan.survivorId === from.id ? into : from
    if (survivor.id === into.id) {
      this.logger.info(
        `  Result: #${into.id} keeps its row and identity; ${fmt(removed.rows)} rows of ` +
          `#${removed.id} move onto it and #${removed.id} is deleted.`
      )
    } else {
      this.logger.info(
        `  Result: row #${survivor.id} stays in place (it has more rows) and takes over ` +
          `#${into.id}'s identity (name, address, key, instance id); ${fmt(removed.rows)} rows of ` +
          `#${removed.id} move onto it and row #${removed.id} is deleted. The merged collector ` +
          `is #${survivor.id} from now on.`
      )
    }

    const table = this.ui.table()
    table.head(['table', 'rows moving', 'collisions', 'on collision'])
    for (const t of plan.tables) {
      table.row([
        t.table,
        fmt(t.moving),
        fmt(t.collisions),
        t.rule ? ruleLabel(t.rule, t.role) : 'needs --overlap',
      ])
    }
    table.render()

    for (const w of plan.rebuilds) {
      this.logger.info(
        `  Rebuilt afterwards: ${w.spec} ${stamp(w.since)} to ${stamp(w.until)} UTC.`
      )
    }
    const infra = describeInfraNodeMove(plan.infraNodes, plan)
    if (infra) this.logger.info(`  ${infra}`)
    for (const warning of plan.warnings) this.logger.warning(warning)
  }

  /**
   * Same approach as `collectors:purge`: persist `enabled = false` on both
   * (the dispatcher polls only enabled, adopted rows), then wait so a cycle
   * already in flight finishes. Every collector HTTP call is capped at 5 s.
   */
  private async quiesce(plan: CollectorMergePlan) {
    const rows = await Collector.query().whereIn('id', [plan.from.id, plan.into.id])
    for (const collector of rows) {
      if (!collector.enabled) continue
      collector.enabled = false
      await collector.save()
    }
    this.logger.info(`Disabled #${plan.from.id} and #${plan.into.id} so the poller stops writing.`)

    const longest = Math.max(MIN_DEFAULT_GRACE_SECONDS, ...rows.map((c) => c.pollIntervalSeconds))
    const graceSeconds = Math.min(this.grace ?? longest, MAX_GRACE_SECONDS)
    if (graceSeconds <= 0) return
    this.logger.info(`Waiting ${graceSeconds}s for an in-flight poll to finish…`)
    await new Promise((resolve) => setTimeout(resolve, graceSeconds * 1000))
  }

  private async executeWithRetries(plan: CollectorMergePlan): Promise<CollectorMergeResult> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await db.transaction((trx) => executeCollectorMerge(plan, trx))
      } catch (err) {
        if (attempt >= LOCK_RETRIES || !isLockContentionError(err)) throw err
        this.logger.warning(`Lock contention on attempt ${attempt}/${LOCK_RETRIES}, retrying…`)
        await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_BACKOFF_MS * attempt))
      }
    }
  }

  /** After a rolled-back merge, both collectors go back to how they were. */
  private async restoreFlags(plan: CollectorMergePlan) {
    for (const side of [plan.from, plan.into]) {
      const collector = await Collector.find(side.id)
      if (collector && Boolean(collector.enabled) !== side.enabled) {
        collector.enabled = side.enabled
        await collector.save()
      }
    }
  }

  private printResult(plan: CollectorMergePlan, result: CollectorMergeResult) {
    const table = this.ui.table()
    table.head(['table', 'moved', 'folded into an existing row'])
    for (const t of result.tables) table.row([t.table, fmt(t.moved), fmt(t.collisions)])
    table.render()
    for (const r of result.rebuilds) {
      this.logger.info(`Rebuilt ${r.name} ${r.since} to ${r.until} UTC (${fmt(r.affected)} rows).`)
    }
    const infra = describeInfraNodeMove(result.infraNodes, result)
    if (infra) this.logger.info(infra)
    const c = result.collector
    this.logger.success(
      `Merged. Collector #${c.id} "${c.name}" (${c.baseUrl}) now holds the history of both ` +
        `and is ${c.enabled ? 'enabled' : 'disabled'}; #${result.removedId} is gone.`
    )
    if (!c.enabled && !plan.into.enabled) {
      this.logger.info('It was disabled before the merge, so it stays disabled.')
    }
  }
}

function isPolicy(value: string): value is MergeOverlapPolicy {
  return (MERGE_OVERLAP_POLICIES as readonly string[]).includes(value)
}

function label(side: MergeSide): string {
  return `#${side.id} "${side.name}"`
}

function describeSide(side: MergeSide): string {
  const span = side.activity
    ? `traffic ${stamp(side.activity.first)} to ${stamp(side.activity.last)} UTC`
    : 'no traffic history'
  return (
    `#${side.id} ${side.name}, ${side.baseUrl}, ${side.source}/${side.lifecycle}` +
    `${side.enabled ? '' : ' (disabled)'}: ${fmt(side.rows)} rows, ${span}`
  )
}

function ruleLabel(rule: CollisionRule, role: string | null): string {
  if (rule === 'identity') return 'merged: first/last seen, newest addresses'
  const base = rule === 'into' ? 'target wins' : 'added'
  return role === 'rollup' ? `${base}, then rebuilt where the tier below has rows` : base
}

function stamp(ts: DateTime): string {
  return ts.toUTC().toFormat('yyyy-MM-dd HH:mm:ss')
}

function fmt(n: number): string {
  return n.toLocaleString('en-US')
}
