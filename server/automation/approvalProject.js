/**
 * The Solution stamp on an approval.
 *
 * `project_id` / `project_title` are frozen at INSERT and never updated (see
 * migrations/approvals-project-id-2026-09.js), so all three creation sites — a
 * paused run, the lazy backfill, and an app's request_approval action — must
 * resolve them the same way, from whichever parent that site happens to hold.
 *
 * Best-effort throughout, and deliberately so: an unavailable project store or
 * a project deleted mid-flight must never stop the approval from being written.
 * A blank title is recoverable at read time; a lost decision record is not.
 */
const log = require('../telemetry/log');

async function projectStamp(projectId) {
    if (!projectId) return { projectId: null, projectTitle: '' };
    let projectTitle = '';
    try {
        const project = await require('../stores/projectStore').getProject(projectId);
        projectTitle = project?.name || '';
    } catch (err) {
        log.warn('[Approvals] could not resolve project title:', err.message);
    }
    return { projectId, projectTitle };
}

module.exports = { projectStamp };
