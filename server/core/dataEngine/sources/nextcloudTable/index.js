/**
 * A DATATABLE THAT MIRRORS A NEXTCLOUD TABLE — the engine behind
 * `managed_kind = 'nextcloud_table'`.
 *
 * ── WHAT A MIRROR IS ────────────────────────────────────────────────
 * An ordinary datatable (a physical Postgres table in the scope schema, read
 * by routines, agents, App Studio, knowledge bases and the webpage bridge
 * exactly as any other) whose ROWS are a copy of a Nextcloud Tables table or
 * view, and whose COLUMNS are derived from Nextcloud's. It is a copy and not
 * a pass-through for one reason: there is no single place rows are read —
 * every consumer compiles its own SQL — and App Studio's relations are joins
 * inside one Postgres schema. A live proxy would have meant a second row
 * provider in nine places and no joins at all.
 *
 * The copy is kept near-live four ways, all landing in sync.js:
 *   • a push event from Nextcloud    (events.js, via /api/automation/events/nextcloud)
 *   • somebody opening the rows      (sync.kickStale — stale-while-serve)
 *   • a schedule                      (jobs/datatableNcSync.js)
 *   • "Refresh now"                  (POST /:id/nextcloud/refresh)
 *
 * Rows CHANGED in Bee Flow go to Nextcloud FIRST (writeThrough.js) and the
 * mirror row is then patched from what Nextcloud answered. Nextcloud is the
 * truth; the mirror never holds a row Nextcloud does not.
 *
 * ── WHO NEXTCLOUD SEES ──────────────────────────────────────────────
 * Every call — the refresh, the event patch, the write-through — runs as the
 * account that LINKED the table (`source.linkedByUserId`), impersonated
 * through the connector exactly as a scheduled routine is (linkerAuth.js).
 * Bee Flow's own grant ladder then decides who may see and change the copy.
 * One identity, one failure mode: when the linker can no longer reach the
 * table, the mirror goes stale and says so, and an owner re-links it.
 *
 * ── ROW IDENTITY ────────────────────────────────────────────────────
 * A mirror row's `id` IS Nextcloud's row id, as a string. That is what makes
 * a Nextcloud relation value (the target's row id) the target mirror's own
 * `id`, lets a push event address the row it is about, and lets a routine
 * hand the id straight to nextcloud_tables_update_row.
 *
 * LAYER: core/. Uses stores/, auth/, the compiler, and integrations/nextcloud*
 * (a platform integration, not a feature — layering.test.js allows it).
 */

'use strict';

const KIND = 'nextcloud_table';

/** Is this datatable row a Nextcloud mirror? */
function isMirror(table) {
    return !!table && table.managedKind === KIND;
}

module.exports = { KIND, isMirror };
