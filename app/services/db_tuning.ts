import env from '#start/env'
import db from '@adonisjs/lucid/services/db'
import logger from '@adonisjs/core/services/logger'

/**
 * Runtime MariaDB tuning. The two InnoDB settings that dominate this
 * workload — a buffer pool large enough to hold the working set, and not
 * fsyncing the redo log on every one of the poller's small transactions —
 * are both dynamic, so the app can apply them with SET GLOBAL when the DB
 * user has the privilege (root does; a least-privilege user will simply
 * log a warning). This makes the tuning survive a MariaDB restart on a
 * host without passwordless sudo; the durable answer is still the config
 * snippet in `docs/ops/mariadb-perch.cnf`.
 *
 * Each knob is off when its env var is unset or 0.
 */
export type DbTuningResult = {
  bufferPool?: { before: number; after: number; changed: boolean }
  flushLogAtTrxCommit?: { before: number; after: number; changed: boolean }
}

async function globalNumber(name: string): Promise<number> {
  const res = await db.rawQuery(`SELECT @@global.${name} AS v`)
  const rows = (Array.isArray(res) ? res[0] : res) as Array<{ v: number | string }>
  return Number(rows?.[0]?.v ?? 0)
}

export async function applyDatabaseTuning(): Promise<DbTuningResult> {
  const result: DbTuningResult = {}

  const bufferPoolTarget = Math.floor(Number(env.get('DB_TUNE_BUFFER_POOL_BYTES', 0)))
  if (bufferPoolTarget > 0) {
    const before = await globalNumber('innodb_buffer_pool_size')
    let after = before
    if (before < bufferPoolTarget) {
      try {
        // Integer is validated above; SET GLOBAL does not accept placeholders.
        await db.rawQuery(`SET GLOBAL innodb_buffer_pool_size = ${bufferPoolTarget}`)
        after = await globalNumber('innodb_buffer_pool_size')
        if (after > before) {
          logger.info(
            { before, after, target: bufferPoolTarget },
            'db_tuning: resized innodb_buffer_pool_size'
          )
        } else {
          // MariaDB ≥ 11.7 clamps runtime growth at innodb_buffer_pool_size_max
          // (= the startup size unless configured): needs the cnf + restart.
          logger.warn(
            { before, target: bufferPoolTarget },
            'db_tuning: innodb_buffer_pool_size unchanged — capped by innodb_buffer_pool_size_max; install docs/ops/mariadb-perch.cnf and restart MariaDB'
          )
        }
      } catch (err) {
        logger.warn(
          { err, target: bufferPoolTarget },
          'db_tuning: could not resize innodb_buffer_pool_size (missing SUPER privilege?)'
        )
      }
    }
    result.bufferPool = { before, after, changed: after !== before }
  }

  const flushTarget = Number(env.get('DB_TUNE_FLUSH_LOG_AT_TRX_COMMIT', -1))
  if (flushTarget === 0 || flushTarget === 1 || flushTarget === 2) {
    const before = await globalNumber('innodb_flush_log_at_trx_commit')
    let after = before
    if (before !== flushTarget) {
      try {
        await db.rawQuery(`SET GLOBAL innodb_flush_log_at_trx_commit = ${flushTarget}`)
        after = await globalNumber('innodb_flush_log_at_trx_commit')
        logger.info({ before, after }, 'db_tuning: set innodb_flush_log_at_trx_commit')
      } catch (err) {
        logger.warn({ err }, 'db_tuning: could not set innodb_flush_log_at_trx_commit')
      }
    }
    result.flushLogAtTrxCommit = { before, after, changed: after !== before }
  }

  return result
}
