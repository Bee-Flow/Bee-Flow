// @typecheck
/**
 * Admin Routes — self-service leave-org for the caller's own account.
 * Split out of auth/adminRoutes.js; mounted there in the original
 * registration order.
 */

const express = require('express');
const log = require('../../telemetry/log');
const router = express.Router();

const userStore = require('../../stores/userStore');
const { requireAuth, invalidatePermissionCache, isOrgAdminRole } = require('../permissions');
const { wouldOrphanOrg } = require('./orgAdminGuards');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');

/** A string whose every refusal — including "you left it out" — is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

const TRANSFER_TEXT = 'transferTo (user id) is required';
const LeaveOrgBody = z.object({
    transferTo: worded(TRANSFER_TEXT).trim().min(1, TRANSFER_TEXT).max(200, TRANSFER_TEXT),
}).strict();

// Self-service leave-org. Lets a member detach themselves from their
// organisation. Anything they own that can't survive an unowned state
// (agents — they have FK constraints, embed flows, etc.) is reassigned to
// a target user the caller specifies, who must be an org_admin of the
// same org. Sole-admin protection: if removing this user would leave the
// org with zero org_admins (and they're an org_admin), the request is
// rejected with 409 — the org would otherwise be unmanageable.
router.post('/users/me/leave-org', requireAuth, validate({ body: LeaveOrgBody }), async (req, res) => {
    const userId = req.session?.user?.id;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const me = await userStore.getUser(userId);
    if (!me) return res.status(404).json({ error: 'User not found' });
    const orgId = me.organizationId;
    if (!orgId) return res.status(400).json({ error: 'You are not part of an organization' });

    const { transferTo } = req.body;
    const target = await userStore.getUser(transferTo);
    if (!target || target.organizationId !== orgId) {
        return res.status(400).json({ error: 'transferTo must be a user in your organization' });
    }
    const targetIsOrgAdmin = isOrgAdminRole(target.orgRole);
    if (!targetIsOrgAdmin) {
        return res.status(400).json({ error: 'transferTo must be an organization admin' });
    }

    // Sole-admin protection: count the org's admins excluding self. Shares
    // countOtherOrgAdmins with PUT/DELETE /users/:id rather than keeping a
    // second SQL definition of "who administers this org" — the old query
    // here counted suspended and pending admins (who cannot sign in, so
    // cannot manage anything) and missed admins who belong to the org only
    // through one of its groups.
    if (isOrgAdminRole(me.orgRole) && await wouldOrphanOrg(orgId, userId)) {
        return res.status(409).json({
            error: 'You are the only organization admin. Promote another member before leaving.',
            code: 'last_org_admin',
        });
    }

    // Re-parent owned agents to the target. Bulk update is fine here
    // because we just verified target shares the org. Knowledge bases,
    // skills, automations etc. would follow the same pattern — kept
    // narrow to agents for this change; expand as ownership semantics
    // are formalised for each surface.
    require('../../stores/agentStore');
    try {
        const { run } = require('../../db');
        await run(
            'UPDATE agents SET owner_id = $1, updated_at = NOW() WHERE owner_id = $2 AND organization_id = $3',
            [transferTo, userId, orgId],
        );
    } catch (e) {
        log.warn('[LeaveOrg] agent reassignment failed:', e.message);
    }

    // Detach the user from the org. Keep the user row itself (don't
    // delete) — they may want to keep their consumer-mode account.
    await userStore.updateUser(userId, {
        organizationId: '',
        orgRole: '',
        groups: [],
    });

    await invalidatePermissionCache(userId);

    await userStore.logAccessAudit(
        'user.leave_org',
        'user',
        userId,
        userId,
        { organizationId: orgId, orgRole: me.orgRole },
        { transferTo },
        orgId,
    );

    res.json({ success: true, transferredTo: transferTo });
});

module.exports = router;
