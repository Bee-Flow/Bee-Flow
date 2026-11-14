// @typecheck
const { run, getOne } = require('../../db');
const { initDB } = require('./schema');
const log = require('../../telemetry/log');
const { syncSeatQuantity } = require('./seatSyncPort');
const { bestEffort } = require('../../utils/bestEffort');
const { storeError } = require('../lib/storeError');
const steps = require('./usersDeleteSteps');

/**
 * The stages `userId` runs or owns, optionally only those of one organisation.
 *
 * An install whose stage table was never created has no stage, and asking
 * the stage store would create its schema from an account write, so the
 * table's existence is checked first.
 *
 * @param {string} userId
 * @param {{ organizationId?: string|null }} [opts]
 * @returns {Promise<Array<{ projectId: string, solutionId: string, stage: string, organizationId: string }>>}
 */
async function stagesRunBy(userId, opts = {}) {
    if (!userId) return [];
    const table = await getOne(`SELECT to_regclass('solution_stages') IS NOT NULL AS present`);
    if (!table?.present) return [];
    const stages = await require('../solutionStageStore').runAsStagesFor(userId);
    if (!Object.prototype.hasOwnProperty.call(opts, 'organizationId')) return stages;
    return stages.filter((st) => (st.organizationId || '') === (opts.organizationId || ''));
}

/**
 * 409 stage_run_as, naming the stages (ids only).
 * @param {{ projectId: string; solutionId: string; stage: string; organizationId: string; }[]} stages
 */
function stageRunAsError(stages) {
    const { storeError } = require('../lib/managedParts');
    return storeError(409, 'stage_run_as',
        'This account runs a Solution stage. An org admin can detach or remove the stages first.',
        { stages: stages.map((st) => ({ solutionId: st.solutionId, stage: st.stage, projectId: st.projectId })) });
}

/**
 * Refuse with 409 stage_run_as when `userId` runs or owns a stage (of
 * `organizationId`, when given).
 * @param {string} userId
 * @param {{ organizationId?: string|null }} [opts]
 */
async function assertNotStageRunAs(userId, opts = {}) {
    const stages = await stagesRunBy(userId, opts);
    if (stages.length > 0) throw stageRunAsError(stages);
}

/**
 * Erase an account and everything that names it.
 *
 * The users row goes LAST: when a step fails, the row stays and the call
 * rejects with 500 erasure_incomplete (details.failed names the steps), so the
 * same delete can simply be retried. Every step is idempotent. The plain
 * DELETEs are not one transaction on purpose: an install without one of the
 * optional tables would abort the whole transaction on the first missing one.
 *
 * @param {string} userId
 * @returns {Promise<boolean>} false when there is no such account
 */
async function deleteUser(userId) { // stepwise: cross-store account erasure; each step is idempotent and reported, and erasing again finishes a failed one
    await initDB();
    // Before anything is dropped: an account that runs a Solution stage stays.
    await assertNotStageRunAs(userId);
    const { notebooks: notebookPort, teardown: projectTeardown } = require('./erasurePorts').resolveErasurePorts();
    const contentPort = require('./erasurePorts').erasurePort('content'); const content = require('./contentErasure');
    // Capture the org now so we can sync Stripe seat quantity afterwards.
    // NULL orgId users (consumer accounts) skip the sync.
    const owner = await getOne('SELECT id, "organizationId" FROM users WHERE id = $1', [userId]);
    if (!owner) return false;
    const orgIdForSeatSync = owner.organizationId || null;
    const { failed, fail, step } = steps.erasureSteps(userId);

    log.info(`[UserStore] Erasing the data of user '${userId}'...`);
    await steps.eraseConfigKeys(userId, fail);
    await steps.eraseSessionsAndTokens(userId, step);
    await steps.eraseNotebooks(userId, step, notebookPort);
    await steps.erasePersonalRecords(userId, { step, fail, content });
    await steps.eraseCredentialsAndConnections(userId, step);
    await steps.eraseProjects(userId, { step, failed, projectTeardown });
    await steps.eraseOwnedAgents(userId, step);

    // Everything else that names the person: erasureCoverage.js (held against the schema by the footprint test).
    await content.eraseContent(userId, step, { content: contentPort, oldestOrgAdmin: steps.oldestOrgAdmin });
    await steps.eraseDatatables(userId, step);
    await steps.eraseNotifications(userId, step);

    if (failed.length) {
        throw storeError(500, 'erasure_incomplete',
            'The account could not be fully erased. It is kept so the delete can be retried.', { failed });
    }
    await run('DELETE FROM users WHERE id = $1', [userId]);
    log.info(`[UserStore] Cleanup complete for user '${userId}'`);
    // Per-seat plans rebill on user count change. Fire-and-forget — Stripe
    // outages don't block the delete; the webhook reconciles afterwards.
    if (orgIdForSeatSync) {
        Promise.resolve().then(async () => {
            try {
                await syncSeatQuantity(orgIdForSeatSync);
            } catch (err) { bestEffort('users/delete:seatSync', err); }
        });
    }
    return true;
}

const { eraseSuggestionTraces, eraseCmsUploadTickets } = steps;

module.exports = { eraseSuggestionTraces, stagesRunBy, assertNotStageRunAs, eraseCmsUploadTickets, deleteUser };
