// @typecheck
/**
 * automation_agent_bindings: which agents may call an `agent_call` automation.
 * The table comes from migrations/automation-agent-bindings-2026-10.js; who may
 * write a row, and when a row counts, is automation/agentBinding.js, not here.
 *
 * Built by a factory over a `{ query, tx }` handle, like shares.js, so the pg
 * test can run it against PGlite without mocking the module system.
 */

'use strict';

const crypto = require('crypto');
const { AUTOMATION_SELECT } = require('./lifecycle');

function rowToBinding(r) {
    if (!r) return null;
    return {
        id: r.id,
        automationId: r.automation_id,
        agentId: r.agent_id,
        createdBy: r.created_by ?? null,
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
    };
}

/**
 * @param {{
 *   query: (sql: string, params?: any[]) => Promise<{ rows: any[], rowCount?: number }>,
 *   tx: <T>(fn: (q: { query: (sql: string, params?: any[]) => Promise<{ rows: any[], rowCount?: number }> }) => Promise<T>) => Promise<T>,
 * }} db
 * @param {{ ready?: () => Promise<void> }} [opts]
 */
function makeAgentBindingsStore(db, { ready = async () => {} } = {}) {
    const { rowToAutomation } = require('./rowMappers');

    /** Every binding of one automation, oldest first. */
    async function listBindingsForAutomation(automationId) {
        await ready();
        const r = await db.query(
            `SELECT * FROM automation_agent_bindings WHERE automation_id = $1 ORDER BY created_at ASC, id ASC`,
            [automationId],
        );
        return r.rows.map(rowToBinding);
    }

    /**
     * The automations bound to one agent, as store rows (with the live copy the
     * runner executes). Trashed automations and Steps/flowlets are left out; whether
     * a row is ACTIVE and still an agent trigger is for the caller to read off
     * the mapped row, so a dispatch can say which of the two it was.
     */
    async function listAutomationsBoundToAgent(agentId) {
        await ready();
        if (!agentId) return [];
        const r = await db.query(
            `${AUTOMATION_SELECT}
               JOIN automation_agent_bindings b ON b.automation_id = a.id
              WHERE b.agent_id = $1
                AND a.deleted_at IS NULL
                AND COALESCE(a.kind, 'automation') = 'automation'
              ORDER BY b.created_at ASC, b.id ASC`,
            [agentId],
        );
        return r.rows.map((row) => rowToAutomation(row));
    }

    /** Is this agent bound to this automation right now? */
    async function hasAgentBinding(automationId, agentId) {
        await ready();
        if (!automationId || !agentId) return false;
        const r = await db.query(
            `SELECT 1 FROM automation_agent_bindings WHERE automation_id = $1 AND agent_id = $2 LIMIT 1`,
            [automationId, agentId],
        );
        return r.rows.length > 0;
    }

    /**
     * Add and remove bindings of one automation in one transaction. Adding a
     * binding that exists keeps its row (and its created_at/by); removing one
     * that is not there is a no-op. The gate has decided what is allowed; this
     * writes what it is given. Answers the list after the change.
     *
     * @param {string} automationId
     * @param {{ add?: string[], remove?: string[] }} change
     * @param {string|null} byUserId
     */
    async function applyAgentBindings(automationId, { add = [], remove = [] } = {}, byUserId = null) {
        await ready();
        await db.tx(async (q) => {
            if (remove.length) {
                await q.query(
                    `DELETE FROM automation_agent_bindings WHERE automation_id = $1 AND agent_id = ANY($2::text[])`,
                    [automationId, remove],
                );
            }
            for (const agentId of add) {
                await q.query(
                    // clock_timestamp(), not NOW(): NOW() is the transaction's start,
                    // so every row of one save would share it and "oldest first"
                    // would fall back to random ids.
                    `INSERT INTO automation_agent_bindings (id, automation_id, agent_id, created_by, created_at)
                     VALUES ($1, $2, $3, $4, clock_timestamp())
                     ON CONFLICT (automation_id, agent_id) DO NOTHING`,
                    [crypto.randomUUID(), automationId, agentId, byUserId],
                );
            }
        });
        return listBindingsForAutomation(automationId);
    }

    /** Drop every binding that names this agent (it was deleted). Answers how many. */
    async function deleteBindingsForAgent(agentId) {
        await ready();
        if (!agentId) return 0;
        const r = await db.query(`DELETE FROM automation_agent_bindings WHERE agent_id = $1`, [agentId]);
        return r.rowCount || 0;
    }

    return {
        listBindingsForAutomation,
        listAutomationsBoundToAgent,
        hasAgentBinding,
        applyAgentBindings,
        deleteBindingsForAgent,
    };
}

// The instance the app uses: the pool, behind the store's schema init.
const { initDB, pool, getClient } = require('./core');
const defaultStore = makeAgentBindingsStore({
    query: (sql, params) => pool.query(sql, params),
    async tx(fn) {
        const client = await getClient();
        try {
            await client.query('BEGIN');
            const out = await fn({ query: (sql, params) => client.query(sql, params) });
            await client.query('COMMIT');
            return out;
        } catch (e) {
            await client.query('ROLLBACK').catch(() => {});
            throw e;
        } finally {
            client.release();
        }
    },
}, { ready: initDB });

module.exports = {
    makeAgentBindingsStore,
    rowToBinding,
    listBindingsForAutomation: defaultStore.listBindingsForAutomation,
    listAutomationsBoundToAgent: defaultStore.listAutomationsBoundToAgent,
    hasAgentBinding: defaultStore.hasAgentBinding,
    applyAgentBindings: defaultStore.applyAgentBindings,
    deleteBindingsForAgent: defaultStore.deleteBindingsForAgent,
};
