// @typecheck
/**
 * Agents filed into projects (Solution membership): listing, counting, filing,
 * and clearing a deleted project from its agents.
 */

const { run, getAll } = require('../../db');
const { initDB } = require('./initSchema');

// ── Solution membership (O1) ────────────────────────────────────────────────
//
// `agents.project_id` is a SOFT reference (stores/agent/initSchema.js): filing
// an agent into a project must never mean a project delete can destroy it. The
// three hooks below are what projects/membership.js registers, in the shape
// studioAppStore.setAppProject already proves — an owner-matched UPDATE that
// reports whether it matched, plus a detacher the project delete runs.

/**
 * The agents filed into one project.
 *
 * A DELIBERATELY NARROWER projection than getAgents(): the project's Content
 * tab needs a name, a description and an owner. `config` carries the agent's
 * tool grants, its knowledge-base ids and its attached skills, and
 * `system_prompt` is its instructions — handing either to every project member
 * because they may see the agent's NAME would be a disclosure the project role
 * never granted. Whoever opens the agent still goes through the agents routes,
 * which apply their own checks.
 */
async function listProjectAgents(projectId) {
    await initDB();
    if (!projectId) return [];
    const rows = await getAll(
        `SELECT id, name, description, avatar, owner_id, project_id, updated_at
           FROM agents WHERE project_id = $1 ORDER BY updated_at DESC`,
        [projectId],
    );
    return (rows || []).map(r => ({
        id: r.id,
        name: r.name,
        description: r.description || '',
        avatar: r.avatar || null,
        // ONE spelling, on purpose: this projection is new, so there is no
        // legacy caller to keep happy, and two names for one fact is two names
        // that can disagree about who owns the row.
        ownerId: r.owner_id,
        projectId: r.project_id || null,
        updatedAt: r.updated_at,
    }));
}

/**
 * How many agents each of these projects holds — ONE query for the whole
 * list, keyed by project id.
 *
 * The overview draws a card per Solution and every card carries a tally. Doing
 * that with the listing above would be one round-trip per project per kind, and
 * would read whole rows to throw all but their number away. A project that
 * appears in no row is genuinely EMPTY, which is why the caller distinguishes a
 * missing key (0) from a failed read (the whole call rejects) rather than
 * folding both into a zero.
 */
async function countProjectAgents(projectIds) {
    await initDB();
    const ids = (Array.isArray(projectIds) ? projectIds : []).filter(id => typeof id === 'string' && id);
    if (!ids.length) return new Map();
    const rows = await getAll(
        `SELECT project_id, COUNT(*)::int AS n FROM agents
          WHERE project_id = ANY($1) GROUP BY project_id`,
        [ids],
    );
    return new Map((rows || []).map(r => [r.project_id, Number(r.n) || 0]));
}

/**
 * File an agent into a project, or take it out (`projectId = null`).
 *
 * Owner-only, matched in the WHERE clause rather than checked first: filing an
 * agent into a project exposes it to every member without it being published to
 * the organisation, and that is the owner's call. The route checks the caller's
 * role on the TARGET project separately.
 *
 * `rev` is deliberately NOT bumped. `rev` is the editor's optimistic-concurrency
 * token over the agent's CONCEPT (name, prompt, config); filing the same agent
 * into a project changes none of that, and bumping it here would make an open
 * editor's next save collide with a change it cannot see.
 */
async function setAgentProject(agentId, userId, projectId) {
    await initDB();
    const { rowCount } = await run(
        'UPDATE agents SET project_id = $1, updated_at = NOW() WHERE id = $2 AND owner_id = $3',
        [projectId || null, agentId, userId],
    );
    return rowCount > 0;
}

/**
 * Detach every agent from a deleted project.
 *
 * Soft reference, so nothing clears it automatically — and deleting a project
 * must never destroy the agents its members built inside it.
 */
async function clearProjectFromAgents(projectId) {
    await initDB();
    const { rowCount } = await run(
        'UPDATE agents SET project_id = NULL WHERE project_id = $1',
        [projectId],
    );
    return rowCount;
}

module.exports = { listProjectAgents, countProjectAgents, setAgentProject, clearProjectFromAgents };
