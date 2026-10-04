/**
 * Org-admin endpoints for Nextcloud user/group sync configuration.
 *
 * The org-admin UI (agent-hub/src/components/admin/NextcloudSyncPanel.jsx)
 * calls these to read & update the org-level sync settings, list NC groups,
 * trigger an on-demand full sync, and inspect mirrored users.
 */

const express = require('express');
const log = require('../../telemetry/log');
const router = express.Router();

const userStore = require('../../stores/userStore');
const sync = require('../../services/ncUserGroupSync');
const { requireAuth, isOrgAdminForOrg } = require('../../auth/permissions');
const { tagGate } = require('../../auth/gateMeta');
const orgHealth = require('../../services/orgHealth'); // fire-and-forget health capture
const { validate } = require('../../core/http/validate');
const { z } = require('zod');

// ── What a caller may send ──────────────────────────────────────────
//
// Both write routes read the body key by key and dropped whatever they did
// not recognise, then answered 200 `{ ok: true }`. The panel says "Settings
// saved" to that — for a setting that decides who gets an account at all.

/** A string whose every refusal — including "you left it out" — is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

/** A body that also accepts no body at all: Express 5 leaves `req.body` undefined then. */
const bodyOf = (shape) => z.preprocess((v) => (v === undefined || v === null ? {} : v), z.object(shape).strict());

/**
 * A list of group names. `syncGroups: 'Interns'` — one name rather than a
 * list — fell straight through the `Array.isArray` gate: the panel reported
 * the settings saved and the selection stayed exactly as it was.
 */
const groupList = (name) => {
    const text = `${name} is a list of group names.`;
    return z.array(worded(text).trim().min(1, text), { required_error: text, invalid_type_error: text });
};

const MODE_TEXT = 'mode is "mirror_all", "selective_groups" or "manual".';
const SYNC_MODE_TEXT = 'syncMode is "mirror_all", "selective_groups" or "manual".';
const STATUS_TEXT = 'newUserDefaultStatus is "active" or "pending".';
const DEPLOY_TEXT = 'deploymentMode is "cloud" or "self-hosted".';
const ACTION_TEXT = 'piiDetectionAction is "tokenize" or "block".';

const syncModes = (message) => z.enum(['mirror_all', 'selective_groups', 'manual'], { errorMap: () => ({ message }) });
const DefaultStatus = z.enum(['active', 'pending'], { errorMap: () => ({ message: STATUS_TEXT }) });

const NcSyncBody = bodyOf({
    mode: syncModes(MODE_TEXT).optional(),
    syncGroups: groupList('syncGroups').optional(),
    excludedGroups: groupList('excludedGroups').optional(),
    newUserDefaultStatus: DefaultStatus.optional(),
});

/**
 * The wizard's Privacy Shield. `piiDetectionAction` was read as
 * `=== 'block' ? 'block' : 'tokenize'`, so every other spelling — 'Block',
 * 'blok' — quietly put an organisation that chose to BLOCK on tokenising,
 * and the wizard reported it was done. In a privacy product that is the
 * difference between "those values never leave" and "they leave, disguised".
 */
const PrivacyShield = z.object({
    enabled: z.boolean({ invalid_type_error: 'privacyShield.enabled is true or false.' }).optional(),
    piiDetectionAction: z.enum(['tokenize', 'block'], { errorMap: () => ({ message: ACTION_TEXT }) }).optional(),
    piiDetectionCategories: z.array(
        worded('piiDetectionCategories is a list of categories.').trim().min(1, 'piiDetectionCategories is a list of categories.'),
        { invalid_type_error: 'piiDetectionCategories is a list of categories.' },
    ).optional(),
}).strict();

const PLAN_TEXT = 'selectedPlanId is the id of a plan.';
const OnboardingBody = z.preprocess(
    (v) => (v === undefined || v === null ? {} : v),
    z.object({
        syncMode: syncModes(SYNC_MODE_TEXT),
        syncGroups: groupList('syncGroups').optional(),
        excludedGroups: groupList('excludedGroups').optional(),
        newUserDefaultStatus: DefaultStatus,
        deploymentMode: z.enum(['cloud', 'self-hosted'], { errorMap: () => ({ message: DEPLOY_TEXT }) }).optional(),
        selectedPlanId: worded(PLAN_TEXT).trim().nullish(),
        privacyShield: PrivacyShield.optional(),
    }).strict().superRefine((b, ctx) => {
        if (b.syncMode === 'selective_groups' && !(b.syncGroups && b.syncGroups.length)) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['syncGroups'], message: 'selective_groups needs at least one group.' });
        }
    }),
);

// All routes require an authenticated org-admin (or global admin) for the
// requested orgId. We resolve org from URL param.
async function _checkOrgAdmin(req, res, next) {
    const orgId = req.params.orgId;
    if (!orgId) return res.status(400).json({ error: 'orgId required' });
    // DB-resolved, not session-read — see the note on connectorHealth.js's
    // _checkOrgAdmin: an SSO session carries no orgRole/organizationId.
    if (!(await isOrgAdminForOrg(req, orgId))) {
        return res.status(403).json({ error: 'Org admin access required' });
    }
    const org = await userStore.getOrganization(orgId);
    if (!org) return res.status(404).json({ error: 'Organization not found' });
    if (!org.nc_instance_id) return res.status(400).json({ error: 'Organization is not bound to a Nextcloud instance' });
    req.org = org;
    next();
}

// Tagged (auth/gateMeta.js) so the route walk can see what this enforces —
// otherwise these four routes read as ungated.
//
// NOTE a real divergence, recorded rather than silently "fixed": this gate
// derives membership from req.session.user.organizationId ALONE, so an org-admin
// who belongs to the org only through a group (the transitive path that
// permissions.js:642's resolveUserOrgIds unions in) is denied here but allowed by
// the shared requireOrgAdmin. Changing that is a behaviour change and needs its
// own slice; the tag at least makes the difference visible.
const checkOrgAdmin = tagGate(_checkOrgAdmin, {
    axis: 'scope',
    kind: 'orgAdminOfParam',
    param: 'orgId',
    paramDependent: true,
    note: 'Local re-implementation. Direct organizationId only — does NOT honour group-transitive org membership, unlike permissions.js requireOrgAdmin. Also 400s if the org has no Nextcloud binding.',
});

router.get('/admin/:orgId/nc-sync', requireAuth, checkOrgAdmin, async (req, res) => {
    const o = req.org;
    res.json({
        organizationId: o.id,
        ncInstanceId: o.nc_instance_id,
        ncBaseUrl: o.nc_base_url,
        mode: o.nc_sync_mode || 'mirror_all',
        syncGroups: o.ncSyncGroups || [],
        excludedGroups: o.ncSyncExcludedGroups || [],
        newUserDefaultStatus: o.nc_new_user_default_status || 'active',
        lastSyncAt: o.nc_last_sync_at,
    });
});

router.put('/admin/:orgId/nc-sync', requireAuth, checkOrgAdmin, express.json(), validate({ body: NcSyncBody }), async (req, res) => {
    const { mode, syncGroups, excludedGroups, newUserDefaultStatus } = req.body;
    const updates = {};
    if (mode !== undefined) updates.ncSyncMode = mode;
    if (syncGroups !== undefined) updates.ncSyncGroups = syncGroups;
    if (excludedGroups !== undefined) updates.ncSyncExcludedGroups = excludedGroups;
    if (newUserDefaultStatus !== undefined) updates.ncNewUserDefaultStatus = newUserDefaultStatus;
    await userStore.updateOrganization(req.params.orgId, updates);
    res.json({ ok: true });
});

router.post('/admin/:orgId/nc-sync/run', requireAuth, checkOrgAdmin, async (req, res) => {
    const result = await sync.runFullSync(req.org);
    res.json(result);
});

router.get('/admin/:orgId/nc-sync/groups', requireAuth, checkOrgAdmin, async (req, res) => {
    try {
        const groups = await sync.listNcGroups(req.org);
        res.json({ groups });
    } catch (e) {
        log.warn('[NcSync] listing Nextcloud groups failed:', e.message);
        res.status(502).json({ error: 'Could not reach Nextcloud' });
    }
});

router.get('/admin/:orgId/nc-sync/users', requireAuth, checkOrgAdmin, async (req, res) => {
    const users = await userStore.getAllUsers();
    const orgUsers = users
        .filter(u => u.organizationId === req.params.orgId && u.provider === 'nextcloud_connector')
        .map(u => ({
            id: u.id, email: u.email, displayName: u.displayName,
            ncUid: u.nc_uid, status: u.status, autoProvisioned: u.auto_provisioned,
        }));
    res.json({ users: orgUsers });
});

// Onboarding wizard completion. Single endpoint that persists every choice
// from the 4-step App Store wizard in one transaction, then flips the
// onboarding flag so future loads skip the wizard. Once this returns the
// other NC users in this org are unblocked from auto-provisioning.
router.post('/admin/:orgId/nc-onboarding/complete', requireAuth, checkOrgAdmin, express.json(), validate({ body: OnboardingBody }), async (req, res) => {
    const configStore = require('../../stores/configStore');
    const { syncMode, syncGroups, excludedGroups, newUserDefaultStatus, privacyShield, deploymentMode, selectedPlanId } = req.body;

    // selectedPlanId is optional. When provided, validate it points at an
    // existing plan so we don't store a dangling reference.
    if (selectedPlanId) {
        const plan = await userStore.getPlan(selectedPlanId);
        if (!plan) return res.status(400).json({ error: 'Invalid selectedPlanId' });
    }

    // 1. Sync settings + wizard outputs on the org row.
    await userStore.updateOrganization(req.params.orgId, {
        ncSyncMode: syncMode,
        ncSyncGroups: syncGroups || [],
        ncSyncExcludedGroups: excludedGroups || [],
        ncNewUserDefaultStatus: newUserDefaultStatus,
        ...(deploymentMode !== undefined ? { deploymentMode } : {}),
        ...(selectedPlanId !== undefined ? { selectedPlanId: selectedPlanId || null } : {}),
    });

    // 2. Privacy Shield in configStore (same shape GuardrailsPanel writes).
    const shield = privacyShield || {};
    const existingShield = (await configStore.getConfig(`org_privacy_shield_${req.params.orgId}`)) || {};
    await configStore.setConfig(`org_privacy_shield_${req.params.orgId}`, {
        ...existingShield,
        enabled: shield.enabled !== false,
        scope: existingShield.scope || { userInput: true, agentOutput: true },
        piiDetectionAction: shield.piiDetectionAction || 'tokenize',
        piiDetectionCategories: shield.piiDetectionCategories || [],
        piiDetectionConfidenceThreshold: typeof existingShield.piiDetectionConfidenceThreshold === 'number'
            ? existingShield.piiDetectionConfidenceThreshold : 0.7,
    });

    // 3. Flip the flag — order matters: settings first so a refresh
    //    after a partial completion can't unblock users with stale config.
    await userStore.updateOrganization(req.params.orgId, {
        ncOnboardingCompletedAt: new Date().toISOString(),
    });

    log.info(`[NcOnboarding] Completed for org ${req.params.orgId} (syncMode=${syncMode}, defaultStatus=${newUserDefaultStatus})`);
    // Org-health: onboarding done → non-admin auto-provisioning is unblocked.
    orgHealth.event('onboarding.completed', {
        orgId: req.params.orgId, actorUserId: req.session?.user?.id, actorKind: 'user', req,
        meta: { syncMode, newUserDefaultStatus },
    });
    orgHealth.resolve(req.params.orgId, ['auth.blocked_onboarding_pending']);
    res.json({ ok: true });
});

// Re-export so server/auth/index.js or routes/index.js can mount it under /auth.
module.exports = router;
