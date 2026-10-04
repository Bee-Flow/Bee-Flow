// @typecheck
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
 * ── THE ROWS ARE THE Used-by CONTRACT ───────────────────────────────
 * `{ kind, id, title, role, ownerId, lastAt }` — the shape
 * `shared/UsedByTab.jsx` renders and `shared/DangerZone.jsx` counts, so the
 * tab, the delete confirmation and the overview pills cannot disagree about
 * what depends on what.
 */

const { pool } = require('../../db');
const log = require('../../telemetry/log');

/** Every kind this can find, in the order the Used-by tab lists them. */
const KINDS = Object.freeze(['agent', 'automation', 'app', 'webpage', 'project', 'notebook', 'template', 'support']);

async function tableExists(name, client) {
    try {
        const r = await (client || pool).query('SELECT to_regclass($1) AS t', [name]);
        return !!r.rows[0]?.t;
    } catch (_) {
        return false;
    }
}

/**
 * One query per consumer kind. Each returns `{ rows }` or throws; a throw is
 * caught by the caller and recorded as a partial answer rather than as zero.
 *
 * Every one of these filters on the KB id in SQL rather than reading every row
 * and filtering in Node: an org with 4000 automations is not unusual and the
 * delete dialog must not become a table scan the person waits on.
 */
const SCANS = Object.freeze({
    agent: {
        table: 'agents',
        sql: `SELECT id, name AS title, owner_id, updated_at AS last_at
                FROM agents
               WHERE (config::jsonb -> 'knowledge_base_ids') @> $1::jsonb`,
        params: (kbId) => [JSON.stringify([kbId])],
        role: 'chat',
    },
    automation: {
        table: 'automations',
        // The ids live at an unknown depth inside the definition, so the
        // containment operator cannot be used — `jsonb_path_exists` with a
        // recursive wildcard is the one form that finds them wherever an
        // editor put them.
        //
        // The id goes in through jsonpath's own VARS argument, never
        // concatenated into the path. A kb id is a route parameter, and a
        // value carrying a quote would otherwise close the string literal
        // inside the jsonpath and be parsed as path syntax — bound to a
        // placeholder or not, the injection would be into the path, not the
        // SQL.
        sql: `SELECT id, title, user_id AS owner_id, updated_at AS last_at
                FROM automations
               WHERE jsonb_path_exists(definition_json, '$.**.knowledgeBaseIds[*] ? (@ == $id)', jsonb_build_object('id', $1::text))`,
        params: (kbId) => [kbId],
        role: 'ai_step',
    },
    app: {
        table: 'studio_apps',
        // Both the working definition and the published one: an app that only
        // uses the base in its PUBLISHED version still breaks if it goes.
        sql: `SELECT id, name AS title, user_id AS owner_id, updated_at AS last_at
                FROM studio_apps
               WHERE jsonb_path_exists(COALESCE(definition, '{}'::jsonb), '$.**.knowledgeBaseIds[*] ? (@ == $id)', jsonb_build_object('id', $1::text))
                  OR jsonb_path_exists(COALESCE(published_definition, '{}'::jsonb), '$.**.knowledgeBaseIds[*] ? (@ == $id)', jsonb_build_object('id', $1::text))`,
        params: (kbId) => [kbId],
        role: 'answer_block',
    },
    webpage: {
        table: 'webpages',
        sql: `SELECT id, name AS title, user_id AS owner_id, updated_at AS last_at
                FROM webpages WHERE knowledge_base_ids @> $1::jsonb`,
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
    template: {
        table: 'word_templates',
        sql: `SELECT id, name AS title, user_id AS owner_id, updated_at AS last_at
                FROM word_templates WHERE knowledge_base_ids @> $1::jsonb`,
        params: (kbId) => [JSON.stringify([kbId])],
        role: 'contains',
    },
    support: {
        table: 'support_inboxes',
        // TWO different dependencies, and both break on a delete:
        //   kb_ids           — the bases the auto-responder answers FROM
        //   kb_ingest_kb_id  — the base resolved tickets are distilled INTO,
        //                      a scalar column, not an array
        // The second is the one that would have been missed: the inbox keeps
        // running and every distilled ticket lands nowhere.
        sql: `SELECT id, display_name AS title, created_by AS owner_id, updated_at AS last_at, 'chat' AS row_role
                FROM support_inboxes WHERE kb_ids @> $1::jsonb
               UNION ALL
              SELECT id, display_name AS title, created_by AS owner_id, updated_at AS last_at, 'ingest_target' AS row_role
                FROM support_inboxes WHERE kb_ingest_kb_id::text = $2::text`,
        params: (kbId) => [JSON.stringify([kbId]), kbId],
        role: 'chat',
    },
});

/**
 * Who uses this knowledge base?
 *
 * @param {string} kbId
 * @param {object} [opts]
 * @param {object} [opts.db]    injection seam for the tests
 * @returns {Promise<{ rows: Array, partial: string[] }>}
 *          `partial` names the kinds that could NOT be answered — a table that
 *          is absent, or a query that failed. A caller must treat a non-empty
 *          `partial` as "I do not know", never as "nothing".
 */
async function usageForKb(kbId, { db = pool } = {}) {
    if (!kbId) return { rows: [], partial: [] };
    const rows = [];
    const partial = [];

    for (const kind of KINDS) {
        const scan = SCANS[kind];
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
            log.warn(`[KBUsage] ${kind} scan failed for ${kbId}:`, e.message);
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
 */
async function usageSummary(kbIds, { db = pool } = {}) {
    const ids = Array.isArray(kbIds) ? kbIds.filter(Boolean) : [];
    const out = {};
    for (const id of ids) out[id] = { counts: {}, partial: [] };
    if (ids.length === 0) return out;

    for (const kind of KINDS) {
        const scan = SCANS[kind];
        const present = await tableExists(scan.table, db);
        for (const id of ids) {
            if (!present) { out[id].partial.push(kind); continue; }
            try {
                const r = await db.query(scan.sql, scan.params(id));
                const n = (r.rows || []).length;
                if (n > 0) out[id].counts[kind] = n;
            } catch (e) {
                log.warn(`[KBUsage] ${kind} summary failed for ${id}:`, e.message);
                out[id].partial.push(kind);
            }
        }
    }
    return out;
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
 * half-scrubbed install is the worst of the three outcomes.
 */
async function scrubReferences(kbId, { db = pool } = {}) {
    const scrubbed = { agent: 0, automation: 0, app: 0, webpage: 0, project: 0, notebook: 0, template: 0, support: 0 };
    if (!kbId) return scrubbed;

    const jsonArrayScrubs = [
        ['webpage', 'webpages', 'knowledge_base_ids'],
        ['project', 'projects', 'knowledge_base_ids'],
        ['notebook', 'notebooks', 'knowledge_base_ids'],
        ['template', 'word_templates', 'knowledge_base_ids'],
        ['support', 'support_inboxes', 'kb_ids'],
    ];
    for (const [kind, table, column] of jsonArrayScrubs) {
        try {
            if (!(await tableExists(table, db))) continue;
            const r = await db.query(
                `UPDATE ${table}
                    SET ${column} = COALESCE((
                            SELECT jsonb_agg(x) FROM jsonb_array_elements(${column}) AS x WHERE x <> to_jsonb($1::text)
                        ), '[]'::jsonb)
                  WHERE ${column} @> $2::jsonb`,
                [kbId, JSON.stringify([kbId])],
            );
            scrubbed[kind] = r.rowCount || 0;
        } catch (e) {
            log.warn(`[KBUsage] scrub ${table} failed:`, e.message);
        }
    }

    // `agents.config` is TEXT holding JSON on some installs and jsonb on
    // others, so it is rewritten through a cast rather than updated in place.
    try {
        if (await tableExists('agents', db)) {
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
                  WHERE (config::jsonb -> 'knowledge_base_ids') @> $2::jsonb`,
                [kbId, JSON.stringify([kbId])],
            );
            scrubbed.agent = r.rowCount || 0;
        }
    } catch (e) {
        log.warn('[KBUsage] scrub agents failed:', e.message);
    }

    // The ingest target is a scalar, so it cannot be filtered out of an
    // array — it is cleared, and the ingest switched off with it. Leaving the
    // flag on with a null target would keep the automation running against
    // nothing, which is the silent version of the same breakage.
    try {
        if (await tableExists('support_inboxes', db)) {
            const r = await db.query(
                `UPDATE support_inboxes
                    SET kb_ingest_kb_id = NULL, kb_ingest_enabled = false
                  WHERE kb_ingest_kb_id::text = $1::text`,
                [kbId],
            );
            scrubbed.support += r.rowCount || 0;
        }
    } catch (e) {
        log.warn('[KBUsage] scrub support ingest target failed:', e.message);
    }

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

module.exports = { usageForKb, usageSummary, scrubReferences, KINDS, SCANS, tableExists };
