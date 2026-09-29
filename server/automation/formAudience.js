/**
 * Who may fill a form in — the one rule behind every gate.
 * (Studio → Forms, automation-form-audience-2026-09.)
 *
 * Pure: no I/O. The visitor gate (routes/automation/formPublic.js's
 * callerMayOpen) and the `canOpen` flag of GET /api/automation/forms both
 * call this, so a form can never be listed as fillable for someone the
 * visitor page then refuses, or the other way round.
 *
 *   audience.audience   'org'        every signed-in member of the owning
 *                                    organisation (the rule since forms
 *                                    stopped being public);
 *                       'restricted' the owner, the people in
 *                                    `sharedUserIds`, the members of the
 *                                    groups in `sharedGroups`.
 *
 * Outside the owning organisation: nobody, whatever the mode. Without an
 * organisation on the owner: the owner alone — lumping every orgless
 * account on a shared install together would be leakier than the public
 * link this replaced. A row from before the column has no `audience` and
 * reads as 'org': the rule it was made under.
 */

'use strict';

const AUDIENCES = Object.freeze(['org', 'restricted']);

/** `callerGroups` are the caller's group ids from a fresh read (auth/audience.resolveUserGroups). */
function audienceAdmits(audience, caller, callerGroups = []) {
    if (!audience || !caller?.id) return false;
    if (caller.id === audience.userId) return true;
    if (!audience.organizationId) return false;
    if (caller.organizationId !== audience.organizationId) return false;
    if (audience.audience !== 'restricted') return true;
    if ((audience.sharedUserIds || []).includes(caller.id)) return true;
    const groups = Array.isArray(callerGroups) ? callerGroups : [];
    return (audience.sharedGroups || []).some(g => groups.includes(g));
}

/** Does deciding for this caller need their group memberships at all? */
function needsGroups(audience, caller) {
    return !!audience && audience.audience === 'restricted'
        && caller?.id !== audience.userId
        && Array.isArray(audience.sharedGroups) && audience.sharedGroups.length > 0;
}

/** What the owner sees of an audience; what everyone else sees is the mode alone. */
function publicAudience(page, { owner = false } = {}) {
    const mode = AUDIENCES.includes(page?.audience) ? page.audience : 'org';
    if (!owner) return { mode };
    return {
        mode,
        groups: Array.isArray(page?.sharedGroups) ? page.sharedGroups : [],
        users: Array.isArray(page?.sharedUserIds) ? page.sharedUserIds : [],
    };
}

module.exports = { AUDIENCES, audienceAdmits, needsGroups, publicAudience };
