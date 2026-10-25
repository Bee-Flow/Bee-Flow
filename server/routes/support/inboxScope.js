// @typecheck noImplicitAny
/**
 * Tenant Support Inbox: who the caller is and what they may reach. The
 * support_inbox permission check, the org scope, the per-inbox access gate
 * (org scope AND group ACL) and the inbox/thread lookups every route funnels
 * through, plus the inbox's reply config and the live event emitter. Split
 * out of routes/supportInbox.js; behaviour unchanged.
 */

const log = require('../../telemetry/log');
const supportInboxStore = require('../../stores/supportInboxStore');
const supportStore = require('../../stores/supportStore');
const { resolveUserOrgIds, hasPermission } = require('../../auth/permissions');
const access = require('../../support/access');
// supportEvents is a shared bus; tenant events carry inboxId so the company
// /api/support/stream skips them and the tenant /stream forwards only in-scope inboxes.
const { supportEvents } = require('../support');
const { bestEffort } = require('../../utils/bestEffort');

/** @param {import('express').Request} req */
function getUserId(req) { return req.session?.user?.id || null; }

/**
 * @param {string} event
 * @param {string} inboxId
 * @param {Record<string, unknown>} [data]
 */
function emitInboxEvent(event, inboxId, data = {}) {
    try { supportEvents.emit('event', { event, data: { ...data, inboxId } }); } catch (err) { bestEffort('routes/support/inboxScope:emitInboxEvent', err); /* an event listener threw, the emit continues */ }
}

/** @param {import('express').Request} req */
async function _hasSupportInbox(req) {
    const uid = getUserId(req);
    if (!uid) return false;
    try {
        return (await hasPermission(uid, 'support_inbox', req.session))
            || (await hasPermission(uid, 'all', req.session));
    } catch (e) {
        log.warn('[SupportInbox] permission check failed:', e.message);
        return false;
    }
}

/**
 * Org ids the caller may act within (super-admins fall back to their own org).
 * @param {import('express').Request} req
 */
async function resolveOrgScope(req) {
    const ids = await resolveUserOrgIds(req);
    if (ids === null) {
        const oid = req.session?.user?.organizationId;
        return oid ? [oid] : [];
    }
    return Array.from(ids);
}

/** @param {NonNullable<Awaited<ReturnType<typeof supportInboxStore.getInbox>>>} inbox */
function inboxToReplyConfig(inbox) {
    return {
        agentId: inbox.default_agent_id || null,
        kbIds: Array.isArray(inbox.kb_ids) ? inbox.kb_ids : [],
        replyMode: inbox.reply_mode || 'draft',
        autoresolveThreshold: Number(inbox.autoresolve_threshold) || 0.78,
        v2Enabled: !!inbox.tools_enabled,
        toolsEnabled: !!inbox.tools_enabled,
        enabledToolIds: Array.isArray(inbox.enabled_tool_ids) ? inbox.enabled_tool_ids : [],
        // Designated operator for integration tools. operatorOrgId is the inbox's
        // own org (the operator is validated to belong to it) — never the
        // requester's org — so integration entitlement gates against the support
        // team, not the customer.
        operatorUserId: inbox.operator_user_id || null,
        operatorOrgId: inbox.organization_id || null,
        // The org whose PUBLISHED knowledge this inbox may quote to a customer.
        // The inbox's own, never the requester's: a logged-in customer from
        // another tenant must not widen what the responder may read.
        orgId: inbox.organization_id || null,
    };
}

/**
 * Per-inbox access gate (org scope AND group ACL). The single source of truth
 * every inbox/thread-reaching route funnels through, so a group-restricted inbox
 * can never be opened by a non-member — not via the inbox list, nor by reaching
 * one of its tickets directly.
 * @param {import('express').Request} req
 * @param {Awaited<ReturnType<typeof supportInboxStore.getInbox>>} inbox
 */
async function userCanAccessInbox(req, inbox) {
    if (!inbox) return false;
    const scope = await resolveOrgScope(req);
    // Super admins are limited to their own org's inboxes (resolveOrgScope falls
    // back to their org); everyone else to their member orgs.
    if (!scope.includes(inbox.organization_id)) return false;
    const { orgIds } = await access.resolveOrgScope(req);
    const [userGroups, isOrgAdmin] = await Promise.all([
        access.resolveUserGroups(req), access.resolveIsOrgAdmin(req),
    ]);
    return access.canUserAccessInbox(inbox, getUserId(req), orgIds, userGroups, { isOrgAdmin });
}

// Resolve + scope/ACL-check an inbox; returns the public row or sends 403/404.
/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {string} id
 * @param {{ withTokens?: boolean }} [opts]
 */
async function loadInboxInScope(req, res, id, { withTokens = false } = {}) {
    const inbox = withTokens
        ? await supportInboxStore.getInboxWithTokens(id)
        : await supportInboxStore.getInbox(id);
    if (!inbox) { res.status(404).json({ error: 'Inbox not found' }); return null; }
    if (!(await userCanAccessInbox(req, inbox))) {
        res.status(403).json({ error: 'You do not have access to this inbox.' }); return null;
    }
    return inbox;
}

// Resolve + scope/ACL-check a thread. Loads the thread's inbox and runs the same
// per-inbox group ACL — closes the cross-inbox-via-thread access gap.
/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {string} id
 */
async function loadThreadInScope(req, res, id) {
    const thread = await supportStore.getThread(id);
    if (!thread || !thread.inbox_id) { res.status(404).json({ error: 'Ticket not found' }); return null; }
    const inbox = await supportInboxStore.getInbox(thread.inbox_id);
    if (!inbox) { res.status(404).json({ error: 'Ticket not found' }); return null; }
    if (!(await userCanAccessInbox(req, inbox))) {
        res.status(403).json({ error: 'You do not have access to this ticket.' }); return null;
    }
    return thread;
}
module.exports = { getUserId, emitInboxEvent, _hasSupportInbox, resolveOrgScope, inboxToReplyConfig, userCanAccessInbox, loadInboxInScope, loadThreadInScope };
