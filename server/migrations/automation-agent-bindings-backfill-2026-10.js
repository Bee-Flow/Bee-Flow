/**
 * Backfill: link the agent_call automations that already have an explicit
 * agent to that agent (2026-10).
 *
 * Until automation_agent_bindings existed, an active agent_call automation was
 * offered to every agent of its owner. From now on it is offered only to the
 * agents it is bound to, so an install that upgrades must not lose the links
 * its owners already made on purpose, and must not gain any it never made.
 *
 * "Made on purpose" is exactly what the OWNER wrote down per agent:
 *   - the agent's `config.tools.automations` (or its published copy) lists the
 *     automation's id, which is how the agent editor grants an automation and how
 *     a persona hand-off is stored, or
 *   - the agent's persona hands off to it (`persona.unknown.automationId`).
 * The agent has to belong to the automation's owner as well. An agent of a
 * colleague that names the id could only ever work for the colleague's own
 * automations, so binding it would let all its users start someone else's
 * automation: wider than today.
 *
 * Everything else stays unbound (the trigger panel says "not linked to any
 * agent yet"): an uncurated agent is NOT bound, because "nobody touched the
 * list" is not a choice.
 *
 * Only automations whose LIVE definition is an agent trigger (the copy that
 * runs) are looked at; a retriggered one is not offered today. A PAUSED one is
 * bound as well: before the upgrade, resuming it was enough to make the agents
 * that list it offer it again, and the backfill runs once, so skipping it would
 * lose that link for good. A binding does not make a paused automation
 * callable: the dispatch still refuses an inactive one.
 *
 * Runs ONCE, by its own state and not only by the boot ledger. The ledger
 * (boot/bootMigrations) runs an entry again when the file's checksum changes
 * (any later edit, even a comment), runs the whole ladder unrecorded when the
 * ledger cannot be read, and runs everything on `--force`. Each of those would
 * re-bind every pair an owner has unlinked since, because the rows alone cannot
 * tell "never bound" from "bound and removed". So the marker row
 * (`automation_agent_bindings_backfill_done`) is written in the SAME statement
 * as the inserts (one data-modifying CTE, so one atomic write), and a run that
 * finds it returns at once. It is written even when there was nothing to bind:
 * an agent_call automation created after the upgrade has never been "an
 * existing link" and a replay must not invent one.
 *
 * Within the one run it is still idempotent: ON CONFLICT DO NOTHING on
 * (automation_id, agent_id). `db` is injectable so a test runs the real SQL on
 * an in-process Postgres.
 */

'use strict';

const crypto = require('crypto');
const log = require('../telemetry/log');

const NAME = 'automation-agent-bindings-backfill-2026-10';
const MARKER_TABLE = 'automation_agent_bindings_backfill_done';

/** @typedef {{ query: (sql: string, params?: any[]) => Promise<{rows: any[], rowCount?: number}> }} Db */

async function tableExists(db, table) {
    const { rows } = await db.query(`SELECT to_regclass($1) AS t`, [`public.${table}`]);
    return !!(rows[0] && rows[0].t);
}

/** A JSON column, whichever way the driver or the column type hands it over. */
function asObject(v) {
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    if (typeof v === 'string' && v.trim().startsWith('{')) {
        try {
            const parsed = JSON.parse(v);
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
        } catch { return null; }
    }
    return null;
}

/** The automation ids one agent row names, in any of the three places. */
function chosenAutomationIds(agent) {
    const ids = new Set();
    for (const raw of [agent.config, agent.published_config]) {
        const config = asObject(raw);
        const automations = config && asObject(config.tools) && asObject(config.tools).automations;
        const grants = asObject(automations);
        if (grants) for (const id of Object.keys(grants)) ids.add(id);
    }
    const persona = asObject(agent.persona);
    const unknown = persona && asObject(persona.unknown);
    if (unknown && unknown.mode === 'handoff' && typeof unknown.automationId === 'string' && unknown.automationId) {
        ids.add(unknown.automationId);
    }
    return ids;
}

/** @param {{ db?: Db }} [opts] */
async function up({ db } = {}) {
    let conn = db;
    if (!conn) {
        // Boot does not sequence this ladder after the store inits: make sure the
        // tables it reads and writes are there before looking.
        await require('../stores/automationStore').initDB();
        await require('../stores/agentStore').initDB();
        conn = { query: (sql, params) => require('../db').run(sql, params) };
    }
    for (const table of ['automations', 'agents', 'automation_agent_bindings']) {
        // Throws, so the ledger does not record it and the next boot retries.
        if (!(await tableExists(conn, table))) throw new Error(`${NAME}: table ${table} does not exist yet`);
    }

    await conn.query(`CREATE TABLE IF NOT EXISTS ${MARKER_TABLE} (
        name    TEXT PRIMARY KEY,
        done_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    const { rows: done } = await conn.query(`SELECT 1 FROM ${MARKER_TABLE} WHERE name = $1`, [NAME]);
    if (done.length) {
        log.info(`[Migration] ${NAME}: already applied once, not replaying`);
        return { automations: 0, bound: 0, skipped: true };
    }

    // Inserts and marker in ONE statement: a data-modifying CTE runs whether or
    // not the main query reads it, and the statement commits or fails whole, so
    // there is never a marker without its inserts or the other way round.
    const commit = async (pairs) => {
        const res = await conn.query(
            `WITH ins AS (
                 INSERT INTO automation_agent_bindings (id, automation_id, agent_id, created_by)
                 SELECT t.id, t.automation_id, t.agent_id, NULL
                   FROM unnest($1::text[], $2::text[], $3::text[]) AS t(id, automation_id, agent_id)
                 ON CONFLICT (automation_id, agent_id) DO NOTHING
                 RETURNING automation_id, agent_id
             ), marker AS (
                 INSERT INTO ${MARKER_TABLE} (name) VALUES ($4) ON CONFLICT (name) DO NOTHING
             )
             SELECT automation_id, agent_id FROM ins`,
            [pairs.map(() => crypto.randomUUID()), pairs.map((p) => p.automationId), pairs.map((p) => p.agentId), NAME],
        );
        return res.rows;
    };

    const { rows: automations } = await conn.query(`
        SELECT a.id, a.user_id
          FROM automations a
         WHERE COALESCE(a.kind, 'automation') = 'automation'
           AND a.deleted_at IS NULL
           AND COALESCE(a.live_definition_json, a.definition_json) -> 'trigger' ->> 'kind' = 'agent_call'
    `);
    if (!automations.length) {
        await commit([]);
        return { automations: 0, bound: 0 };
    }

    const owners = [...new Set(automations.map((a) => a.user_id))];
    const { rows: agents } = await conn.query(
        `SELECT id, owner_id, config, published_config, persona FROM agents WHERE owner_id = ANY($1::text[])`,
        [owners],
    );

    const byOwner = new Map();
    for (const a of automations) {
        if (!byOwner.has(a.user_id)) byOwner.set(a.user_id, new Set());
        byOwner.get(a.user_id).add(a.id);
    }

    const pairs = [];
    for (const agent of agents) {
        const mine = byOwner.get(agent.owner_id);
        if (!mine) continue;
        for (const automationId of chosenAutomationIds(agent)) {
            if (mine.has(automationId)) pairs.push({ automationId, agentId: agent.id });
        }
    }
    const inserted = await commit(pairs);
    for (const r of inserted) log.info(`[Migration] ${NAME}: bound automation=${r.automation_id} agent=${r.agent_id}`);
    const summary = { automations: automations.length, bound: inserted.length };
    log.info(`[Migration] ${NAME} applied: ${JSON.stringify(summary)}`);
    return summary;
}

module.exports = { up, chosenAutomationIds };

if (require.main === module) {
    up().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
}
