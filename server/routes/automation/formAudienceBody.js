// @typecheck strict
/**
 * Who may fill a form in, as a request states it: the body of PUT
 * /forms/:automationId/audience and of the test link's PUT .../test-link/audience
 * (routes/automation/forms.js, formTestLink.js), and its check against the
 * caller's organisation. Light on purpose: no store is required until a body
 * names a group or a person.
 */
'use strict';

const { z, typeError } = require('../../utils/zod');
const { worded } = require('../../core/http/schemaParts');
const { AUDIENCES } = require('../../automation/formAudience');

const AUDIENCE_TEXT = `audience is one of: ${AUDIENCES.join(', ')}.`;
/**
 * @param {string} what
 */
const ID_IN_LIST = (what) => worded(`Each ${what} must be a non-empty id.`).trim().min(1, `Each ${what} must be a non-empty id.`);
const AudienceBody = z.object({
    audience: z.enum(AUDIENCES, { error: () => AUDIENCE_TEXT }),
    sharedGroups: z.array(ID_IN_LIST('group'), { error: typeError({ invalid: 'sharedGroups is a list of group ids.' }) })
        .max(200, 'Too many people or groups on one form.').default([]),
    // The route asks the directory about each id, so the same id twice is the
    // same question twice.
    sharedUserIds: z.array(ID_IN_LIST('person'), { error: typeError({ invalid: 'sharedUserIds is a list of user ids.' }) })
        .max(500, 'Too many people or groups on one form.')
        .transform((ids) => [...new Set(ids)]).prefault([]),
}).strict();

/**
 * The audience a PUT may set: a mode, organisation groups that exist, and
 * people who are members of the same organisation. Anything else is the
 * caller's mistake (400), never silently dropped — a person who thinks they
 * shared a form with Finance must not find out otherwise from Finance.
 * @param {{ audience: string, sharedGroups: string[], sharedUserIds: string[] }} body  AudienceBody's output
 * @param {string | null} orgId
 * @returns {Promise<{ audience: string, sharedGroups: string[], sharedUserIds: string[] }>}
 */
async function readAudienceBody(body, orgId) {
    /**
     * @param {string} code
     * @param {string} message
     */
    const bad = (code, message) => Object.assign(new Error(message), { status: 400, code });
    const { audience: mode, sharedGroups: groupsRaw, sharedUserIds: usersRaw } = body;
    if (!orgId) {
        if (groupsRaw.length || usersRaw.length) throw bad('audience_no_org', 'Cannot share a form: this account has no organisation.');
        return { audience: mode, sharedGroups: [], sharedUserIds: [] };
    }
    const { validateSharedGroupsForOrg } = require('../../auth/permissions');
    const sharedGroups = (await validateSharedGroupsForOrg(orgId, groupsRaw)) || [];
    const userStore = require('../../stores/userStore');
    /** @type {string[]} */
    const sharedUserIds = [];
    for (const id of usersRaw) {
        const u = await userStore.getUser(id);
        if (!u || u.organizationId !== orgId) throw bad('audience_user_unknown', `"${id}" is not a member of this organisation.`);
        sharedUserIds.push(id);
    }
    return { audience: mode, sharedGroups, sharedUserIds };
}

module.exports = { AudienceBody, readAudienceBody };
