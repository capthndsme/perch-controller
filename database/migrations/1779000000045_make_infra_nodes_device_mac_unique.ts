import { BaseSchema } from '@adonisjs/lucid/schema'
import type { QueryClientContract } from '@adonisjs/lucid/types/database'

/**
 * One node per device (docs/infrastructure-view.md, amendment A4 item 2): the
 * plain index on `infra_nodes.device_mac` becomes a unique one (MariaDB allows
 * any number of NULLs in it, which is every node that carries no device). The
 * service refuses a second node for a MAC with a clear error first
 * (`infra_device_already_placed`); this index is the backstop.
 *
 * The container's entrypoint loops on `migration:run`, so this must not fail
 * on any real database:
 *
 * - Existing duplicates are cleared first: per MAC the lowest node id keeps
 *   it, every other node's `device_mac` becomes NULL (the node itself, its
 *   ports and cables stay). Duplicates are grouped by the column's own
 *   collation, so "the same MAC" means exactly what the unique index will
 *   mean (case-insensitive).
 * - The index swap is one `ALTER TABLE` built from the indexes that exist, so
 *   a rerun after any partial state (or on a table someone touched by hand)
 *   finishes the job instead of failing on a missing or present index.
 *
 * `down()` puts the plain index back; MACs cleared as duplicates stay cleared.
 */
const TABLE = 'infra_nodes'
const PLAIN_INDEX = 'infra_nodes_device_mac_idx'
const UNIQUE_INDEX = 'infra_nodes_device_mac_unique_idx'

function rows<T>(result: unknown): T[] {
  return ((Array.isArray(result) ? result[0] : result) ?? []) as T[]
}

async function indexNames(db: QueryClientContract): Promise<Set<string>> {
  const found = rows<{ name: string }>(
    await db.rawQuery(
      `SELECT DISTINCT INDEX_NAME AS name FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
      [TABLE]
    )
  )
  return new Set(found.map((row) => row.name))
}

/** Every node but the lowest-id one of each MAC that more than one node carries. */
async function duplicateHolders(db: QueryClientContract): Promise<number[]> {
  const found = rows<{ id: number }>(
    await db.rawQuery(
      `SELECT n.id AS id
         FROM ${TABLE} n
         INNER JOIN (
           SELECT device_mac, MIN(id) AS keep_id
             FROM ${TABLE}
            WHERE device_mac IS NOT NULL
            GROUP BY device_mac
           HAVING COUNT(*) > 1
         ) d ON d.device_mac = n.device_mac
        WHERE n.id <> d.keep_id`
    )
  )
  return found.map((row) => Number(row.id))
}

export default class extends BaseSchema {
  async up() {
    this.defer(async (db) => {
      const duplicates = await duplicateHolders(db)
      if (duplicates.length > 0) {
        await db.rawQuery(
          `UPDATE ${TABLE} SET device_mac = NULL, updated_at = UTC_TIMESTAMP()
            WHERE id IN (${duplicates.map(() => '?').join(', ')})`,
          duplicates
        )
      }

      const indexes = await indexNames(db)
      const changes: string[] = []
      if (!indexes.has(UNIQUE_INDEX)) changes.push(`ADD UNIQUE INDEX ${UNIQUE_INDEX} (device_mac)`)
      if (indexes.has(PLAIN_INDEX)) changes.push(`DROP INDEX ${PLAIN_INDEX}`)
      if (changes.length > 0) await db.rawQuery(`ALTER TABLE ${TABLE} ${changes.join(', ')}`)
    })
  }

  async down() {
    this.defer(async (db) => {
      const indexes = await indexNames(db)
      const changes: string[] = []
      if (!indexes.has(PLAIN_INDEX)) changes.push(`ADD INDEX ${PLAIN_INDEX} (device_mac)`)
      if (indexes.has(UNIQUE_INDEX)) changes.push(`DROP INDEX ${UNIQUE_INDEX}`)
      if (changes.length > 0) await db.rawQuery(`ALTER TABLE ${TABLE} ${changes.join(', ')}`)
    })
  }
}
