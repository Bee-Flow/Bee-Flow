/**
 * Org-admin endpoints for Nextcloud integration management.
 *
 * Lets the NC org-admin toggle the 11 Nextcloud tools for the whole org and
 * opt specific groups out of specific tools (e.g. "Stagiairs cannot use Talk").
 *
 * Whitelist: only NC-prefix integration IDs may be written here. Non-NC
 * integrations stay super-admin only — see PUT /auth/organizations/:id in
 * server/auth/adminRoutes.js.
 *
 * Conflict resolution at tool-resolve time is "enable wins": a user only
 * loses access to a tool if EVERY group they belong to has the tool in its
 * disabled_integrations list. See server/core/integrationTools.js isAppOn().
 */

const express = require('express');
const log = require('../../telemetry/log');
const router = express.Router();

const userStore = require('../../stores/userStore');
const guardrailEventStore = require('../../stores/guardrailEventStore');
const { requireAuth, requireOrgAdmin } = require('../../auth/permissions');
const { NC_INTEGRATIONS, NC_INTEGRATION_IDS, isNcIntegrationId } = require('../../core/integrations/ncIntegrationCatalog');
const ncScope = require('../../core/integrations/ncScope');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');

// ── What a caller may send ──────────────────────────────────────────
//
// Both writes ran the body through `filterToNcIds`, which keeps what it
// recognises and drops the rest — silently, under a 200, and the panel only
// looks at `res.ok`. Two shapes came out wrong:
//
//   · `enabled: 'nextcloud-talk'` (one id, not a list) filtered to `[]`, which
//     is not "nothing to change" here but "every Nextcloud integration off"
//     — the scope doc records a mode per integration, so an empty list is
//     enforced as a full block for the whole organisation;
//   · `enabled: ['nextcloud-tlk']` dropped the misspelling, so Talk was
//     switched OFF by a request that asked for it to be on.
//
// The ids are the catalogue's own, so an unknown one is named back.

/** A string whose every refusal — including "you left it out" — is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

/** A body that also accepts no body at all: Express 5 leaves `req.body` undefined then. */
const bodyOf = (shape) => z.preprocess((v) => (v === undefined || v === null ? {} : v), z.object(shape).strict());

const idList = (name) => {
    const text = `${name} is a list of Nextcloud integration ids.`;
    return z.array(
        worded(text).refine(isNcIntegrationId, (v) => ({ message: `"${v}" is not a Nextcloud integration. Known ids: ${NC_INTEGRATION_IDS.join(', ')}.` })),
        { required_error: text, invalid_type_error: text },
    );
};

const OrgIntegrationsBody = bodyOf({ enabled: idList('enabled') });
const GroupIntegrationsBody = bodyOf({ disabledIntegrations: idList('disabledIntegrations') });

// Augment requireOrgAdmin with a "must be NC-bound" check so this whole
// surface is unreachable for standalone orgs even if a malicious caller
// guesses the URL.
async function requireNcOrg(req, res, next) {
    const orgId = req.params.orgId;
    const org = await userStore.getOrganization(orgId);
    if (!org) return res.status(404).json({ error: 'Organization not found' });
    if (!org.nc_instance_id) return res.status(400).json({ error: 'Organization is not bound to a Nextcloud instance' });
    req.org = org;
    next();
}

// ─── Org-level integration toggles ──────────────────────────────────────────

router.get('/admin/:orgId/nc-integrations', requireAuth, requireOrgAdmin('orgId'), requireNcOrg, async (req, res) => {
    const o = req.org;
    // org.enabledIntegrations may be NULL ("inherit defaults"), an array, or
    // a JSON string depending on store path. parseOrg in userStore does NOT
    // currently parse it, so be defensive here.
    let enabledRaw = o.enabledIntegrations;
    if (typeof enabledRaw === 'string') {
        try { enabledRaw = JSON.parse(enabledRaw); } catch { enabledRaw = null; }
    }
    // The org scope doc is the enforceable record, so it leads. Only when no
    // doc exists do we fall back to the legacy column, and only then as a
    // display hint: an org that never opened this panel has no doc, is not
    // restricted, and must therefore be shown with everything on.
    //
    // Showing anything else here would be the panel lying about access the
    // user still has — which is exactly what it did while the toggles wrote
    // a column nothing enforced.
    let enabled;
    let usingDefaults;
    const scopeDoc = await ncScope.getOrgScopeDoc(o.id).catch(() => null);
    if (scopeDoc?.integrations) {
        const scoped = ncScope.sanitizeIntegrations(scopeDoc.integrations);
        enabled = NC_INTEGRATION_IDS.filter(id => (scoped[id]?.mode ?? 'all') !== 'off');
        usingDefaults = false;
    } else {
        enabled = NC_INTEGRATION_IDS.slice();
        usingDefaults = true;
    }
    res.json({
        organizationId: o.id,
        ncCatalog: NC_INTEGRATIONS,
        enabled,
        usingDefaults,
        // Surfaced so the panel can say so if it wants to: a pre-existing
        // legacy list that was never enforced is not a restriction.
        legacyEnabled: Array.isArray(enabledRaw) ? enabledRaw.filter(isNcIntegrationId) : null,
    });
});

router.put('/admin/:orgId/nc-integrations', requireAuth, requireOrgAdmin('orgId'), requireNcOrg, express.json(), validate({ body: OrgIntegrationsBody }), async (req, res) => {
    const o = req.org;
    const requested = req.body.enabled;
    // Merge: keep any non-NC entries that may already be on the org (those
    // are super-admin territory) and replace only the NC slice with the new
    // request.
    let current = o.enabledIntegrations;
    if (typeof current === 'string') {
        try { current = JSON.parse(current); } catch { current = null; }
    }
    const nonNc = Array.isArray(current) ? current.filter(id => !isNcIntegrationId(id)) : [];
    const merged = [...nonNc, ...requested];
    await userStore.updateOrganization(o.id, { enabledIntegrations: merged });

    // The enforceable record. The legacy column above is kept for the
    // super-admin surfaces that still read it, but it cannot express "every
    // Nextcloud integration off" — an array with no NC ids reads identically
    // to an array that simply predates this panel — so it was never safe to
    // enforce. The scope doc records a mode per integration, so unticking
    // everything means what it says, and an org that has never opened this
    // panel still has no doc and therefore no restriction.
    try {
        await ncScope.setOrgEnabledIntegrations(o.id, requested, { updatedBy: req.session?.user?.id || null });
    } catch (e) {
        log.error(`[ncIntegrations] failed to persist org scope for ${o.id}: ${e.message}`);
        return res.status(500).json({ error: 'Could not save the Nextcloud integration settings' });
    }

    guardrailEventStore.logGuardrailEvent({
        organization_id: o.id,
        user_id: req.session?.user?.id || null,
        violation_type: 'admin_action',
        violation_categories: 'nc_integrations:org',
        direction: 'input',
        action_taken: `set:[${requested.join(',')}]`,
        source: 'org_admin',
    }).catch(() => {});

    res.json({ ok: true, enabled: requested });
});

// ─── Per-group exceptions ───────────────────────────────────────────────────

router.get('/admin/:orgId/nc-integrations/groups', requireAuth, requireOrgAdmin('orgId'), requireNcOrg, async (req, res) => {
    const orgId = req.params.orgId;
    const allGroups = await userStore.getAllGroups();
    // Only NC-source groups belong on this UI; org-local groups (Bee Flow
    // roles, manual groups) aren't part of the NC sync surface.
    const ncGroups = allGroups.filter(g => g.organizationId === orgId && g.source === 'nextcloud');
    // user-count is best-effort: walk users once.
    const allUsers = await userStore.getAllUsers();
    const countByGroup = new Map();
    for (const u of allUsers) {
        if (u.organizationId !== orgId) continue;
        const groups = Array.isArray(u.groups) ? u.groups : [];
        for (const gid of groups) countByGroup.set(gid, (countByGroup.get(gid) || 0) + 1);
    }
    res.json({
        groups: ncGroups.map(g => ({
            id: g.id,
            name: g.name,
            source: g.source,
            disabledIntegrations: Array.isArray(g.disabled_integrations) ? g.disabled_integrations : [],
            userCount: countByGroup.get(g.id) || 0,
        })),
    });
});

router.put('/admin/:orgId/nc-integrations/groups/:groupId', requireAuth, requireOrgAdmin('orgId'), requireNcOrg, express.json(), validate({ body: GroupIntegrationsBody }), async (req, res) => {
    const { orgId, groupId } = req.params;
    const groups = await userStore.getAllGroups();
    const group = groups.find(g => g.id === groupId);
    if (!group) return res.status(404).json({ error: 'Group not found' });
    if (group.organizationId !== orgId) return res.status(403).json({ error: 'Group does not belong to this organisation' });

    const disabled = req.body.disabledIntegrations;
    const ok = await userStore.updateGroup(groupId, { disabledIntegrations: disabled });
    if (!ok) return res.status(500).json({ error: 'Could not update group' });

    guardrailEventStore.logGuardrailEvent({
        organization_id: orgId,
        user_id: req.session?.user?.id || null,
        violation_type: 'admin_action',
        violation_categories: `nc_integrations:group:${groupId}`,
        direction: 'input',
        action_taken: `set:[${disabled.join(',')}]`,
        source: 'org_admin',
    }).catch(() => {});

    res.json({ ok: true, groupId, disabledIntegrations: disabled });
});

module.exports = router;
