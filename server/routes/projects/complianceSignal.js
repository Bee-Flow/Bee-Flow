// @typecheck
/**
 * Tell the Compliance Center that something its project checks read has
 * changed, so the project is re-judged within seconds instead of at the next
 * six-hourly sweep (compliance/events.js PROJECT_CHANGED).
 *
 *   signalProjectChanged(project, reason)
 *
 * `reason` is one of 'members' (shared, unshared, a role changed, somebody
 * left), 'ai_mode' (a team chat's or comment thread's AI mode), 'files' (a
 * project file uploaded or deleted) or 'archived'. The payload is ids only:
 * `{ orgId, projectId, reason }`. An org-less project belongs to the
 * compliance checks' 'default' bucket, the same way they scope it.
 *
 * Routes raise it (stores may not require a feature), after the change was
 * saved. Fire-and-forget: the compliance bus never throws upstream, and an
 * install without the compliance module is not asked to re-check anything.
 */

'use strict';

/**
 * @param {{ id?: string, organizationId?: string|null } | null | undefined} project
 * @param {'members'|'ai_mode'|'files'|'archived'} reason
 * @param {{ emit?: (event: string, payload: object) => void, moduleAvailable?: () => boolean }} [deps]
 */
function signalProjectChanged(project, reason, deps = {}) {
    if (!project || !project.id || !reason) return false;
    try {
        const available = deps.moduleAvailable
            || (() => require('../../modules/catalog').isModuleAvailable('compliance'));
        if (!available()) return false;
        const orgId = project.organizationId
            ? String(project.organizationId)
            : require('../../compliance/projects/projectData').NO_ORG_ORG_ID;
        const events = require('../../compliance/events');
        (deps.emit || events.emit)(events.EVENTS.PROJECT_CHANGED, { orgId, projectId: String(project.id), reason });
        return true;
    } catch (_) {
        // The compliance bus is best-effort; a change that was saved stays saved.
        return false;
    }
}

module.exports = { signalProjectChanged };
