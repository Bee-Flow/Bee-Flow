// @typecheck strict
/**
 * GitHub Sync Routes — Configure and trigger sync of agent/skill configs to GitHub
 *
 * All routes require manage_agents permission.
 *
 * Only POST /configure takes input. /status, /details, DELETE /configure and
 * the two push routes read nothing but the caller's org (or `?orgId`, see
 * getOrgId) and user id, so none of them carries a body schema.
 */

const express = require('express');
const log = require('../../telemetry/log');
const router = express.Router();
const { requirePermission, resolveUserOrgIds } = require('../../auth');
const githubSyncStore = require('../../stores/githubSyncStore');
const githubSyncService = require('../../services/githubSyncService');
const configStore = require('../../stores/configStore');
const userStore = require('../../stores/userStore');
const { getEffectiveUserId } = require('../../utils/routeHelpers');
const { validate } = require('../../core/http/validate');
const { z, typeError } = require('../../utils/zod');

// ── What a caller may send ──────────────────────────────────────────
//
// This body decides where every agent and skill in the org gets pushed, and
// two of its four keys were read in a way that swallowed a mistake:
//
//   - `branch || 'main'`, so a misspelled key — `{ brach: 'staging' }` — was
//     stored as 'main' and the next push wrote the org's configs onto the
//     DEFAULT branch, answered `{ success: true }`. Nothing on the panel
//     afterwards distinguishes "you asked for main" from "we could not read
//     what you asked for".
//   - `autoSync === true`, so the string 'true' — what a form-encoded or
//     hand-written client sends — stored autoSync OFF under the same
//     `{ success: true }`, and the org silently never synced again.
//
// `repoOwner` and `repoName` are interpolated straight into the GitHub API
// URL, both here and in githubSyncService, so they are pinned to GitHub's own
// name grammar rather than merely required to be truthy.
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
// git refuses these anywhere in a ref name; the rest of the grammar is
// deliberately loose because branch names legitimately carry slashes.
const BRANCH_RE = /^(?![./])[^\s~^:?*[\\]{1,255}$/;

const OWNER_TEXT = 'repoOwner is the GitHub user or organisation, e.g. bee-flow.';
const NAME_TEXT = 'repoName is the repository name, e.g. agent-configs.';
const BRANCH_TEXT = 'branch must be a valid git branch name.';

const ConfigureBody = z.object({
    repoOwner: z.string({ error: OWNER_TEXT }).trim().regex(NAME_RE, OWNER_TEXT),
    repoName: z.string({ error: NAME_TEXT }).trim().regex(NAME_RE, NAME_TEXT),
    branch: z.string({ error: typeError({ invalid: BRANCH_TEXT }) }).trim().regex(BRANCH_RE, BRANCH_TEXT).optional(),
    autoSync: z.boolean({ error: typeError({ invalid: 'autoSync is true or false.' }) }).optional(),
}).strict();

// The sync configuration is the organisation's (the pushes use the caller's own
// GitHub token): the caller's first org, or the org a platform admin names with
// `?orgId` in the admin dashboard (resolveChosenOrgId: 404 unknown; anyone
// else may name only their own org, 403).
/**
 * @param {import('express').Request} req
 * @returns {Promise<{ orgId: string | null, ownOrgId: string | null }>}
 */
async function resolveOrgs(req) {
    const orgIds = await resolveUserOrgIds(req);
    const own = orgIds && orgIds.size > 0 ? Array.from(orgIds)[0] : null;
    if (req.query?.orgId === undefined) return { orgId: own, ownOrgId: own };
    return { orgId: await require('../../auth/permissions').resolveChosenOrgId(req, own), ownOrgId: own };
}

/** @param {import('express').Request} req */
async function getOrgId(req) {
    return (await resolveOrgs(req)).orgId;
}

/**
 * A write by a platform admin on an organisation other than their own
 * (`?orgId`) leaves an access-audit row under that organisation: the action,
 * the organisation and the admin, as ids only.
 * @param {import('express').Request} req
 * @param {{ orgId: string | null, ownOrgId: string | null }} orgs
 * @param {string} action
 */
async function auditChosenOrg(req, { orgId, ownOrgId }, action) {
    if (!orgId || orgId === ownOrgId) return;
    await userStore.logAccessAudit(action, 'github_sync', orgId, getEffectiveUserId(req), null, { homeOrgId: ownOrgId }, orgId);
}

// ─── Status ──────────────────────────────────────────────────────
// Returns current sync configuration + pending change count
router.get('/status', requirePermission('manage_agents'), async (/** @type {import('express').Request} */ req, /** @type {import('express').Response} */ res) => {
    const orgId = await getOrgId(req);
    if (!orgId) return res.status(400).json({ error: 'No organisation found' });

    const config = await githubSyncStore.getOrgSyncConfig(orgId);
    const overview = config ? await githubSyncStore.getSyncOverview(orgId) : null;

    // Check if the configuring user's GitHub is still connected
    const userId = getEffectiveUserId(req);
    const hasGitHub = !!(await configStore.getSecret(`github_token_user_${userId}`));

    res.json({
        configured: !!config,
        githubConnected: hasGitHub,
        config: config || null,
        overview: overview || null,
    });
});

// ─── Configure ───────────────────────────────────────────────────
// Set the target GitHub repository and branch for sync
router.post('/configure', requirePermission('manage_agents'), validate({ body: ConfigureBody }), async (/** @type {import('express').Request} */ req, /** @type {import('express').Response} */ res) => {
    const orgs = await resolveOrgs(req);
    const { orgId } = orgs;
    if (!orgId) return res.status(400).json({ error: 'No organisation found' });

    const userId = getEffectiveUserId(req);
    const { repoOwner, repoName, branch, autoSync } = req.body;

    // Verify the repo is accessible with the user's token
    const token = await githubSyncService.getToken(userId);
    const repoCheck = await fetch(`https://api.github.com/repos/${repoOwner}/${repoName}`, {
        headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: AbortSignal.timeout(10000),
    });

    if (!repoCheck.ok) {
        return res.status(400).json({
            error: `Cannot access repository ${repoOwner}/${repoName}. Check the repo name and your GitHub permissions.`
        });
    }

    await githubSyncStore.setOrgSyncConfig(orgId, {
        repoOwner,
        repoName,
        branch: branch || 'main',
        autoSync: autoSync ?? false,
        configuredBy: userId,
    });
    await auditChosenOrg(req, orgs, 'github_sync.configure');

    log.info(`[GitHubSync] Configured for org ${orgId}: ${repoOwner}/${repoName} (${branch || 'main'})`);
    res.json({ success: true });
});

// ─── Disconnect ──────────────────────────────────────────────────
router.delete('/configure', requirePermission('manage_agents'), async (/** @type {import('express').Request} */ req, /** @type {import('express').Response} */ res) => {
    const orgs = await resolveOrgs(req);
    const { orgId } = orgs;
    if (!orgId) return res.status(400).json({ error: 'No organisation found' });

    await githubSyncStore.deleteOrgSyncConfig(orgId);
    await auditChosenOrg(req, orgs, 'github_sync.disconnect');
    log.info(`[GitHubSync] Disconnected for org ${orgId}`);
    res.json({ success: true });
});

// ─── Push All ────────────────────────────────────────────────────
// Trigger a full sync of all agents and skills to GitHub
router.post('/push', requirePermission('manage_agents'), async (/** @type {import('express').Request} */ req, /** @type {import('express').Response} */ res) => {
    const orgs = await resolveOrgs(req);
    const { orgId } = orgs;
    if (!orgId) return res.status(400).json({ error: 'No organisation found' });

    const userId = getEffectiveUserId(req);
    await auditChosenOrg(req, orgs, 'github_sync.push');
    const results = await githubSyncService.syncAll(orgId, userId);

    res.json({ success: true, results });
});

// ─── Push Pending ────────────────────────────────────────────────
// Push only resources that changed since last sync
router.post('/push-pending', requirePermission('manage_agents'), async (/** @type {import('express').Request} */ req, /** @type {import('express').Response} */ res) => {
    const orgs = await resolveOrgs(req);
    const { orgId } = orgs;
    if (!orgId) return res.status(400).json({ error: 'No organisation found' });

    const userId = getEffectiveUserId(req);
    await auditChosenOrg(req, orgs, 'github_sync.push_pending');
    const results = await githubSyncService.syncPending(orgId, userId);

    res.json({ success: true, results });
});

// ─── Sync Details ────────────────────────────────────────────────
// Get detailed sync state for all resources
router.get('/details', requirePermission('manage_agents'), async (/** @type {import('express').Request} */ req, /** @type {import('express').Response} */ res) => {
    const orgId = await getOrgId(req);
    if (!orgId) return res.status(400).json({ error: 'No organisation found' });

    const states = await githubSyncStore.getAllSyncStates(orgId);
    res.json(states);
});

module.exports = router;
