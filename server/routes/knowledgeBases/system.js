/**
 * Knowledge Bases — system-managed KB status.
 *
 * GET /system — what Bee Flow-provided content exists, how much is loaded, and
 * whether the org's beta toggle currently makes it usable.
 *
 * No request schema: it reads nothing from the body or the query. The org it
 * reports on comes from the session (for a super-admin without one, the first
 * organisation), and the answer names it (`orgId`).
 */

const express = require('express');
const router = express.Router();
const kbStore = require('../../stores/knowledgeBases');
const userStore = require('../../stores/userStore');
const { requireAuth, resolveUserOrgIds } = require('../../auth');
const { getUserId } = require('./shared');

// ── System-managed KBs (Bee Flow-provided content) ─────────────────
// Lightweight status endpoint so the admin dashboard can show what's
// available, how many documents are loaded, and whether the *org* (not
// the user's bypass) currently has the matching beta feature enabled.
// Super-admins get an extra `superAdminBypass: true` flag — they can
// always use the system KB in their own chats regardless of org toggle.
router.get('/system', requireAuth, async (req, res) => {
    getUserId(req);
    const orgIds = await resolveUserOrgIds(req);
    const isSuperAdmin = orgIds === null
        || !!req.session?.isAdmin
        || req.session?.user?.role === 'admin';

    // Pick the org whose toggle state we'll report. Super-admins fall
    // back to the first org in the system (same rule as
    // /auth/me/active-features) so the panel has something to manage.
    let orgId = null;
    if (orgIds instanceof Set && orgIds.size > 0) {
        orgId = Array.from(orgIds)[0];
    } else if (isSuperAdmin) {
        try {
            const all = await userStore.getAllOrganizations();
            if (Array.isArray(all) && all.length > 0) orgId = all[0].id;
        } catch (_) { /* no orgs */ }
    }

    // The org's real-world active set = intersection of super-admin
    // allow-list AND org-admin active list. We surface both so the UI can
    // tell whether enabling requires a super-admin grant step first.
    const { getOrgBetaFeatures } = require('../../core/entitlements/betaFeatures');
    let orgAllowed = new Set();
    let orgActive = new Set();
    if (orgId) {
        try { orgAllowed = new Set(await getOrgBetaFeatures(orgId)); } catch (_) { /* */ }
        try { orgActive = new Set(await userStore.getOrgEnabledBetaFeatures(orgId)); } catch (_) { /* */ }
    }

    const all = await kbStore.listSystemKBs();
    const payload = all.map(kb => {
        const slug = kb.system_slug || null;
        const enabledForOrg = !!(slug && orgAllowed.has(slug) && orgActive.has(slug));
        const allowedForOrg = !!(slug && orgAllowed.has(slug));
        return {
            id: kb.id,
            name: kb.name,
            description: kb.description,
            icon: kb.icon,
            system_slug: slug,
            documentCount: Number(kb.document_count || 0),
            totalChunks: Number(kb.total_chunks || 0),
            updatedAt: kb.updated_at,
            betaFeatureId: slug,
            enabledForOrg,
            allowedForOrg,
            // Super-admins always have the feature regardless of org toggle.
            // Surface that to the UI so it can label the row "available to you"
            // even when enabledForOrg is false.
            superAdminBypass: isSuperAdmin,
        };
    });
    res.json({ items: payload, orgId, isSuperAdmin });
});
module.exports = router;
