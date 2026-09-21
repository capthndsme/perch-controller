import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Earlier versions of `asn_enrichment.ts` parsed the Team Cymru origin
 * TXT response (`"ASN | Prefix | CC | Registry | Allocated"`) and stored
 * `parts[4]` — the *allocation date* — into `asn_cache.org`. That meant
 * the dashboard's "Top ASNs" panel rendered organisation names like
 * `"1998-06-15"` instead of `"GOOGLE - Google LLC, US"`.
 *
 * The fix queries `AS<n>.asn.cymru.com` as a second hop to get the real
 * name, but rows already in the cache still carry the date strings. We
 * delete only the date-shaped rows here (rather than truncating the
 * whole cache) so legitimate `Unknown` / `Private / LAN` / valid name
 * rows aren't forced through DNS again on the next request.
 *
 * Pattern: any 10-character org with `-` at positions 5 and 8 — matches
 * `YYYY-MM-DD` and is portable across MySQL and SQLite (`_` matches a
 * single character in standard SQL `LIKE`). False-positive risk is
 * essentially nil because no real AS name is exactly 10 chars in that
 * shape, and even if one were, `enrichIp` would simply re-resolve it on
 * next access.
 */
export default class extends BaseSchema {
  async up() {
    await this.db.rawQuery("DELETE FROM asn_cache WHERE org LIKE '____-__-__'")
  }

  async down() {
    // Cache repopulation is automatic; nothing to restore.
  }
}
