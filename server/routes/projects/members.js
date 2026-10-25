/**
 * Who is on a project, and how people join, change role, leave or take it over.
 *
 *   POST   /:id/share                 share with user/group         (editor+, narrowed in the handler)
 *   DELETE /:id/share/:shareId        unshare                       (owner)
 *   GET    /:id/members               list owner + members          (viewer+)
 *   GET    /:id/principals            who can be invited            (viewer+)
 *   PUT    /:id/members/:memberId     change a member's role        (owner)
 *   POST   /:id/transfer-owner        hand the project to a member  (owner, or an org admin)
 *   DELETE /:id/members/:memberId     remove a member or self-leave (owner OR self; the owner cannot leave)
 *   GET    /:id/avatars/:userId       a member's uploaded picture   (viewer+)
 *
 * Members are project_shares; "owner" is implicit via projects.owner_id.
 *
 * Moved here unchanged from routes/projects.js. A FACTORY router:
 * `makeMembersRouter(deps)` takes the stores, the role gate and the change
 * feed, so routes/projects.js mounts it over the same handles its route tests
 * replace (routes/projects.authz.test.js and friends), at the same place in
 * the route table (routes/projects.routetable.test.js).
 */

'use strict';

const express = require('express');
const log = require('../../telemetry/log');
const { validate } = require('../../core/http/validate');
const { HttpError, notFound } = require('../../core/http/errors');
const S = require('./schemas');
const { isOrgAdminForOrg } = require('../../auth/admin/orgAdminGuards');
const { displayNameOf } = require('../../core/documents/documentPeople');
const { projectOrgOf, belongsToProjectOrg } = require('../../projects/projectOrg');
// Something a project compliance check reads changed (ids only).
const { signalProjectChanged } = require('./complianceSignal');
const { memberAvatar, makeMemberDirectory } = require('./memberDirectory');
const { fallback } = require('../../utils/bestEffort');

/**
 * @param {object} deps
 * @param {Function} deps.requireProjectRole   (minRole, opts?) => middleware named requireProjectRoleMw
 * @param {object}   deps.projectStore         stores/projectStore
 * @param {object}   deps.userStore            stores/userStore
 * @param {Function} deps.getUserId            (req) => the caller's user id
 * @param {Function} deps.resolveUserGroups    (userId) => Promise<groupIds>
 * @param {Function} deps.recordProjectChange  projects/changeFeed recordProjectChange
 * @param {object}   deps.collabNotifier       projects/collabNotify makeCollabNotifier()
 * @param {Function} deps.perUserRateLimit     utils/perUserRateLimit perUserRateLimit
 */
function makeMembersRouter(deps) {
    const router = express.Router();
    const {
        projectStore, userStore, getUserId, resolveUserGroups, recordProjectChange, collabNotifier, perUserRateLimit,
    } = deps;
    const requireRole = deps.requireProjectRole;
    const { describeMembers } = makeMemberDirectory({ userStore });

    // The bell for membership changes. Best effort: the change stands whether or not anyone is told.
    /**
     * @param {string} what
     */
    async function tellCollab(what, send) {
        try { await send(collabNotifier); } catch (err) {
            log.warn(`[Projects] ${what} not notified: ${err && /** @type {Error} */ (err).message}`);
        }
    }

    // Single shared budget across all membership mutations (invite / role change /
    // removal / unshare). Keeps a runaway client or accidental spam loop from
    // flooding the activity log without rejecting reasonable interactive use.
    const memberMutationLimiter = perUserRateLimit({ windowMs: 60_000, max: 30 });

    // ── Shares (legacy) — kept for back-compat, aliased to /members semantics ──

    // POST /:id/share — share with user or group. The owner always; an editor only
    // while the project allows it (editorsCanInvite), only as viewer or editor, and
    // never over someone already on the project (that is a role change: owner only).
    router.post('/:id/share', memberMutationLimiter, requireRole('editor'), validate({ body: S.ShareBody }), async (req, res) => {
        const userId = getUserId(req);
        const { sharedWithType, sharedWithId, permission } = req.body;
        if (!sharedWithType || !sharedWithId) return res.status(400).json({ error: 'sharedWithType and sharedWithId required' });
        if (!['user', 'group'].includes(sharedWithType)) return res.status(400).json({ error: 'sharedWithType must be user or group' });

        const role = projectStore.normalizePermission(permission || 'viewer');
        if (!['viewer', 'editor'].includes(role)) return res.status(400).json({ error: 'permission must be viewer or editor' });

        // Cross-tenant guard: an owner could otherwise share their project
        // with a foreign-org group/user ID and leak project content + KB IDs
        // to members of another tenant. Match the target's org against the
        // project's org before persisting.
        // The guards used to be conditional on both org ids being truthy, which
        // meant they never ran for an org-less project — and projects.organization_id
        // DEFAULTS TO '' (self-host, consumer and admin-created projects all land
        // there). An owner could then share with any user or group id in any tenant.
        // Compare normalised values instead: '' is a real bucket, and only an
        // equally org-less counterpart matches it.
        const project = await projectStore.getProject(req.params.id);
        if (!project) throw notFound();
        if (req.projectRole !== 'owner') {
            if (!project.editorsCanInvite) {
                throw new HttpError(403, 'invite_not_allowed', 'The owner has not allowed editors to invite people.');
            }
            const existing = (await projectStore.getProjectShares(req.params.id))
                .some(s => s.sharedWithType === sharedWithType && s.sharedWithId === sharedWithId);
            if (existing) throw new HttpError(403, 'owner_only_role_change', 'Only the owner can change the role of someone already on the project.');
        }
        const projectOrg = await projectOrgOf(project);
        if (sharedWithType === 'group') {
            const targetGroup = await userStore.getGroup(sharedWithId);
            if (!targetGroup || targetGroup.id !== sharedWithId) return res.status(400).json({ error: 'Unknown group' });
            if ((targetGroup.organizationId || '') !== projectOrg) {
                return res.status(400).json({ error: 'Group does not belong to this project\'s organisation' });
            }
        } else if (sharedWithType === 'user') {
            const targetUser = await userStore.getUser(sharedWithId);
            if (!targetUser) return res.status(400).json({ error: 'Unknown user' });
            if (!await belongsToProjectOrg(targetUser.id, projectOrg)) {
                return res.status(400).json({ error: 'User does not belong to this project\'s organisation' });
            }
        }

        const shareId = await projectStore.shareProject(req.params.id, sharedWithType, sharedWithId, role, userId);
        await recordProjectChange(req.params.id, userId, 'member_added', {
            targetType: sharedWithType, targetId: sharedWithId, role,
        });
        signalProjectChanged(project, 'members');
        await tellCollab('share', (n) => n.added({ project, actorId: userId, sharedWithType, sharedWithId, role }));
        const shares = await projectStore.getProjectShares(req.params.id);
        res.json({ shareId, shares });
    });

    // DELETE /:id/share/:shareId — remove share (owner only)
    router.delete('/:id/share/:shareId', memberMutationLimiter, requireRole('owner'), async (req, res) => {
        const userId = getUserId(req);
        const share = await projectStore.getShareById(req.params.shareId);
        // Guard against IDOR: confirm the share actually belongs to this project,
        // otherwise an owner of project A could delete shares from project B.
        if (!share || share.projectId !== req.params.id) {
            return res.status(404).json({ error: 'Member not found' });
        }
        const ok = await projectStore.unshareProject(req.params.shareId);
        await recordProjectChange(req.params.id, userId, 'member_removed', {
            targetType: share.sharedWithType, targetId: share.sharedWithId,
        });
        const projectNow = await projectStore.getProject(req.params.id);
        if (ok) signalProjectChanged(projectNow, 'members');
        if (ok && projectNow && share.sharedWithType === 'user') {
            await tellCollab('removal', (n) => n.removed({ project: projectNow, actorId: userId, userId: share.sharedWithId }));
        }
        const shares = await projectStore.getProjectShares(req.params.id);
        res.json({ success: ok, shares });
    });

    // ── Members API ──────────────────────────────────────────

    // GET /:id/members — owner + members list (viewer+), with names for the
    // people and groups of the project's own organisation (see describeMembers).
    router.get('/:id/members', requireRole('viewer'), async (req, res) => {
        const project = await projectStore.getProject(req.params.id);
        if (!project) throw notFound();
        const shares = await projectStore.getProjectShares(req.params.id);
        const { people, groups } = await describeMembers(project, shares);
        // The colour the project gave each person (none: the client picks the automatic one).
        try {
            const colors = await require('../../stores/projectMemberColorStore').listColors(project.id);
            for (const [id, person] of Object.entries(people)) if (colors[id]) person.color = colors[id];
        } catch (err) {
            log.warn('[Projects] member colours unavailable:', /** @type {Error} */ (err).message);
        }
        // The organisation the project belongs to ('' for none): only its own people and groups can be invited,
        // so the invite picker offers no others (a platform admin's directory lists every organisation).
        res.json({ ownerId: project.ownerId, organizationId: await projectOrgOf(project), members: shares, people, groups });
    });

    // GET /:id/principals — who can be invited (viewer+): people and groups of the project's own organisation,
    // `q` a case-insensitive part of the name (2+ characters). Id, name and avatar only, never an e-mail address
    // (the getOrgMembersForDirectory precedent, routes/automation/sharing.js). One-segment-deeper than `/:id`,
    // so nothing above can swallow it.
    const PRINCIPALS_MAX = 20;
    router.get('/:id/principals', requireRole('viewer'), validate({ query: S.PrincipalsQuery }), async (req, res) => {
        const project = await projectStore.getProject(req.params.id);
        if (!project) throw notFound();
        const orgId = await projectOrgOf(project);
        if (!orgId) return res.json({ users: [], groups: [] });
        const needle = String(req.query.q || '').trim().toLowerCase();
        const matches = (label) => !needle || String(label).toLowerCase().includes(needle);

        const members = await Promise.resolve(userStore.getOrgMembersForDirectory(orgId)).catch((err) => {
            log.warn('[Projects] principals: directory unavailable:', err.message);
            return [];
        });
        const people = (members || [])
            // The fallback chain ends in the username, which an SSO login makes an e-mail address: never let one out.
            .map(u => { const label = displayNameOf(u); return { row: u, name: label && !String(label).includes('@') ? label : String(u.id) }; })
            .filter(p => matches(p.name))
            .slice(0, PRINCIPALS_MAX);

        // The directory carries no picture itself: one batched read over the people on screen.
        const pictures = new Map();
        if (people.length && typeof userStore.getUserAvatarsByIds === 'function') {
            try {
                for (const r of await userStore.getUserAvatarsByIds(people.map(p => p.row.id))) pictures.set(String(r.id), r);
            } catch (err) { log.warn('[Projects] principals: avatars unavailable:', /** @type {Error} */ (err).message); }
        }
        const users = people.map(({ row, name }) => {
            const picture = pictures.has(String(row.id)) ? memberAvatar(project.id, String(row.id), pictures.get(String(row.id))) : null;
            return { id: String(row.id), name, avatar: picture ? { type: picture.avatarType, value: picture.avatar } : null };
        });

        const orgGroups = (await Promise.resolve(userStore.getAllGroups()).catch((e) => fallback('routes/projects/members:makeMembersRouter', e, [])) || [])
            .filter(g => String(g.organizationId || '') === orgId && matches(g.name || g.id))
            .slice(0, PRINCIPALS_MAX);
        let counts = new Map();
        if (orgGroups.length) {
            try { counts = await require('../../stores/automationStore').countGroupMembers(orgId, orgGroups.map(g => String(g.id))); }
            catch (err) { log.warn('[Projects] principals: member count failed:', /** @type {Error} */ (err).message); }
        }
        res.json({
            users,
            groups: orgGroups.map(g => ({ id: String(g.id), name: g.name || String(g.id), memberCount: counts.get(String(g.id)) ?? 0 })),
        });
    });

    // PUT /:id/members/:memberId — change role (owner only)
    router.put('/:id/members/:memberId', memberMutationLimiter, requireRole('owner'), validate({ body: S.MemberRoleBody }), async (req, res) => {
        const userId = getUserId(req);
        const { role } = req.body;
        const normalized = projectStore.normalizePermission(role);
        if (!['viewer', 'editor'].includes(normalized)) return res.status(400).json({ error: 'role must be viewer or editor' });

        const before = await projectStore.getShareById(req.params.memberId);
        if (!before || before.projectId !== req.params.id) return res.status(404).json({ error: 'Member not found' });

        const ok = await projectStore.updateMemberRole(req.params.memberId, normalized);
        if (!ok) return res.status(404).json({ error: 'Member not found' });

        await recordProjectChange(req.params.id, userId, 'member_role_changed', {
            targetType: before.sharedWithType, targetId: before.sharedWithId,
            from: before.permission, to: normalized,
        });
        const projectNow = await projectStore.getProject(req.params.id);
        signalProjectChanged(projectNow, 'members');
        if (projectNow && before.sharedWithType === 'user') {
            await tellCollab('role change', (n) => n.roleChanged({ project: projectNow, actorId: userId, userId: before.sharedWithId, from: before.permission, to: normalized }));
        }
        res.json({ success: true });
    });

    // POST /:id/transfer-owner — hand the project to another member. The owner chooses what they stay as
    // (keepMeAs, default editor). An org admin who is not the owner may do it too, to rescue a project whose
    // owner is gone; the absent owner then keeps no seat (keepFromAs forced to 'none'). The gate is viewer+, so
    // the rescue covers an admin who already has at least viewer access; an admin with no access at all gets the
    // gate's 404 (accepted for this wave). The store checks the owner inside the write: a stale expectedOwnerId
    // (or a concurrent transfer) is a 409 owner_changed and nothing is written.
    router.post('/:id/transfer-owner', memberMutationLimiter, requireRole('viewer'), validate({ body: S.TransferBody }), async (req, res) => {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ error: 'Not authenticated' });
        const project = await projectStore.getProject(req.params.id);
        if (!project) throw notFound();

        const projectOrg = await projectOrgOf(project);
        const isOwner = project.ownerId === userId;
        const byOrgAdmin = !isOwner;
        if (byOrgAdmin && !(await isOrgAdminForOrg(req, projectOrg))) {
            throw new HttpError(403, 'owner_only', 'Only the owner or an organisation admin can transfer this project.');
        }

        const { toUserId, keepMeAs, expectedOwnerId } = req.body;
        if (expectedOwnerId && expectedOwnerId !== project.ownerId) {
            throw new HttpError(409, 'owner_changed', 'The owner of this project changed in the meantime. Reload and try again.');
        }
        if (toUserId === project.ownerId) throw new HttpError(400, 'already_owner', 'That person already owns this project.');

        const targetRole = await projectStore.getProjectRole(toUserId, project.id, await resolveUserGroups(toUserId));
        if (!targetRole) throw new HttpError(400, 'not_a_member', 'Only a member of this project can become its owner. Add them first.');
        if (!await belongsToProjectOrg(toUserId, projectOrg)) {
            throw new HttpError(400, 'not_in_organisation', 'That person does not belong to this project\'s organisation.');
        }

        const fromUserId = project.ownerId;
        const keepFromAs = byOrgAdmin ? 'none' : (keepMeAs || 'editor');
        const moved = await projectStore.transferOwner({ projectId: project.id, fromUserId, toUserId, keepFromAs });
        if (!moved.ok) {
            throw new HttpError(409, 'owner_changed', 'The owner of this project changed in the meantime. Reload and try again.');
        }

        await recordProjectChange(project.id, userId, 'owner_changed', { from: fromUserId, to: toUserId, byOrgAdmin });
        signalProjectChanged(project, 'members');
        await tellCollab('owner change', (n) => n.ownerChanged({ project, actorId: userId, fromUserId, toUserId }));
        res.json({ success: true, ownerId: toUserId, keptAs: keepFromAs });
    });

    // DELETE /:id/members/:memberId — owner removes OR member self-leaves
    router.delete('/:id/members/:memberId', memberMutationLimiter, async (req, res) => {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ error: 'Not authenticated' });

        const project = await projectStore.getProject(req.params.id);
        if (!project) return res.status(404).json({ error: 'Not found' });
        const share = await projectStore.getShareById(req.params.memberId);
        if (!share || share.projectId !== req.params.id) return res.status(404).json({ error: 'Member not found' });

        const isOwner = project.ownerId === userId;
        const isSelf = share.sharedWithType === 'user' && share.sharedWithId === userId;
        if (!isOwner && !isSelf) return res.status(403).json({ error: 'Forbidden' });
        // The owner cannot walk away from their own project: hand it over first.
        if (isOwner && isSelf) {
            throw new HttpError(409, 'transfer_first', 'Transfer the project to someone else before leaving it.');
        }

        const ok = await projectStore.unshareProject(req.params.memberId);
        await recordProjectChange(req.params.id, userId, 'member_removed', {
            targetType: share.sharedWithType, targetId: share.sharedWithId,
            selfLeave: isSelf && !isOwner,
        });
        if (ok) signalProjectChanged(project, 'members');
        if (ok && share.sharedWithType === 'user') {
            await tellCollab(isSelf ? 'leave' : 'removal', (n) => (isSelf
                ? n.left({ project, userId })
                : n.removed({ project, actorId: userId, userId: share.sharedWithId })));
            // Someone who left holds no tasks here any more; best-effort, the removal stands.
            try { await require('../../stores/projectMemberColorStore').clearFor(req.params.id, share.sharedWithId); } catch (err) {
                log.warn('[Projects] could not clear a removed member\'s colour:', /** @type {Error} */ (err).message);
            }
            try { await require('../../stores/projectTaskStore').unassignUser(req.params.id, share.sharedWithId); } catch (err) {
                log.warn('[Projects] could not unassign a removed member from tasks:', /** @type {Error} */ (err).message);
            }
        }
        res.json({ success: ok });
    });

    // GET /:id/avatars/:userId — the picture an owner or member uploaded, as an image (viewer+). Only for a person
    // of this project, only the raster types, and served as the bytes it holds: nothing else is ever read from it.
    const AVATAR_DATA_URL = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/;
    router.get('/:id/avatars/:userId', requireRole('viewer'), async (req, res) => {
        // nosemgrep: ajinabraham.njsscan.xss.xss_node.express_xss -- the response is decoded image bytes under a fixed image/* type with nosniff and a sandbox CSP; no request input is echoed
        const project = await projectStore.getProject(req.params.id);
        if (!project) throw notFound();
        const shares = await projectStore.getProjectShares(project.id);
        const isMember = project.ownerId === req.params.userId
            || shares.some((s) => s.sharedWithType === 'user' && s.sharedWithId === req.params.userId);
        // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos, ajinabraham.njsscan.xss.xss_node.express_xss -- AVATAR_DATA_URL is anchored with one character-class repeat (linear); the bytes go out as an image, see above
        const user = isMember ? await userStore.getUser(req.params.userId) : null;
        const match = user && typeof user.avatar === 'string' && await belongsToProjectOrg(user.id, await projectOrgOf(project))
            ? AVATAR_DATA_URL.exec(user.avatar) : null;
        if (!match) throw notFound();
        res.set({
            'Content-Type': match[1],
            'Cache-Control': 'private, max-age=86400',
            'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': "default-src 'none'; sandbox",
        });
        res.send(Buffer.from(match[2].replace(/\s+/g, ''), 'base64'));
    });

    return router;
}

module.exports = { makeMembersRouter };
