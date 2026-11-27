// @typecheck strict
/**
 * "What breaks if I delete this knowledge base?"
 *
 * ── WHY IT IS A SCAN AND NOT A JOIN TABLE ───────────────────────────
 * Every consumer stores its knowledge-base ids INSIDE its own document: an
 * agent in `config.knowledge_base_ids`, an automation somewhere inside
 * `definition_json`, an app inside its screen definition. There is no join
 * table to query, and adding one would mean a write path in nine places that
 * all have to stay in step with the documents they mirror — the copy that
 * falls behind is the one that answers "nothing depends on this" about a
 * knowledge base three agents are using.
 *
 * So this reads the documents themselves. It is a handful of indexed-ish
 * queries run when somebody opens a tab or presses delete, not on a hot path.
 *
 * ── A CONSUMER TABLE THAT IS NOT THERE IS NOT "NO USAGE" ────────────
 * Not every deployment has every feature. A missing table must make the query
 * return NOTHING for that kind and say so in `partial`, never zero — because
 * zero is what the delete dialog reads as "safe to remove", and "the apps
 * table does not exist on this install" is not the same statement as "no app
 * uses this".
 *
 * ── A MODULE THAT IS NOT HERE IS LEFT OUT ───────────────────────────
 * The scans of a kind whose tables a first-party module creates are that
 * module's part (core/kb/usage/<module>.js), asked for by name at the point
 * of use. A module that is not part of this installation leaves its kinds out
 * of the answer: no row, no count, not partial. The scrub reaches a module's
 * rows as a data duty (modules/firstParty/moduleData.js, `warn`): also when
 * this edition leaves the module out but the database holds its tables.
 *
 * ── THE ROWS ARE THE Used-by CONTRACT ───────────────────────────────
 * `{ kind, id, title, role, ownerId, lastAt }` — the shape
 * `shared/UsedByTab.jsx` renders and `shared/DangerZone.jsx` counts, so the
 * tab, the delete confirmation and the overview pills cannot disagree about
 * what depends on what.
 */

const { pool } = require('../../db');
const log = require('../../telemetry/log');
const { optionalFeatureModule } = require('../featureModules');
const { moduleForDataDuty } = require('../../modules/firstParty/moduleData');

/**
 * @typedef {{ table: string, sql: string, params: (kbId: string) => string[], role: string }} KbScan
 * @typedef {{ table: string, column: string }} ArrayScrub
 * @typedef {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[], rowCount?: number | null }> }} KbUsageDb
 */

/**
 * One query per consumer kind the core owns. Each returns `{ rows }` or throws;
 * a throw is caught by the caller and recorded as a partial answer rather than
 * as zero.
 *
 * Every one of these filters on the KB id in SQL rather than reading every row
 * and filtering in Node: an org with 4000 automations is not unusual and the
 * delete dialog must not become a table scan the person waits on.
 * @type {Readonly<Record<string, KbScan>>}
 */
const CORE_SCANS = Object.freeze({
    agent: {
        table: 'agents',
        // One agent whose config holds '' must not make the whole scan
        // unanswerable: it reads as NULL (no knowledge bases). Through ::text,
        // because the column is TEXT on some installs and jsonb on others.
        sql: `SELECT id, name AS title, owner_id, updated_at AS last_at
                FROM agents
               WHERE (NULLIF(config::text, '')::jsonb -> 'knowledge_base_ids') @> $1::jsonb`,
        params: (kbId) => [JSON.stringify([kbId])],
        role: 'chat',
    },
    project: {
        table: 'projects',
        sql: `SELECT id, name AS title, owner_id, updated_at AS last_at
                FROM projects WHERE knowledge_base_ids @> $1::jsonb`,
        params: (kbId) => [JSON.stringify([kbId])],
        role: 'contains',
    },
    notebook: {
        table: 'notebooks',
        sql: `SELECT id, name AS title, user_id AS owner_id, updated_at AS last_at
                FROM notebooks WHERE knowledge_base_ids @> $1::jsonb`,
        params: (kbId) => [JSON.stringify([kbId])],
        role: 'contains',
    },
});

/** @type {Readonly<Record<string, ArrayScrub>>} */
const CORE_ARRAY_SCRUBS = Object.freeze({
    project: { table: 'projects', column: 'knowledge_base_ids' },
    notebook: { table: 'notebooks', column: 'knowledge_base_ids' },
});

/**
 * Every kind this can find, in the order the Used-by tab lists them: a kind of the core, or the
 * module part that declares it and the module that owns that part.
 */
const SOURCES = /** @type {const} */ ([
    { kind: 'agent', part: null, moduleId: null },
    { kind: 'automation', part: 'core/kb/usage/automation', moduleId: 'automation' },
    { kind: 'app', part: 'core/kb/usage/apps', moduleId: 'apps' },
    { kind: 'webpage', part: 'core/kb/usage/webpages', moduleId: 'webpages' },
    { kind: 'project', part: null, moduleId: null },
    { kind: 'notebook', part: null, moduleId: null },
    { kind: 'template', part: 'core/kb/usage/templates', moduleId: 'templates' },
    { kind: 'support', part: 'core/kb/usage/support', moduleId: 'support' },
]);

/**
 * The scans of this installation, in Used-by order.
 * @returns {Array<[string, KbScan]>}
 */
function scansHere() {
    /** @type {Array<[string, KbScan]>} */
    const out = [];
    for (const { kind, part } of SOURCES) {
        const scan = part ? optionalFeatureModule(part)?.SCANS[kind] : CORE_SCANS[kind];
        if (scan) out.push([kind, scan]);
    }
    return out;
}

/**
 * @param {string} name
 * @param {KbUsageDb} [client]
 */
async function tableExists(name, client) {
    try {
        const r = await (client || pool).query('SELECT to_regclass($1) AS t', [name]);
        return !!r.rows[0]?.t;
    } catch (_) {
        return false;
    }
}

/**
 * Who uses this knowledge base?
 *
 * @param {string} kbId
 * @param {{ db?: KbUsageDb }} [opts]  `db` is an injection seam for the tests
 * @returns {Promise<{ rows: Array<{ kind: string, id: string, title: string | null, role: string, ownerId: string | null, lastAt: Date | string | null }>, partial: string[] }>}
 *          `partial` names the kinds that could NOT be answered — a table that
 *          is absent, or a query that failed. A caller must treat a non-empty
 *          `partial` as "I do not know", never as "nothing".
 */
async function usageForKb(kbId, { db = pool } = {}) {
    if (!kbId) return { rows: [], partial: [] };
    const rows = [];
    const partial = [];

    for (const [kind, scan] of scansHere()) {
        try {
            if (!(await tableExists(scan.table, db))) {
                // Absent because the feature is not installed — not an error,
                // and not usage either. Silent here; `partial` carries it.
                partial.push(kind);
                continue;
            }
            const r = await db.query(scan.sql, scan.params(kbId));
            for (const row of r.rows || []) {
                rows.push({
                    kind,
                    id: row.id,
                    title: row.title || null,
                    role: row.row_role || scan.role,
                    ownerId: row.owner_id || null,
                    lastAt: row.last_at || null,
                });
            }
        } catch (e) {
            log.warn(`[KBUsage] ${kind} scan failed for ${kbId}:`, /** @type {Error} */ (e).message);
            partial.push(kind);
        }
    }

    return { rows, partial };
}

/**
 * Counts per kind for a set of knowledge bases, for the overview's pills.
 *
 * One pass per kind over all the ids rather than `usageForKb` in a loop: the
 * overview asks about every base on the screen at once, and the loop would be
 * eight queries times however many bases there are.
 * @param {string[]} kbIds
 * @param {{ db?: KbUsageDb }} [opts]
 */
async function usageSummary(kbIds, { db = pool } = {}) {
    const ids = Array.isArray(kbIds) ? kbIds.filter(Boolean) : [];
    /** @type {Record<string, { counts: Record<string, number>, partial: string[] }>} */
    const out = {};
    for (const id of ids) out[id] = { counts: {}, partial: [] };
    if (ids.length === 0) return out;

    for (const [kind, scan] of scansHere()) {
        const present = await tableExists(scan.table, db);
        for (const id of ids) {
            if (!present) { out[id].partial.push(kind); continue; }
            try {
                const r = await db.query(scan.sql, scan.params(id));
                const n = (r.rows || []).length;
                if (n > 0) out[id].counts[kind] = n;
            } catch (e) {
                log.warn(`[KBUsage] ${kind} summary failed for ${id}:`, /** @type {Error} */ (e).message);
                out[id].partial.push(kind);
            }
        }
    }
    return out;
}

/**
 * The module parts the scrub reaches, by kind: a part that only reads (automations, apps) when
 * its module is here; a part that is scrubbed as a data duty, also when this edition leaves its
 * module out and the database holds its tables (null: nothing of it to reach).
 * @returns {Promise<Map<string, { ARRAY_SCRUB?: ArrayScrub, scrubIngestTarget?: (kbId: string, db: KbUsageDb) => Promise<number> }>>}
 */
async function scrubPartsHere() {
    const parts = new Map();
    for (const { kind, part, moduleId } of SOURCES) {
        if (!part || !moduleId) continue;
        const found = kind === 'automation' || kind === 'app'
            ? optionalFeatureModule(part)
            : await moduleForDataDuty(moduleId, part, { duty: 'remove a deleted knowledge base from its consumers', whenDataPresent: 'warn' });
        if (found) parts.set(kind, found);
    }
    return parts;
}

/**
 * Remove a base id from one JSON array column, best-effort.
 * @param {string} kbId
 * @param {ArrayScrub} scrub
 * @param {KbUsageDb} db
 * @returns {Promise<number>} the rows changed
 */
async function scrubArray(kbId, { table, column }, db) {
    try {
        if (!(await tableExists(table, db))) return 0;
        const r = await db.query(
            `UPDATE ${table}
                SET ${column} = COALESCE((
                        SELECT jsonb_agg(x) FROM jsonb_array_elements(${column}) AS x WHERE x <> to_jsonb($1::text)
                    ), '[]'::jsonb)
              WHERE ${column} @> $2::jsonb`,
            [kbId, JSON.stringify([kbId])],
        );
        return r.rowCount || 0;
    } catch (e) {
        log.warn(`[KBUsage] scrub ${table} failed:`, /** @type {Error} */ (e).message);
        return 0;
    }
}

/**
 * `agents.config` is TEXT holding JSON on some installs and jsonb on
 * others, so it is rewritten through a cast rather than updated in place;
 * a row holding '' is not a match, so it cannot fail the whole UPDATE.
 * @param {string} kbId
 * @param {KbUsageDb} db
 * @returns {Promise<number>}
 */
async function scrubAgents(kbId, db) {
    try {
        if (!(await tableExists('agents', db))) return 0;
        const r = await db.query(
            `UPDATE agents
                SET config = jsonb_set(
                        config::jsonb, '{knowledge_base_ids}',
                        COALESCE((
                            SELECT jsonb_agg(x)
                              FROM jsonb_array_elements(config::jsonb -> 'knowledge_base_ids') AS x
                             WHERE x <> to_jsonb($1::text)
                        ), '[]'::jsonb)
                    )::text
              WHERE (NULLIF(config::text, '')::jsonb -> 'knowledge_base_ids') @> $2::jsonb`,
            [kbId, JSON.stringify([kbId])],
        );
        return r.rowCount || 0;
    } catch (e) {
        log.warn('[KBUsage] scrub agents failed:', /** @type {Error} */ (e).message);
        return 0;
    }
}

/**
 * The ingest target of a support inbox (the support module's part), best-effort.
 * @param {string} kbId
 * @param {{ scrubIngestTarget?: (kbId: string, db: KbUsageDb) => Promise<number> } | undefined} part
 * @param {KbUsageDb} db
 * @returns {Promise<number>}
 */
async function scrubIngest(kbId, part, db) {
    if (!part?.scrubIngestTarget) return 0;
    try {
        if (!(await tableExists('support_inboxes', db))) return 0;
        return await part.scrubIngestTarget(kbId, db);
    } catch (e) {
        log.warn('[KBUsage] scrub support ingest target failed:', /** @type {Error} */ (e).message);
        return 0;
    }
}

/**
 * Remove every reference to a knowledge base, so deleting it leaves nothing
 * dangling.
 *
 * Called only after the person has confirmed they want to break these things.
 * Today `deleteKB` scrubs `projects` alone, so an agent kept a dead id in its
 * config for ever — invisible until somebody opened it and wondered why a
 * knowledge base they could not find was attached.
 *
 * Best-effort per kind and per row: a scrub that fails on one consumer must
 * not abandon the other seven, because the base IS going either way and a
 * half-scrubbed install is the worst of the three outcomes. The answer has a
 * key per kind of this installation (a module that is not here has none).
 * @param {string} kbId
 * @param {{ db?: KbUsageDb }} [opts]
 */
async function scrubReferences(kbId, { db = pool } = {}) {
    if (!kbId) return Object.fromEntries(scansHere().map(([kind]) => [kind, 0]));
    const parts = await scrubPartsHere();
    /** @type {Record<string, number>} */
    const scrubbed = {};
    for (const { kind, part } of SOURCES) if (!part || parts.has(kind)) scrubbed[kind] = 0;

    for (const kind of ['webpage', 'project', 'notebook', 'template', 'support']) {
        const scrub = CORE_ARRAY_SCRUBS[kind] ?? parts.get(kind)?.ARRAY_SCRUB;
        if (scrub) scrubbed[kind] = await scrubArray(kbId, scrub, db);
    }
    scrubbed.agent = await scrubAgents(kbId, db);
    if (parts.has('support')) scrubbed.support += await scrubIngest(kbId, parts.get('support'), db);

    /**
     * Automations and apps are NOT scrubbed, and that is deliberate.
     *
     * The id sits at an unknown depth inside a definition that also encodes
     * the shape of a canvas. Rewriting arbitrary JSON in place risks
     * corrupting an automation somebody spent an afternoon building, to save them
     * an error message that already names the missing base. The run-time
     * check (`execAi` drops an unresolvable id with a warning) is the safer
     * half of this pair, and the Used-by list told them before they confirmed.
     */
    return scrubbed;
}

module.exports = {
    usageForKb, usageSummary, scrubReferences, tableExists,
    /** Every kind of this installation, in the order the Used-by tab lists them. */
    get KINDS() { return Object.freeze(scansHere().map(([kind]) => kind)); },
    /** The scan of every kind of this installation. */
    get SCANS() { return Object.freeze(Object.fromEntries(scansHere())); },
};
