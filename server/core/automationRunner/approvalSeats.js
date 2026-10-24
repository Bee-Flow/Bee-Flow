/**
 * Who sits on an approval: the org gate every assignee, panel seat and stage
 * seat passes through, and the recipient lists their notifications reach.
 * Extracted from ./approvalLifecycle.js, which re-exports it.
 */

'use strict';

const log = require('../../telemetry/log');

/** How many members of an assigned group get a bell before we stop. */
const GROUP_NOTIFY_CAP = 25;

/**
 * Validate the assignee against the owner's org. Defence in depth — save-time
 * validation exists, but definitions also arrive via import and raw API.
 * Invalid → null (owner-only), with a warn: silently assigning outside the
 * org would leak the approval's existence to a stranger.
 */
async function validateAssignee(assignee, orgId) {
    if (!assignee || !orgId) return assignee && !orgId ? null : assignee ?? null;
    try {
        const userStore = require('../../stores/userStore');
        if (assignee.userId) {
            const u = await userStore.getUser(assignee.userId);
            const { isMemberOfOrg } = require('../../auth/orgMembership');
            if (u && isMemberOfOrg(u, await userStore.getAllGroups(), orgId)) return { userId: assignee.userId };
            log.warn(`[ApprovalLifecycle] assignee user ${assignee.userId} is not in org ${orgId} — falling back to owner`);
            return null;
        }
        if (assignee.groupId) {
            const groups = await userStore.getAllGroups();
            const g = groups.find(x => String(x.id) === String(assignee.groupId));
            if (g && String(g.organizationId || '') === String(orgId)) return { groupId: assignee.groupId };
            log.warn(`[ApprovalLifecycle] assignee group ${assignee.groupId} is not in org ${orgId} — falling back to owner`);
            return null;
        }
    } catch (e) {
        log.warn(`[ApprovalLifecycle] assignee validation failed: ${e.message} — falling back to owner`);
    }
    return null;
}

/**
 * Members of a group, capped. JS-side scan because users.groups is a JSON
 * TEXT column — there is no join to write. Stable user-id order so the same
 * 25 people are notified every time, not a lottery.
 */
async function groupMemberIds(groupId, cap = GROUP_NOTIFY_CAP) {
    const userStore = require('../../stores/userStore');
    const { parseGroupIds } = require('../../auth/orgMembership');
    const users = await userStore.getAllUsers();
    const members = users
        .filter(u => parseGroupIds(u).map(String).includes(String(groupId)))
        .map(u => u.id)
        .sort();
    if (members.length > cap) {
        log.warn(`[ApprovalLifecycle] group ${groupId} has ${members.length} members — notifying the first ${cap}`);
    }
    return { ids: members.slice(0, cap), total: members.length };
}

/**
 * Validate a PANEL: each seat through the same org gate as the assignee,
 * invalid seats dropped (never silently kept — a stranger's seat would leak
 * the approval), deduped, capped at 10. An empty result means no panel —
 * the caller falls back to single-assignee/owner semantics.
 */
async function validatePanel(approvers, orgId) {
    if (!Array.isArray(approvers) || !approvers.length) return null;
    const seen = new Set();
    const seats = [];
    for (const raw of approvers.slice(0, 10)) {
        const seat = await validateAssignee(raw, orgId);
        if (!seat) continue;
        const key = seat.userId ? `u:${seat.userId}` : `g:${seat.groupId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        seats.push(seat);
    }
    return seats.length ? seats : null;
}

/**
 * Validate a STAGE CHAIN: every seat of every stage through the same org gate
 * as the assignee. Two rules make the result trustworthy rather than merely
 * tidy:
 *
 *   1. An invalid seat is dropped — silently keeping a stranger's seat would
 *      leak the approval's existence and hand them a vote.
 *   2. A stage that loses ALL its seats falls back to the OWNER, it is never
 *      removed. Dropping it would silently delete a required approval — the
 *      invoice that was supposed to reach Finance would sail past it — and a
 *      chain that quietly got shorter is exactly the failure a stage chain
 *      exists to prevent. The owner can always legitimately decide, so the
 *      link stays in the chain and someone real is asked.
 *
 * Skipped stages (their `when` was false at request time) keep their seats as
 * authored: nobody is asked, and the record still answers "who would have
 * been?".
 */
async function validateStages(stages, orgId, ownerId) {
    if (!Array.isArray(stages) || !stages.length) return null;
    const out = [];
    for (const stage of stages) {
        if (!stage || typeof stage !== 'object') continue;
        if (stage.skipped) { out.push(stage); continue; }
        const seats = await validatePanel(stage.approvers, orgId);
        if (seats) {
            out.push({
                ...stage,
                approvers: seats,
                // Quorum is re-clamped: dropping an out-of-org seat from a
                // "3 of 4" stage must not leave a stage that needs 3 votes
                // from 2 people and can never pass.
                quorum: stage.rule === 'quorum'
                    ? Math.min(Math.max(Math.round(Number(stage.quorum)) || 1, 1), seats.length)
                    : null,
            });
        } else {
            log.warn(`[ApprovalLifecycle] stage "${stage.key}" has no approver inside org ${orgId} — falling back to the owner`);
            out.push({ ...stage, approvers: [{ userId: ownerId }], rule: 'first', quorum: null });
        }
    }
    return out.some(st => !st.skipped) ? out : null;
}

/**
 * Everyone a panel-stage notification reaches: each seat's person, or each
 * group seat's members — capped overall so a huge org group cannot turn one
 * request into a notification storm.
 */
async function panelRecipientIds(approvers, cap = GROUP_NOTIFY_CAP) {
    const out = new Set();
    for (const seat of Array.isArray(approvers) ? approvers : []) {
        if (out.size >= cap) break;
        if (seat?.userId) out.add(seat.userId);
        else if (seat?.groupId) {
            try {
                for (const id of (await groupMemberIds(seat.groupId, cap)).ids) {
                    if (out.size >= cap) break;
                    out.add(id);
                }
            } catch (err) { log.debug('the other seats still hear about it', err); }
        }
    }
    return [...out];
}

module.exports = {
    GROUP_NOTIFY_CAP,
    validateAssignee,
    groupMemberIds,
    validatePanel,
    validateStages,
    panelRecipientIds,
};
