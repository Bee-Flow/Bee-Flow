/**
 * Who a routine notification goes to: the recipients of one event's settings
 * (automation/notificationDefaults.js) as Bee Flow user ids.
 *
 *   owner     the routine's owner (steps run as them; owner decision 4)
 *   approver  whoever the approval asks: the caller hands in the resolved
 *             ids (approvalLifecycle.approvalNotificationTargets). With no
 *             approval in hand (a first-run confirmation, or an error event
 *             someone configured with "the approver") it is the owner, who is
 *             the one who has to act then.
 *   user      one person, only while they are an active member of the
 *             routine's organisation
 *   group     the active members of the organisation in that group
 *
 * The organisation check is the point of this module. A routine name and a
 * link are all a notification carries, but they must not reach someone
 * outside the organisation because a definition names their id; so a user or
 * group is resolved against the organisation's members, never taken on trust.
 * A routine without an organisation reaches its owner and approvers only.
 *
 * Pure apart from the injected `listUsers`.
 */

'use strict';

/** Hard cap on one message's fan-out, whatever the groups hold. */
const MAX_RECIPIENT_IDS = 50;

function groupsOf(user) {
    const raw = user?.groups;
    if (Array.isArray(raw)) return raw.map(String);
    if (typeof raw === 'string') {
        try {
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed.map(String) : [];
        } catch { return []; }
    }
    return [];
}

function isActive(user) {
    return !user?.status || user.status === 'active';
}

/**
 * @param {{ recipients?: Array<{ type: string, id?: string }> }} eventSettings
 * @param {{ automation: { userId: string }, orgId?: string|null, approverIds?: string[]|null }} ctx
 * @param {{ listUsers?: () => Promise<Array<{ id: string, organizationId?: string, groups?: any, status?: string }>> }} [deps]
 * @returns {Promise<string[]>} distinct user ids, in recipient order, capped
 */
async function resolveRecipientIds(eventSettings, { automation, orgId = null, approverIds = null }, deps = {}) {
    const out = [];
    const seen = new Set();
    const add = (id) => {
        if (!id || seen.has(String(id)) || out.length >= MAX_RECIPIENT_IDS) return;
        seen.add(String(id));
        out.push(String(id));
    };

    const recipients = Array.isArray(eventSettings?.recipients) ? eventSettings.recipients : [];
    const needsMembers = !!orgId && recipients.some(r => r && (r.type === 'user' || r.type === 'group'));
    let members = [];
    if (needsMembers && typeof deps.listUsers === 'function') {
        try {
            members = (await deps.listUsers()).filter(u => u && String(u.organizationId || '') === String(orgId) && isActive(u));
        } catch { members = []; }
    }

    for (const r of recipients) {
        if (!r || typeof r !== 'object') continue;
        if (r.type === 'owner') add(automation?.userId);
        else if (r.type === 'approver') {
            if (Array.isArray(approverIds) && approverIds.length) approverIds.forEach(add);
            else add(automation?.userId);
        } else if (r.type === 'user') {
            if (r.id === automation?.userId) add(r.id);
            else if (members.some(u => String(u.id) === String(r.id))) add(r.id);
        } else if (r.type === 'group') {
            for (const u of members) {
                if (groupsOf(u).includes(String(r.id))) add(u.id);
            }
        }
    }
    return out;
}

/**
 * The people a routine's daily summary goes to: its owner plus every named
 * user and group of an enabled event. "The approver" is not a standing
 * person, so it does not subscribe anyone to a summary.
 */
async function resolveDigestRecipientIds(settings, ctx, deps = {}) {
    const recipients = [{ type: 'owner' }];
    for (const event of ['onError', 'onApproval', 'onSuccess']) {
        const ev = settings?.[event];
        if (!ev?.enabled) continue;
        for (const r of ev.recipients || []) {
            if (r && (r.type === 'user' || r.type === 'group')) recipients.push(r);
        }
    }
    return resolveRecipientIds({ recipients }, { ...ctx, approverIds: null }, deps);
}

module.exports = { resolveRecipientIds, resolveDigestRecipientIds, MAX_RECIPIENT_IDS, _recipientsTest: { groupsOf } };
