// @typecheck
/**
 * Account erasure, the collaborative-project half.
 *
 * `eraseOwnedProjects`: the projects the deleted person OWNED are deleted the
 * way their owner would delete them (projects/projectTeardown.js): colleagues'
 * co-edits folded back into their notebooks and pages first, soft references
 * detached, then the row, then the project's files base. A bare
 * `DELETE FROM projects` cascaded the co-editing log away with every edit not
 * yet written back, and left the files base (every member's uploads) behind
 * with no project to reach it through.
 *
 * `eraseProjectTraces`: what the person leaves behind in OTHER people's
 * projects:
 *
 *   team chat messages     blanked the way they could delete them, numbering kept
 *   comments               blanked the same way; their id leaves mention lists
 *   co-editing log         their id leaves the update log and client bindings;
 *                          the content is the project's and stays
 *   "what changed" state   their visit and seen marks
 *   AI participation       their "not helpful" marks and the watches they started
 *   AI opt-out             their personal preference row in the config store
 *   compliance hints       the project hints they dismissed or snoozed
 *
 * Each step is independent and best-effort, like the rest of deleteUser: one
 * store that is unavailable must not stop the others. Failures are logged
 * with the step's name only.
 */

'use strict';

const log = require('../../telemetry/log');

/**
 * @param {string} userId
 * @param {{ steps?: Array<[string, (userId: string) => Promise<any>]> }} [opts]  test seam
 * @returns {Promise<Record<string, any>>} what each step reported (or `{ failed: true }`)
 */
async function eraseProjectTraces(userId, opts = {}) {
    const steps = opts.steps || [
        ['team chat messages', (id) => require('../projectChatStore').eraseAuthor(id)],
        ['comments', (id) => require('../projectCommentStore').eraseAuthor(id)],
        ['co-editing log', (id) => require('../collabDocStore').anonymiseUser(id)],
        ['change feed state', (id) => require('../projectStore').eraseUserChangeState(id)],
        ['AI participation', (id) => require('../projectAiParticipationStore').eraseUser(id)],
        ['AI participation preference', (id) => require('../configStore')
            .deleteConfig(`${require('../../projects/participation/policy').USER_KEY_PREFIX}${id}`)],
        ['compliance hint dismissals', (id) => require('../complianceStore').eraseHintDismissals(id)],
    ];
    /** @type {Record<string, any>} */
    const report = {};
    if (!userId) return report;
    for (const [name, run] of steps) {
        try {
            report[name] = await run(userId);
        } catch (e) {
            report[name] = { failed: true };
            log.error(`[UserStore] erasing ${name} failed:`, /** @type {Error} */ (e).message);
        }
    }
    return report;
}

/**
 * Delete every project `userId` owns, one at a time through the same teardown
 * as `DELETE /api/projects/:id`. A project that still has a conversation
 * shared into it is kept, as the route keeps it: the schema refuses the
 * delete, and only each conversation's owner can unshare it. Nothing is
 * folded back or detached for it, so it stays exactly as it was.
 *
 * @param {string} userId
 * @param {{
 *   listOwned?: (userId: string) => Promise<string[]>,
 *   countSharedThreads?: (projectId: string) => Promise<number>,
 *   teardown?: { deleteProject: (projectId: string) => Promise<boolean> },
 * }} [opts]  test seam
 * @returns {Promise<{ deleted: number, kept: number, failed: number }>}
 */
async function eraseOwnedProjects(userId, opts = {}) {
    const listOwned = opts.listOwned || (async (id) => {
        const rows = await require('../../db').getAll('SELECT id FROM projects WHERE owner_id = $1 ORDER BY id', [id]);
        return rows.map((/** @type {{ id: string }} */ r) => r.id);
    });
    const countSharedThreads = opts.countSharedThreads
        || ((projectId) => require('../projectStore').countSharedThreads(projectId));
    const teardown = opts.teardown || require('../../projects/projectTeardown').makeProjectTeardown();

    const report = { deleted: 0, kept: 0, failed: 0 };
    if (!userId) return report;
    /** @type {string[]} */
    let ids;
    try {
        ids = await listOwned(userId);
    } catch (e) {
        log.error('[UserStore] listing owned projects failed:', /** @type {Error} */ (e).message);
        report.failed += 1;
        return report;
    }
    for (const projectId of ids) {
        try {
            if ((await countSharedThreads(projectId)) > 0) {
                report.kept += 1;
                log.warn(`[UserStore] project ${projectId} kept: conversations are still shared into it`);
                continue;
            }
            if (await teardown.deleteProject(projectId)) report.deleted += 1;
        } catch (e) {
            report.failed += 1;
            log.error(`[UserStore] deleting owned project ${projectId} failed:`, /** @type {Error} */ (e).message);
        }
    }
    return report;
}

module.exports = { eraseProjectTraces, eraseOwnedProjects };
