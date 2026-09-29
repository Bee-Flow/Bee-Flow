/**
 * GitHub Sync Routes — Configure and trigger sync of agent/skill configs to GitHub
 *
 * All routes require manage_agents permission.
 *
 * Only POST /configure takes input. /status, /details, DELETE /configure and
 * the two push routes read nothing but the caller's org and user id, so none
 * of them carries a schema.
 */

const express = require('express');
const log = require('../../telemetry/log');
const router = express.Router();
const { requirePermission, resolveUserOrgIds } = require('../../auth');
const githubSyncStore = require('../../stores/githubSyncStore');
const githubSyncService = require('../../services/githubSyncService');
const configStore = require('../../stores/configStore');
const { getEffectiveUserId } = require('../../utils/routeHelpers');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');

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
    repoOwner: z.string({ required_error: OWNER_TEXT, invalid_type_error: OWNER_TEXT }).trim().regex(NAME_RE, OWNER_TEXT),
    repoName: z.string({ required_error: NAME_TEXT, invalid_type_error: NAME_TEXT }).trim().regex(NAME_RE, NAME_TEXT),
    branch: z.string({ invalid_type_error: BRANCH_TEXT }).trim().regex(BRANCH_RE, BRANCH_TEXT).optional(),
    autoSync: z.boolean({ invalid_type_error: 'autoSync is true or false.' }).optional(),
}).strict();

// Helper: resolve the user's first org ID
async function getOrgId(req) {
    const orgIds = await resolveUserOrgIds(req);
    if (!orgIds || orgIds.size === 0) return null;
    return Array.from(orgIds)[0];
}

// ─── Status ──────────────────────────────────────────────────────
// Returns current sync configuration + pending change count
router.get('/status', requirePermission('manage_agents'), async (req, res) => {
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
router.post('/configure', requirePermission('manage_agents'), validate({ body: ConfigureBody }), async (req, res) => {
    const orgId = await getOrgId(req);
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

    log.info(`[GitHubSync] Configured for org ${orgId}: ${repoOwner}/${repoName} (${branch || 'main'})`);
    res.json({ success: true });
});

// ─── Disconnect ──────────────────────────────────────────────────
router.delete('/configure', requirePermission('manage_agents'), async (req, res) => {
    const orgId = await getOrgId(req);
    if (!orgId) return res.status(400).json({ error: 'No organisation found' });

    await githubSyncStore.deleteOrgSyncConfig(orgId);
    log.info(`[GitHubSync] Disconnected for org ${orgId}`);
    res.json({ success: true });
});

// ─── Push All ────────────────────────────────────────────────────
// Trigger a full sync of all agents and skills to GitHub
router.post('/push', requirePermission('manage_agents'), async (req, res) => {
    const orgId = await getOrgId(req);
    if (!orgId) return res.status(400).json({ error: 'No organisation found' });

    const userId = getEffectiveUserId(req);
    const results = await githubSyncService.syncAll(orgId, userId);

    res.json({ success: true, results });
});

// ─── Push Pending ────────────────────────────────────────────────
// Push only resources that changed since last sync
router.post('/push-pending', requirePermission('manage_agents'), async (req, res) => {
    const orgId = await getOrgId(req);
    if (!orgId) return res.status(400).json({ error: 'No organisation found' });

    const userId = getEffectiveUserId(req);
    const results = await githubSyncService.syncPending(orgId, userId);

    res.json({ success: true, results });
});

// ─── Sync Details ────────────────────────────────────────────────
// Get detailed sync state for all resources
router.get('/details', requirePermission('manage_agents'), async (req, res) => {
    const orgId = await getOrgId(req);
    if (!orgId) return res.status(400).json({ error: 'No organisation found' });

    const states = await githubSyncStore.getAllSyncStates(orgId);
    res.json(states);
});

module.exports = router;
