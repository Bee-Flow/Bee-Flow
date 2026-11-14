// @typecheck strict
/**
 * Custom Integration Runner — who may run what: the first steps of
 * executeCustomIntegrationTool (customIntegrationRunner.js), in the order it
 * runs them. The run gate, then the integration row and its slug re-assert,
 * then the organisation, status, unattended and capability checks.
 *
 * A step that refuses returns `{ refusal }`, like the steps in
 * customIntegrationSteps.js.
 */

'use strict';

/**
 * @typedef {import('./customIntegrationRunner').CustomIntegrationRow} CustomIntegrationRow
 * @typedef {import('./customIntegrationSteps').ConnectionStore & { touchLastUsed(id: string): Promise<unknown> }} ConnectionStore
 *   what a whole run needs of stores/integrationConnectionStore
 * @typedef {import('./customIntegrationSteps').Refusal} Refusal
 * @typedef {{ anyRunnable: boolean, builderEnabled: boolean, isRunnable(row: CustomIntegrationRow): boolean }} RunGate
 * @typedef {{
 *   loadRunGate(): Promise<RunGate>,
 *   integrationStore(): { getBySlug(slug: string): Promise<CustomIntegrationRow | null | undefined> },
 *   connectionStore(): ConnectionStore,
 *   getUser(userId: string): Promise<{ organizationId?: unknown } | null | undefined>,
 *   hasCapability(capability: string, who: { userId: string, orgId: string }): Promise<unknown>,
 * }} AccessDeps  what these steps reach outside the runner
 */

/**
 * Run gate — the same check that gates injection: the builder's dark-ship
 * flag for builder rows, the server-wide org MCP policy for MCP-library rows
 * (customIntegrations/mcpLibrary/gate.js). Checked here too so a stale tool
 * list (or any future injection path) can never execute once it is switched
 * off. Loaded before the row so that, with everything off, nothing is even
 * read.
 * @param {AccessDeps} deps
 * @param {boolean} isDraft  the builder's test route runs drafts; that is a builder feature
 * @returns {Promise<Refusal | RunGate>}
 */
async function openRunGate(deps, isDraft) {
    const gate = await deps.loadRunGate();
    if (!gate.anyRunnable) return { refusal: 'Custom integrations are disabled.' };
    if (isDraft && !gate.builderEnabled) return { refusal: 'Custom integrations are disabled.' };
    return gate;
}

/**
 * The integration a tool name runs: the draft the test route passed, else the
 * stored row for the slug. The slug is asserted again on the row itself (a
 * draft for another slug must not be reachable through this name), and a
 * stored row must be one the run gate lets through.
 * @param {AccessDeps} deps
 * @param {RunGate} gate
 * @param {{ prefixedName: string, slug: string, draftIntegration: CustomIntegrationRow | null }} named
 * @returns {Promise<Refusal | { integration: CustomIntegrationRow, connStore: ConnectionStore }>}
 */
async function loadIntegration(deps, gate, { prefixedName, slug, draftIntegration }) {
    const store = deps.integrationStore();
    const connStore = deps.connectionStore();
    const integration = draftIntegration || await store.getBySlug(slug);
    if (!integration) return { refusal: 'This custom integration no longer exists.' };
    if (typeof integration.slug !== 'string' || !prefixedName.startsWith(`cint_${integration.slug}_`)) {
        return { refusal: 'Unknown custom integration tool.' };
    }
    if (!draftIntegration && !gate.isRunnable(integration)) {
        return { refusal: 'This integration has been switched off by your server administrator.' };
    }
    return { integration, connStore };
}

/**
 * Capability backstop (fail-closed). Until the entitlements phase registers
 * 'custom:<uuid>' capability ids, hasCapability answers false (unknown
 * capability) and every non-draft call refuses here.
 * @param {AccessDeps} deps
 * @param {CustomIntegrationRow} integration
 * @param {{ userId: string, orgId: string }} who
 */
async function capabilityAllows(deps, integration, who) {
    try {
        return await deps.hasCapability(`custom:${integration.id}`, who);
    } catch (_) {
        return false;
    }
}

/**
 * Org isolation: the runner only ever acts inside the calling user's own org
 * (store rows are shaped camelCase: orgId). Then the status, no unattended
 * runs yet (automations and AI tasks need a per-run consent design), and the
 * capability backstop, which the caller runs deliberately BEFORE the
 * mcp_remote delegation so no kind bypasses entitlements. A draft skips the
 * status and capability checks: the builder test route pre-authorizes admins.
 * @param {AccessDeps} deps
 * @param {ConnectionStore} connStore
 * @param {CustomIntegrationRow} integration
 * @param {{ userId: string | null, isDraft: boolean, unattended: unknown }} run
 * @returns {Promise<Refusal | { userOrg: string, integrationOrg: string }>}
 */
async function authoriseRun(deps, connStore, integration, { userId, isDraft, unattended }) {
    if (!userId) return { refusal: 'User context required for custom integrations.' };
    let user = null;
    try { user = await deps.getUser(userId); } catch (_) { user = null; }
    if (!user) return { refusal: 'User context required for custom integrations.' };
    const userOrg = connStore.resolveOrgId(user.organizationId);
    const integrationOrg = connStore.resolveOrgId(integration.orgId);
    if (integrationOrg !== userOrg) return { refusal: 'This custom integration belongs to a different organization.' };
    if (!isDraft && integration.status !== 'active') {
        return { refusal: 'This custom integration is not active.' };
    }
    if (unattended === true) return { refusal: 'Custom integrations are not available in automated runs yet.' };
    if (!isDraft && !(await capabilityAllows(deps, integration, { userId, orgId: userOrg }))) {
        return { refusal: 'This custom integration is not enabled for your account. An org admin can enable it.' };
    }
    return { userOrg, integrationOrg };
}

module.exports = { openRunGate, loadIntegration, authoriseRun };
