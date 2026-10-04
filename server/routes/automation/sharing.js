/**
 * Who may do what with one automation (Studio → Automations handoff 5).
 *
 *   GET  /:id/shares          the owner, the shares, who steps run as
 *   PUT  /:id/shares          replace the share list (owner or org admin)
 *   POST /:id/transfer-owner  hand the automation to someone who may edit it
 *
 * What each role allows is automation/access.js. This file only reads and
 * writes the list, and it follows the datatable sharing rules
 * (routes/datatables/sharing.js) for the licence:
 *
 *   - ADDING a person or group, or giving someone a STRONGER role, is the paid
 *     collaboration line (`automation_sharing`, Enterprise). Without it the
 *     answer is the standard 403 `feature_locked` body.
 *   - REMOVING a share, or lowering one, is never gated: taking access away
 *     must always be possible, also after a licence lapse.
 *
 * Steps keep running as the OWNER (owner decision 4, no service account), so
 * `runsAs` is always the owner. "Change" in the UI is the transfer below, and
 * the new owner has to be someone who may already edit the automation (an `edit`
 * share, directly or through a group) or an org admin with manage_automations.
 * The previous owner keeps `edit` (stores/automationStore/shares.js).
 *
 * Built by a factory so a test can hand in its own store, user lookups and
 * licence gate; the default router uses the real ones, required lazily.
 */

'use strict';

const express = require('express');
const { z } = require('zod');
const log = require('../../telemetry/log');
const { validate } = require('../../core/http/validate');
const { HttpError } = require('../../core/http/errors');
const { makeAutomationAccess, projectForViewer, RANK } = require('../../automation/access');

const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

const PRINCIPAL_TYPE_TEXT = 'principalType is "user" or "group".';
const ROLE_TEXT = 'role is "run", "view" or "edit".';
const PRINCIPAL_ID_TEXT = 'principalId is the id of a person or a group.';

const ShareEntry = z.object({
    principalType: z.enum(['user', 'group'], { errorMap: () => ({ message: PRINCIPAL_TYPE_TEXT }) }),
    principalId: worded(PRINCIPAL_ID_TEXT).trim().min(1, PRINCIPAL_ID_TEXT).max(200, PRINCIPAL_ID_TEXT),
    role: z.enum(['run', 'view', 'edit'], { errorMap: () => ({ message: ROLE_TEXT }) }),
}).strict();

const SharesBody = z.object({
    shares: z.array(ShareEntry, {
        required_error: 'shares is the full list of people and groups, [] for none.',
        invalid_type_error: 'shares is the full list of people and groups, [] for none.',
    }).max(200, 'At most 200 people and groups on one automation.'),
}).strict();

const TRANSFER_TEXT = 'userId is the id of the person who becomes the owner.';
const TransferBody = z.object({
    userId: worded(TRANSFER_TEXT).trim().min(1, TRANSFER_TEXT),
}).strict();

const keyOf = (s) => `${s.principalType}:${s.principalId}`;
const nameOf = (u) => (u ? (u.displayName || u.username || null) : null);

/**
 * @param {object} [overrides]
 * @param {object} [overrides.store]            automationStore surface
 * @param {Function} [overrides.getUser]        (id) => user row
 * @param {Function} [overrides.getGroup]       (id) => group row
 * @param {Function} [overrides.hasPermission]  (userId, perm, session) => bool
 * @param {Function} [overrides.validateGroups] (orgId, ids) => ids (throws 400)
 * @param {Function} [overrides.sharingGate]    Express middleware for `automation_sharing`
 * @param {Function} [overrides.sharingAvailable] async (req) => bool
 * @param {object} [overrides.subscriptions]    { revokeRemoteSubscriptions, syncAppEventSubscription, hasAppEventTrigger }
 */
function makeSharingRouter(overrides = {}) {
    const router = express.Router();
    const store = () => overrides.store || require('../../stores/automationStore');
    const getUser = overrides.getUser || ((id) => require('../../stores/userStore').getUser(id));
    const getGroup = overrides.getGroup || ((id) => require('../../stores/userStore').getGroup(id));
    const validateGroups = overrides.validateGroups
        || ((orgId, ids) => require('../../auth/permissions').validateSharedGroupsForOrg(orgId, ids));
    const subscriptions = () => overrides.subscriptions || require('../../automation/subscriptionSync');
    const access = makeAutomationAccess({
        store: overrides.store,
        getUser,
        ...(overrides.hasPermission ? { hasPermission: overrides.hasPermission } : {}),
    });

    let defaultGate = null;
    const sharingGate = overrides.sharingGate || ((req, res, next) => {
        if (!defaultGate) defaultGate = require('../../core/entitlements/entitlements').requireCapability('automation_sharing');
        return defaultGate(req, res, next);
    });
    const sharingAvailable = overrides.sharingAvailable || (async (req) => {
        try {
            const { hasCapability } = require('../../core/entitlements/entitlements');
            return await hasCapability('automation_sharing', {
                userId: req.session?.user?.id || null,
                orgId: req.session?.user?.organizationId || null,
                session: req.session,
                req,
            });
        } catch { return false; }
    });

    async function loadAutomation(req, res, need) {
        const a = await store().getAutomation(req.params.id);
        if (!a) { res.status(404).json({ error: 'Not found' }); return null; }
        const acc = await access.guard(req, res, a, need);
        if (!acc) return null;
        return { a, acc };
    }

    /** The GET answer, also returned after a PUT so the dialog redraws from it. */
    async function describe(a, orgId, shares) {
        const owner = await getUser(a.userId).catch(() => null);
        const ownerRef = { userId: a.userId, name: nameOf(owner) };
        const groupIds = shares.filter(s => s.principalType === 'group').map(s => s.principalId);
        let counts = new Map();
        if (groupIds.length && orgId) {
            try { counts = await store().countGroupMembers(orgId, groupIds); }
            catch (e) { log.warn(`[automation sharing] member count failed for ${a.id}: ${e.message}`); }
        }
        const described = [];
        for (const s of shares) {
            if (s.principalType === 'user') {
                const u = await getUser(s.principalId).catch(() => null);
                described.push({
                    principalType: 'user', principalId: s.principalId, role: s.role,
                    name: nameOf(u), ...(u ? {} : { missing: true }),
                });
            } else {
                const g = await Promise.resolve(getGroup(s.principalId)).catch(() => null);
                described.push({
                    principalType: 'group', principalId: s.principalId, role: s.role,
                    name: g?.name || null,
                    ...(counts.has(s.principalId) ? { memberCount: counts.get(s.principalId) } : (g ? { memberCount: 0 } : {})),
                    ...(g ? {} : { missing: true }),
                });
            }
        }
        return { owner: ownerRef, runsAs: ownerRef, shares: described };
    }

    // ── GET /:id/shares ─────────────────────────────────────────────────
    router.get('/:id/shares', async (req, res) => {
        const loaded = await loadAutomation(req, res, 'view');
        if (!loaded) return;
        const { a, acc } = loaded;
        const orgId = await access.organisationOf(a);
        const shares = await store().listSharesForAutomation(a.id);
        const body = await describe(a, orgId, shares);
        res.json({
            ...body,
            myRole: acc.role,
            canManage: acc.role === 'owner',
            sharingAvailable: !!(await sharingAvailable(req)),
        });
    });

    // ── PUT /:id/shares ─────────────────────────────────────────────────
    // Three steps so the licence gate is the real requireCapability
    // middleware, run only when the new list gives someone MORE access.
    router.put('/:id/shares',
        validate({ body: SharesBody }),
        async (req, res, next) => {
            const loaded = await loadAutomation(req, res, 'owner');
            if (!loaded) return;
            const { a, acc } = loaded;
            const wanted = req.body.shares;

            const seen = new Set();
            for (const s of wanted) {
                if (seen.has(keyOf(s))) throw new HttpError(400, 'duplicate_share', `${s.principalType === 'user' ? 'That person' : 'That group'} is on the list twice.`);
                seen.add(keyOf(s));
                if (s.principalType === 'user' && s.principalId === a.userId) {
                    throw new HttpError(400, 'share_with_owner', 'The owner already has full access; leave them off the list.');
                }
            }

            const orgId = await access.organisationOf(a);
            if (wanted.length && !orgId) {
                throw new HttpError(400, 'no_organisation', 'This automation has no organisation, so it cannot be shared.');
            }
            for (const s of wanted.filter(x => x.principalType === 'user')) {
                const u = await getUser(s.principalId).catch(() => null);
                if (!u || u.organizationId !== orgId) {
                    throw new HttpError(400, 'share_user_unknown', 'Someone on the list is not a member of this organisation.');
                }
            }
            const groupIds = wanted.filter(x => x.principalType === 'group').map(x => x.principalId);
            if (groupIds.length) {
                try { await validateGroups(orgId, groupIds); }
                catch (e) {
                    if (e?.status === 400) throw new HttpError(400, 'share_group_unknown', 'A group on the list is not a group of this organisation.');
                    throw e;
                }
            }

            const existing = await store().listSharesForAutomation(a.id);
            const before = new Map(existing.map(s => [keyOf(s), s.role]));
            const widens = wanted.some(s => !before.has(keyOf(s)) || RANK[s.role] > RANK[before.get(keyOf(s))]);
            req.automationShares = { a, acc, orgId, wanted, widens };
            next();
        },
        (req, res, next) => (req.automationShares.widens ? sharingGate(req, res, next) : next()),
        async (req, res) => {
            const { a, acc, orgId, wanted } = req.automationShares;
            const saved = await store().replaceSharesForAutomation(a.id, wanted, req.session.user.id);
            log.info(`[automation sharing] ${a.id} shares set to ${saved.length} entr${saved.length === 1 ? 'y' : 'ies'} by ${req.session.user.id}`);
            const body = await describe(a, orgId, saved);
            res.json({
                ...body,
                myRole: acc.role,
                canManage: true,
                sharingAvailable: !!(await sharingAvailable(req)),
            });
        });

    // ── POST /:id/transfer-owner ────────────────────────────────────────
    router.post('/:id/transfer-owner', validate({ body: TransferBody }), async (req, res) => {
        const loaded = await loadAutomation(req, res, 'owner');
        if (!loaded) return;
        const { a } = loaded;
        const me = req.session.user.id;
        const targetId = req.body.userId;
        if (targetId === a.userId) throw new HttpError(400, 'already_owner', 'That person already owns this automation.');

        const orgId = await access.organisationOf(a);
        const target = await getUser(targetId).catch(() => null);
        if (!target || !orgId || target.organizationId !== orgId) {
            throw new HttpError(400, 'transfer_target_unknown', 'That person is not a member of this organisation.');
        }
        const targetAccess = await access.roleFor(a, targetId);
        const mayOwn = targetAccess.via === 'admin' || (targetAccess.via === 'share' && targetAccess.role === 'edit');
        if (!mayOwn) {
            throw new HttpError(400, 'transfer_target_not_editor', 'Only someone who may edit this automation can become its owner. Give them "Can edit" first.');
        }

        const fromUserId = a.userId;
        const moved = await store().transferAutomationOwner(a.id, { fromUserId, toUserId: targetId, byUserId: me });
        if (!moved) throw new HttpError(409, 'owner_changed', 'The owner of this automation changed in the meantime. Reload and try again.');

        const warnings = [];
        // App-event subscriptions carry the OWNER's id and use their connected
        // account; dispatch skips a subscription that belongs to anyone else.
        // An active automation is re-registered under the new owner from the copy
        // that runs.
        if (moved.isActive) {
            try {
                const { definitionForRun } = require('../../core/automationRunner/definitionForRun');
                const liveDef = moved.liveVersion != null ? definitionForRun(moved, { mode: 'live' }).definition : (moved.definition || {});
                const subs = subscriptions();
                if (subs.hasAppEventTrigger(liveDef)) {
                    await subs.revokeRemoteSubscriptions(a.id, fromUserId);
                    await store().deleteSubscriptionsForAutomation(a.id);
                    await subs.syncAppEventSubscription(a.id, targetId, liveDef);
                }
            } catch (e) {
                log.warn(`[automation sharing] subscription re-sync after transfer failed for ${a.id}: ${e.message}`);
                warnings.push({
                    code: 'transfer.subscription_resync_failed', params: {},
                    message: 'The automation could not re-connect its event trigger for the new owner. Pause it and switch it on again.',
                });
            }
        }
        log.info(`[automation sharing] ${a.id} ownership moved from ${fromUserId} to ${targetId} by ${me}`);

        const newOwner = { userId: targetId, name: nameOf(target) };
        const mine = await access.roleFor(moved, me, { session: req.session });
        res.json({
            automation: projectForViewer(moved, mine),
            owner: newOwner,
            runsAs: newOwner,
            warnings,
        });
    });

    // ── GET /:id/principals ─────────────────────────────────────────────
    // The people and groups of the automation's organisation, for the sharing
    // dialog and the notification recipients. Scoped to the AUTOMATION (not the
    // caller's session org) and readable by anyone who may see it: the admin
    // lists (/auth/users, /auth/groups) are admin-only, and the approvals
    // directory sits behind the approvals licence. Minimal fields only, the
    // getOrgMembersForDirectory precedent: id and name, never an e-mail.
    const listMembers = overrides.listMembers
        || ((orgId) => require('../../stores/userStore').getOrgMembersForDirectory(orgId));
    const listGroups = overrides.listGroups
        || (() => require('../../stores/userStore').getAllGroups());
    router.get('/:id/principals', async (req, res) => {
        const loaded = await loadAutomation(req, res, 'view');
        if (!loaded) return;
        const orgId = await access.organisationOf(loaded.a);
        if (!orgId) return res.json({ users: [], groups: [] });
        const members = await Promise.resolve(listMembers(orgId)).catch(() => []);
        const orgGroups = (await Promise.resolve(listGroups()).catch(() => []))
            .filter(g => String(g.organizationId || '') === String(orgId));
        let counts = new Map();
        if (orgGroups.length) {
            try { counts = await store().countGroupMembers(orgId, orgGroups.map(g => String(g.id))); }
            catch (e) { log.warn(`[automation sharing] member count failed for ${loaded.a.id}: ${e.message}`); }
        }
        res.json({
            users: (members || []).map(u => ({ id: String(u.id), name: nameOf(u) || String(u.id) })),
            groups: orgGroups.map(g => ({
                id: String(g.id), name: g.name || String(g.id), memberCount: counts.get(String(g.id)) ?? 0,
            })),
        });
    });

    return router;
}

module.exports = { makeSharingRouter, SharesBody, TransferBody };
