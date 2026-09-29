// @typecheck
/**
 * Admin Routes — organisation invitations: create + email, list, revoke,
 * with the invite flood-control state. Split out of auth/adminRoutes.js;
 * mounted there in the original registration order.
 */

const express = require('express');
const log = require('../../telemetry/log');
const router = express.Router();

const userStore = require('../../stores/userStore');
const { requireAuth } = require('../permissions');
const { perUserRateLimit } = require('../../utils/perUserRateLimit');
const { isOrgAdminForOrg } = require('./orgAdminGuards');
const { getOrgRolePermissions } = require('../permissions');
const { validate } = require('../../core/http/validate');
const { HttpError } = require('../../core/http/errors');
const { z } = require('zod');

/** A string whose every refusal — including "you left it out" — is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

const EMAIL_TEXT = 'Email is required';
// `role` is checked against the installation's own org-role list inside the
// handler rather than by an enum here: the roles come from config/orgRoles.json
// (getOrgRolePermissions), so a deployment that defines its own would be
// refused by a list baked in at module load.
const InvitationBody = z.object({
    email: worded(EMAIL_TEXT).trim().min(1, EMAIL_TEXT).max(254, 'That e-mail address is too long.'),
    role: worded('An invitation role must be text.').trim().min(1, 'An invitation role cannot be blank.').optional(),
}).strict();

// Invitation flood control. Two layered limits:
//   • per-inviter:  20 invites / hour (rolling)
//   • per-org/day:  200 invites total (we don't bother tracking per IP
//     because invitations require an authenticated session)
// Both run before the route handler so a malicious admin can't bypass by
// rotating accounts within their org.
const invitationInviterLimiter = perUserRateLimit({ windowMs: 60 * 60_000, max: 20 });

// ═══════════════════════════════════════════════════════════
// ── Invitations ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════
const invitationStore = require('../../stores/invitationStore');
const { sendInvitationEmail } = require('../../utils/emailService');

// Per-org daily cap. In-memory rolling 24h window keyed on orgId. Cheap,
// resets on process restart (acceptable — the cap is anti-spam, not a hard
// quota). For multi-node deploys, this is per-node; redis would be a future
// upgrade if abuse patterns warrant it.
const ORG_INVITE_DAILY_CAP = 200;
const ORG_INVITE_WINDOW_MS = 24 * 60 * 60_000;
const _orgInviteBuckets = new Map(); // orgId → [timestamps]
function _checkOrgInviteCap(orgId) {
    const now = Date.now();
    const cutoff = now - ORG_INVITE_WINDOW_MS;
    const arr = (_orgInviteBuckets.get(orgId) || []).filter(t => t > cutoff);
    if (arr.length >= ORG_INVITE_DAILY_CAP) return false;
    arr.push(now);
    _orgInviteBuckets.set(orgId, arr);
    return true;
}

// Per-email cooldown — protects an external email from being spammed
// across rotating admin accounts. One hour between invitations to the
// same lower-cased email. Keyed solely on the email so a hostile pair of
// org admins can't take turns.
const EMAIL_INVITE_COOLDOWN_MS = 60 * 60_000;
const _lastInviteByEmail = new Map(); // lowercase email → last ts
function _checkEmailInviteCooldown(email) {
    if (!email) return true;
    const k = String(email).toLowerCase().trim();
    const last = _lastInviteByEmail.get(k) || 0;
    if (Date.now() - last < EMAIL_INVITE_COOLDOWN_MS) return false;
    _lastInviteByEmail.set(k, Date.now());
    return true;
}

// Create invitation + send email
router.post('/invitations', requireAuth, invitationInviterLimiter, validate({ body: InvitationBody }), async (req, res) => {
    const { email, role } = req.body;
    // The role travels to the invitee — it is shown on the invite screen and
    // named in the e-mail — so a value this installation does not define is a
    // promise nobody can keep. It used to be stored verbatim.
    if (role !== undefined && role !== 'user' && !Object.prototype.hasOwnProperty.call(getOrgRolePermissions(), role)) {
        throw new HttpError(400, 'unknown_role', `Unknown role: ${role.slice(0, 64)}`);
    }

    const userId = req.session?.user?.id;
    const user = await userStore.getUser(userId);
    if (!user) return res.status(401).json({ error: 'Not authenticated' });

    // Must be org admin
    const orgId = user.organizationId;
    if (!orgId) return res.status(403).json({ error: 'You are not part of an organisation' });
    if (!(await isOrgAdminForOrg(req, orgId))) {
        return res.status(403).json({ error: 'Only organisation admins can send invitations' });
    }

    // Per-org daily cap. Sits after the auth checks so unauthenticated
    // traffic doesn't pollute the bucket.
    if (!_checkOrgInviteCap(orgId)) {
        return res.status(429).json({ error: `Organisation invitation cap reached (${ORG_INVITE_DAILY_CAP} per 24h). Try again later.` });
    }

    // Per-recipient cooldown — prevents a target email from being
    // spammed even across multiple admin accounts (and orgs).
    if (!_checkEmailInviteCooldown(email)) {
        return res.status(429).json({ error: 'This email was recently invited. Wait an hour before re-inviting.' });
    }

    // Check if user already exists with this email
    const existingUser = await userStore.getUserByEmail(email);
    if (existingUser && existingUser.organizationId === orgId) {
        return res.status(409).json({ error: 'A user with this email is already in your organisation' });
    }

    // BFSF-251: seat-cap pre-check. Previously the invite ALWAYS succeeded
    // and the cap only fired at signup redemption — for the INVITEE, who
    // then hit a dead-end error the admin never saw. Fail fast here with a
    // structured code so the UI can point the admin at the upgrade flow.
    // Pending (unaccepted, unexpired) invites count toward the cap so an
    // admin can't queue up more redemptions than seats.
    try {
        const limits = await userStore.getEffectiveLimits(orgId);
        const maxUsers = limits?.max_users;
        if (maxUsers != null && maxUsers !== -1) {
            const activeSeats = await userStore.getActiveSeatCount(orgId);
            let pendingInvites = 0;
            try {
                const invites = await invitationStore.getInvitationsForOrg(orgId) || [];
                // Rows carry status 'pending'|'accepted'|'revoked' — only
                // live pending, unexpired invites count toward the cap.
                pendingInvites = invites.filter(i =>
                    i.status === 'pending'
                    && (!i.expires_at || new Date(i.expires_at).getTime() > Date.now())
                ).length;
            } catch (_) { /* count without pending */ }
            if (activeSeats + pendingInvites >= maxUsers) {
                return res.status(403).json({
                    error: `Your plan has reached its user limit (${activeSeats} active${pendingInvites ? ` + ${pendingInvites} pending invite(s)` : ''} of ${maxUsers}). Upgrade your plan to add more users.`,
                    code: 'seat_cap_exceeded',
                    current: activeSeats,
                    pending: pendingInvites,
                    max: maxUsers,
                });
            }
        }
    } catch (e) {
        // The atomic enforcement at redemption still applies — never block
        // invites because the pre-check itself hiccupped.
        log.warn('[Invitations] seat-cap pre-check failed (continuing):', e.message);
    }

    // Create invitation token
    const invitation = await invitationStore.createInvitation({
        email,
        organizationId: orgId,
        invitedBy: userId,
        role: role || 'user',
    });
    if (!invitation) return res.status(500).json({ error: 'Failed to create invitation' });

    // Build invite URL. Use the path-style redeem endpoint instead of
    // `/login?invite=TOKEN` so the token never appears in the SPA URL
    // bar, the Referer header, or reverse-proxy access logs after the
    // 302 fires. The endpoint moves the token into the session and
    // redirects to /login?signup=1.
    const clientHost = `${process.env.CLIENT_PROTOCOL || 'https'}://${process.env.CLIENT_PUBLIC_HOST || 'beeflow.nl'}`;
    // The auth router is mounted at `/auth` (server/index.js), NOT `/api/auth`,
    // so the redeem endpoint lives at `/auth/redeem-invite/:token`. Using the
    // wrong prefix here produced a raw "Cannot GET /api/auth/redeem-invite/..."
    // 404 for every invited user (BFSF-240).
    const inviteUrl = `${clientHost}/auth/redeem-invite/${invitation.token}`;

    // Get org name and inviter display name
    const org = await userStore.getOrganization(orgId);
    const orgName = org?.name || 'your organisation';
    const inviterName = user.displayName || user.username || 'A team member';

    // Send email
    const emailResult = await sendInvitationEmail({
        email,
        orgName,
        inviterName,
        inviteUrl,
        role: role || 'user',
    });

    if (!emailResult.success) {
        log.error('[Invitations] Email send failed:', emailResult.error);
        // Still return the invitation — admin can share the link manually
    }

    await userStore.logAccessAudit(
        'invitation.create',
        'invitation',
        invitation.id,
        userId || null,
        null,
        { email, role: role || 'user', emailSent: !!emailResult.success },
        orgId,
    );

    res.json({
        success: true,
        invitation: {
            id: invitation.id,
            email,
            expiresAt: invitation.expiresAt,
        },
        emailSent: emailResult.success,
        emailError: emailResult.success ? undefined : emailResult.error,
        inviteUrl, // fallback for manual sharing
    });
});

// List invitations for the current user's organisation
router.get('/invitations', requireAuth, async (req, res) => {
    const userId = req.session?.user?.id;
    const user = await userStore.getUser(userId);
    if (!user?.organizationId) return res.json([]);

    if (!(await isOrgAdminForOrg(req, user.organizationId))) {
        return res.status(403).json({ error: 'Only organisation admins can view invitations' });
    }

    const invitations = await invitationStore.getInvitationsForOrg(user.organizationId);

    // Enrich with inviter display name
    const enriched = await Promise.all(invitations.map(async (inv) => {
        const inviter = await userStore.getUser(inv.invited_by);
        return { ...inv, inviterName: inviter?.displayName || inviter?.username || 'Unknown' };
    }));

    res.json(enriched);
});

// Revoke an invitation
router.delete('/invitations/:id', requireAuth, async (req, res) => {
    const userId = req.session?.user?.id;
    const user = await userStore.getUser(userId);
    if (!user?.organizationId) return res.status(403).json({ error: 'Not in an organisation' });
    if (!(await isOrgAdminForOrg(req, user.organizationId))) {
        return res.status(403).json({ error: 'Only organisation admins can revoke invitations' });
    }

    // Snapshot before destructive delete so the audit trail preserves the
    // grant terms (role, groups, target email, issuer).
    let prevInvite = null;
    try { prevInvite = await invitationStore.getInvitationById(req.params.id); } catch (_) { prevInvite = null; }

    const revoked = await invitationStore.deleteInvitation(req.params.id);
    if (revoked) {
        await userStore.logAccessAudit(
            'invitation.revoke',
            'invitation',
            req.params.id,
            userId || null,
            prevInvite ? {
                email: prevInvite.email,
                orgRole: prevInvite.org_role || prevInvite.orgRole,
                groups: prevInvite.groups,
                invited_by: prevInvite.invited_by,
                organization_id: prevInvite.organization_id,
            } : null,
            null,
            user.organizationId,
        );
    }
    res.json({ success: revoked });
});

module.exports = router;
