// @typecheck
'use strict';

/**
 * The managed-part guard of the datatable store (Solution stages, design 5.3),
 * split out of datatables.js so that file stays under the line limit. Every
 * function here runs on the caller's transaction client `c`.
 */

const crypto = require('node:crypto');
const { parseJSONObject } = require('../lib/json');
const managedParts = require('../lib/managedParts');
// ── The managed-part guard (Solution stages, design 5.3) ────────────────
//
// A table whose `project_id` is a UAT or PRD stage project is MANAGED: its
// columns, key and existence come from a release, and only a deploy (the
// capability `managedWrite = { deploymentId }` of an active deployment of that
// stage) may change them. Grants, sharing, the lawful basis, retention and the
// subject column stay the stage's own (managedParts.ALLOWED.datatable).
//
// The stage is read with SQL on the write's own transaction, joined from the
// table row, so the check and the write see one snapshot. A database whose
// `projects` table has no `stage_of` column yet cannot hold a stage at all;
// the probe for it is a catalogue read that cannot fail (a failing statement
// would abort the caller's transaction), memoised once it answers yes.

/** JSON with sorted keys and no undefined members: equal descriptors, equal text. */
function stableStringify(v) {
    if (v && typeof v === 'object' && typeof v.toJSON === 'function') return stableStringify(v.toJSON());
    if (v === undefined || typeof v === 'function') return 'null';
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
    const keys = Object.keys(v).filter(k => v[k] !== undefined && typeof v[k] !== 'function').sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
}

/**
 * The fingerprint of ONE table descriptor (a model entry): sha256 of its stable
 * stringify. A capture token holds it instead of the org-wide model_version,
 * so an edit to an unrelated table in the same scope does not race a capture.
 *
 * @param {object|null|undefined} descriptor
 * @returns {string} hex sha256
 */
function tableFingerprint(descriptor) {
    return crypto.createHash('sha256').update(stableStringify(descriptor ?? null)).digest('hex');
}

let stageColumnsSeen = false;
/** Does `projects.stage_of` exist here? Memoised once true (columns are never dropped). */
async function stageColumnsPresent(c) {
    if (stageColumnsSeen) return true;
    const r = await c.query(
        `SELECT 1 AS ok FROM pg_attribute
          WHERE attrelid = to_regclass('projects') AND attname = 'stage_of' AND NOT attisdropped`,
    );
    stageColumnsSeen = (r.rows || []).length > 0;
    return stageColumnsSeen;
}

/** The tables among `ids` that belong to a stage project: [{id, project_id, stage, stage_of}]. */
async function stageTablesAmong(c, ids) {
    if (!ids.length || !await stageColumnsPresent(c)) return [];
    const r = await c.query(
        `SELECT d.id, d.project_id, p.stage, p.stage_of
           FROM datatables d JOIN projects p ON p.id = d.project_id
          WHERE d.id = ANY($1::text[]) AND p.stage_of IS NOT NULL`,
        [ids],
    );
    return r.rows || [];
}

/** The stage `projectId` is, or null: {project_id, stage, stage_of}. */
async function stageProject(c, projectId) {
    if (typeof projectId !== 'string' || !projectId || !await stageColumnsPresent(c)) return null;
    const r = await c.query(
        `SELECT id AS project_id, stage, stage_of FROM projects WHERE id = $1 AND stage_of IS NOT NULL`,
        [projectId],
    );
    return (r.rows || [])[0] || null;
}

/**
 * Refuse (409 managed_part) unless `managedWrite` is the capability of an
 * active deployment of EVERY stage project among `hits`.
 */
async function requireCapability(c, hits, managedWrite) {
    const seen = new Set();
    for (const h of hits) {
        if (!h || seen.has(h.project_id)) continue;
        seen.add(h.project_id);
        if (await managedParts.hasCapability({ managedWrite, projectId: h.project_id, client: c })) continue;
        throw managedParts.managedPartError({ solutionId: h.stage_of, stage: h.stage });
    }
}

/**
 * The ids of the table entries `next` changes, adds or removes relative to
 * `before`, compared by stable stringify (key order and undefined members are
 * not a change).
 */
function changedTableIds(before, next) {
    const index = (m) => {
        const out = new Map();
        for (const t of (Array.isArray(m?.tables) ? m.tables : [])) {
            if (t && typeof t.id === 'string') out.set(t.id, stableStringify(t));
        }
        return out;
    };
    const a = index(before);
    const b = index(next);
    const ids = [];
    for (const [id, text] of a) if (b.get(id) !== text) ids.push(id);
    for (const id of b.keys()) if (!a.has(id)) ids.push(id);
    return ids;
}
/** The entry of table `id` in model `m`, or undefined. */
function entryOf(m, id) {
    return (Array.isArray(m?.tables) ? m.tables : []).find(t => t && t.id === id);
}

/**
 * The ids among `ids` that a mirror schema reconcile may change without a
 * capability: the table is a source mirror (`source IS NOT NULL`), it exists
 * on both sides, and the entries differ only in `fields` (plus a `name` that
 * now equals the table row's own name, which reconcile copies over). Anything
 * else the save touches on a stage table still needs the deploy's capability.
 *
 * @param {object} c  the transaction client
 * @param {object} before  the model read under the lock
 * @param {object} next    the model being saved
 * @param {string[]} ids   the changed table ids
 * @returns {Promise<Set<string>>}
 */
async function mirrorReconcileExemptIds(c, before, next, ids) {
    const out = new Set();
    if (!ids.length) return out;
    const r = await c.query(
        `SELECT id, name FROM datatables WHERE id = ANY($1::text[]) AND source IS NOT NULL`,
        [ids],
    );
    for (const row of r.rows || []) {
        const a = entryOf(before, row.id);
        const b = entryOf(next, row.id);
        if (!a || !b) continue;
        const strip = (t) => {
            const { fields: _fields, ...rest } = t;
            if (b.name === row.name) delete rest.name;
            return stableStringify(rest);
        };
        if (strip(a) === strip(b)) out.add(row.id);
    }
    return out;
}

/**
 * Keep a stage table's `rowsLocked` model key in step with its `is_reference`
 * mark: set it when `on`, delete it when not, and bump `model_version` so the
 * compiler re-reads the table. `locked` is the `datatable_models` row result
 * the caller already holds FOR UPDATE in the same transaction; a scope without
 * a model row, or a model without the entry, is left as it is.
 *
 * @param {object} c
 * @param {{kind: string, id: string}} scope
 * @param {{rows: object[]}} locked
 * @param {string} tableId
 * @param {boolean} on
 */
async function writeRowsLocked(c, scope, locked, tableId, on) {
    if (!locked.rows.length) return;
    const model = parseJSONObject(locked.rows[0].model, { modelVersion: 1, tables: [] });
    const t = entryOf(model, tableId);
    if (!t || !!t.rowsLocked === on) return;
    if (on) t.rowsLocked = true;
    else delete t.rowsLocked;
    await c.query(
        `UPDATE datatable_models
            SET model = $1::jsonb, model_version = model_version + 1, updated_at = NOW()
          WHERE scope_kind = $2 AND scope_id = $3`,
        [JSON.stringify(model), scope.kind, scope.id],
    );
}

module.exports = {
    stableStringify,
    tableFingerprint,
    stageTablesAmong,
    stageProject,
    requireCapability,
    changedTableIds,
    mirrorReconcileExemptIds,
    writeRowsLocked,
};
