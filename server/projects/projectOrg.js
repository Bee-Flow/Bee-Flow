'use strict';
/**
 * Which organisation a project belongs to, and who belongs to it.
 *
 * One answer for every path that compares a person with a project (invites, the
 * member list, filing or creating a document, notebook or meeting in a project,
 * the AI's document tools). They used to compare the account row's own
 * `organizationId` with the project's, which is '' for an account whose
 * organisation only comes from a group, so those people could be invited but
 * could not file anything.
 */

const log = require('../telemetry/log');
const { orgScope } = require('../auth/orgScope');

/**
 * The organisation a project belongs to, for deciding who may be invited, named and file into it. A project
 * that carries none (older projects, and ones made by an account whose organisation only comes from a group,
 * which the session does not hold) is the organisation its owner acts in; only an owner without any
 * organisation leaves it '' — and then only org-less people and groups match.
 *
 * @param {{ organizationId?: string|null, ownerId?: string }|null|undefined} project
 * @returns {Promise<string>}
 */
async function projectOrgOf(project) {
    if (project?.organizationId) return project.organizationId;
    if (!project?.ownerId) return '';
    try {
        const scope = await orgScope({ session: { user: { id: project.ownerId } } });
        return scope.homeOrgId || scope.orgId || '';
    } catch (err) {
        log.warn('[Projects] owner organisation unavailable:', err.message);
        return '';
    }
}

/**
 * Whether a person belongs to the project's organisation: their own, or one a group of theirs is in (a member
 * whose organisation comes from a group has none on the account). An org-less project ('') matches only an
 * org-less person. A failed read refuses rather than guessing.
 *
 * @param {string} userId
 * @param {string} projectOrg  from projectOrgOf
 * @returns {Promise<boolean>}
 */
async function belongsToProjectOrg(userId, projectOrg) {
    const { orgIds } = await orgScope({ session: { user: { id: userId } } }, { strict: true });
    return projectOrg ? orgIds.has(projectOrg) : orgIds.size === 0;
}

/**
 * The organisation an item made in or filed into this project carries: the one the project STORES (what the
 * stores compare on), not the one projectOrgOf resolves for a project that still stores none.
 *
 * @param {{ organizationId?: string|null }} project
 * @param {{ organizationId?: string|null }|null|undefined} user  the creator's account row
 * @returns {string|null}
 */
function itemOrgFor(project, user) {
    return project?.organizationId || user?.organizationId || null;
}

module.exports = { projectOrgOf, belongsToProjectOrg, itemOrgFor };
