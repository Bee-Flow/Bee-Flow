// @typecheck
/**
 * The GitHub Sync hook for agents (fire-and-forget): marks an agent pending or
 * deleted for its organisation's sync, and pushes when auto-sync is on.
 */

// ── GitHub Sync hook (fire-and-forget) ───────────────────────────
async function _notifySync(orgId, agentId, action = 'pending') {
    if (!orgId) return;
    try {
        const syncStore = require('../githubSyncStore');
        const config = await syncStore.getOrgSyncConfig(orgId);
        if (!config) return; // Sync not configured for this org
        if (action === 'deleted') {
            await syncStore.markDeleted(orgId, 'agent', agentId);
        } else {
            await syncStore.markPending(orgId, 'agent', agentId);
        }
        // When auto-sync is enabled, push the change to GitHub (debounced).
        if (config.autoSync === true) {
            require('../../services/githubSyncService').autoSyncResource(orgId, 'agent', agentId, action);
        }
    } catch (e) { /* non-fatal — sync tracking failure should never break agent ops */ }
}

module.exports = { _notifySync };
