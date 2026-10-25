// @typecheck noImplicitAny
/**
 * Whose connections a shared or agent-called run uses (definition.runPolicy.
 * connections) is the OWNER's call. The routes refuse an editor that tries to
 * move it (automation/ownerOnlyFields.js); this is the same rule where every
 * writer passes, so a definition written by anything else (a project install or
 * upgrade, a stage prepare or compensate, an evolution rollback) cannot move it
 * either: such a write keeps the stored value. Even a writer acting AS the owner
 * (an evolution rollback, a package upgrade) keeps it: only a route that proved
 * the owner role may move it.
 */

'use strict';

/** @param {any} definition */
const modeOf = (definition) => (definition && definition.runPolicy && definition.runPolicy.connections === 'caller' ? 'caller' : 'owner');

/**
 * `updates` with the stored connections mode put back unless `allowChange`
 * (passed only by a route that proved the owner role) is set.
 *
 * @param {{ query: (sql: string, params?: any[]) => Promise<{ rows: any[] }> }} client
 * @param {string} id
 * @param {{ definition?: any }} updates
 * @param {string|null|undefined} _savedByUserId  who saved; deliberately not a reason to allow the change
 * @param {boolean} allowChange
 */
async function keepConnectionsPolicy(client, id, updates, _savedByUserId, allowChange) {
    const next = updates && updates.definition;
    if (allowChange || !next || typeof next !== 'object' || Array.isArray(next)) return updates;
    const { rows } = await client.query('SELECT user_id, definition_json FROM automations WHERE id = $1', [id]);
    const row = rows[0];
    if (!row) return updates;
    const stored = typeof row.definition_json === 'string' ? JSON.parse(row.definition_json) : row.definition_json;
    const keep = modeOf(stored);
    if (modeOf(next) === keep) return updates;
    const runPolicy = { ...(next.runPolicy || {}) };
    if (keep === 'caller') runPolicy.connections = 'caller';
    else delete runPolicy.connections;
    const definition = { ...next, runPolicy };
    if (!Object.keys(runPolicy).length) delete definition.runPolicy;
    return { ...updates, definition };
}

module.exports = { keepConnectionsPolicy, modeOf };
