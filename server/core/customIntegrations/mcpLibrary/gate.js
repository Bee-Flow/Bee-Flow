/**
 * Which org-scoped custom integrations may run right now.
 *
 * Two families share the org_custom_integrations table and its hardened
 * runtime (org isolation, SSRF-pinned transport, origin-bound credentials,
 * capability backstop):
 *
 *   - AI Integration Builder rows: governed by the builder's dark-ship kill
 *     switch (featureFlag.js), exactly as before.
 *   - MCP library rows (kind 'mcp_remote', installed from Settings →
 *     Organisation → MCP library): governed by the server-wide org MCP policy
 *     (./policy.js), checked against the endpoint the row was ACTIVATED with.
 *
 * A row is a library row when its definition carries
 * `meta.source === 'mcp_library'`. Only the library's own install path
 * (./service.js) writes that marker. The two gates are deliberately not
 * OR-ed together: switching the builder on must not revive library servers
 * the server admin turned off, and a builder row must not run on the
 * library's say-so.
 */

const deps = require('./deps');
const { getPolicy, checkUrl } = require('./policy');
// The row classification lives on the platform side so entitlements can use it too.
const { LIBRARY_SOURCE, runningDefinition, isLibraryRow } = require('../../../stores/lib/customIntegrationSource');

/**
 * Load both switches once and return a synchronous per-row check, so a caller
 * walking every row of an org (tool injection) reads config twice, not per row.
 *
 * `anyRunnable` lets that caller skip the store entirely when both families
 * are switched off.
 */
async function loadRunGate() {
    const [builderEnabled, policy] = await Promise.all([deps.isBuilderEnabled(), getPolicy()]);
    const isRunnable = (row) => {
        if (!row) return false;
        if (isLibraryRow(row)) {
            const def = runningDefinition(row);
            return checkUrl(policy, def && def.mcp && def.mcp.url).allowed;
        }
        return builderEnabled;
    };
    return { builderEnabled, policy, anyRunnable: builderEnabled || policy.remote !== 'off', isRunnable };
}

module.exports = { LIBRARY_SOURCE, isLibraryRow, runningDefinition, loadRunGate };
