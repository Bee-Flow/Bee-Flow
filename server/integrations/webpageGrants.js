/**
 * Webpage bridge grants — shared grant/revoke/verify logic used by BOTH the
 * studio-AI bridge tools (integrations/webpageBridgeTools.js) and the owner
 * REST endpoints (routes/webpagesGrants.js). Keeping one code path means the
 * AI and the UI can never diverge on what may be granted.
 *
 * Availability is FAIL-CLOSED: a tool may only be granted when it is in the
 * author's resolved tool set (getIntegrationTools — the same authority the
 * runtime uses: org grant ∩ group grant ∩ personal toggle ∩ credentials). A
 * tool the author hasn't connected is rejected with `connection_required` +
 * `provider` so the caller (chat or UI) can point at Settings → Integrations.
 *
 * Every store/registry touch goes through an injectable deps bag resolved
 * LAZILY, so a fully-injected unit test never loads a store (DB handle) or a
 * throwing integration module at all (`node --test integrations/webpageGrants.test.js`).
 */

/**
 * Merge caller overrides over the real implementations. Stores and the tool
 * registry are required only when the corresponding dep was NOT overridden —
 * some integration modules throw at require time (env-dependent stores) and
 * every store pins a DB pool, so eager top-level requires made the unit tests
 * hang/crash.
 */
function resolveDeps(_deps = {}) {
    const d = { ..._deps };
    if (!d.getIntegrationTools) d.getIntegrationTools = require('../core/integrations/integrationTools').getIntegrationTools;
    if (!d.findOwnerOfTool || !d.loadRegistry) {
        const registry = require('../automation/toolRegistry');
        if (!d.findOwnerOfTool) d.findOwnerOfTool = registry.findOwnerOfTool;
        if (!d.loadRegistry) {
            d.loadRegistry = () => registry.TOOL_REGISTRY.map((entry) => {
                // loadTools requires the integration's module; a module that
                // throws at load (e.g. a store demanding SESSION_SECRET) must
                // not take down listing — skip it, its tools stay ungrantable.
                try { return { entry, tools: registry.loadTools(entry) }; }
                catch { return { entry, tools: [] }; }
            });
        }
    }
    if (!d.getBridgeGrants || !d.upsertEntry || !d.removeEntry) {
        const store = require('../stores/webpageStore');
        if (!d.getBridgeGrants) d.getBridgeGrants = store.getBridgeGrants;
        if (!d.upsertEntry) d.upsertEntry = store.upsertBridgeGrantEntry;
        if (!d.removeEntry) d.removeEntry = store.removeBridgeGrantEntry;
    }
    if (!d.getAutomation || !d.getAutomationsForUser) {
        const store = require('../stores/automationStore');
        if (!d.getAutomation) d.getAutomation = store.getAutomation;
        if (!d.getAutomationsForUser) d.getAutomationsForUser = store.getAutomationsForUser;
    }
    return d;
}

/** Error carrying an HTTP-shaped contract ({ status, code, provider }). */
function grantError(status, message, code, provider) {
    const err = new Error(message);
    err.status = status;
    if (code) err.code = code;
    if (provider) err.provider = provider;
    return err;
}

/**
 * The set of integration tool names the author can actually run right now.
 * THROWS when discovery fails — callers decide how to surface it, but no
 * caller may treat "couldn't check" as "everything is available" (that was
 * the old fail-open fallback in webpage_list_my_integrations).
 */
async function resolveAvailableToolNames({ userId, session }, deps) {
    const result = await deps.getIntegrationTools({ userId, session, isAdmin: !!session?.isAdmin });
    return new Set((result.tools || []).map(t => t?.function?.name).filter(Boolean));
}

/**
 * Grant one integration tool to a webpage. Resolves to { success, tool,
 * integrationId, grants } or throws a grantError.
 */
async function grantIntegration({ webpageId, userId, session, tool, fixedArgs, label }, _deps = {}) {
    const deps = resolveDeps(_deps);
    if (typeof tool !== 'string' || !tool.trim()) throw grantError(400, 'tool is required');
    const owner = deps.findOwnerOfTool(tool);
    if (!owner) throw grantError(404, `Unknown tool: ${tool}`);
    let available;
    try {
        available = await resolveAvailableToolNames({ userId, session }, deps);
    } catch {
        throw grantError(503, 'Could not verify your connected apps just now — try again in a moment.', 'availability_check_failed');
    }
    if (!available.has(tool)) {
        throw grantError(
            409,
            `Connect ${owner.label || owner.app} to your account first (Settings → Integrations), then add it to the page.`,
            'connection_required',
            owner.app,
        );
    }
    const entry = { tool };
    if (fixedArgs && typeof fixedArgs === 'object') entry.fixedArgs = fixedArgs;
    if (label) entry.label = String(label);
    const merged = await deps.upsertEntry(webpageId, userId, 'integrations', entry);
    if (!merged) throw grantError(404, 'Webpage not found or read-only');
    return { success: true, tool, integrationId: owner.app, grants: merged };
}

async function revokeIntegration({ webpageId, userId, tool }, _deps = {}) {
    const deps = resolveDeps(_deps);
    if (typeof tool !== 'string' || !tool.trim()) throw grantError(400, 'tool is required');
    const merged = await deps.removeEntry(webpageId, userId, 'integrations', tool);
    if (!merged) throw grantError(404, 'Webpage not found or read-only');
    return { success: true, removed: tool, grants: merged };
}

/**
 * Grant one of the author's OWN automations to a webpage (the bridge runs
 * acts-as-author, so lending someone else's automation would be a privilege
 * escalation — same check the chat tool has always done).
 */
async function grantAutomation({ webpageId, userId, automationId, label }, _deps = {}) {
    const deps = resolveDeps(_deps);
    if (typeof automationId !== 'string' || !automationId.trim()) throw grantError(400, 'automationId is required');
    const a = await deps.getAutomation(automationId).catch(() => null);
    if (!a) throw grantError(404, `Automation ${automationId} not found`);
    if (a.userId !== userId) throw grantError(403, 'You can only grant your own automations');
    const entry = { automationId, ...(label ? { label: String(label) } : {}) };
    const merged = await deps.upsertEntry(webpageId, userId, 'automations', entry);
    if (!merged) throw grantError(404, 'Webpage not found or read-only');
    return { success: true, automationId, title: a.title, grants: merged };
}

async function revokeAutomation({ webpageId, userId, automationId }, _deps = {}) {
    const deps = resolveDeps(_deps);
    if (typeof automationId !== 'string' || !automationId.trim()) throw grantError(400, 'automationId is required');
    const merged = await deps.removeEntry(webpageId, userId, 'automations', automationId);
    if (!merged) throw grantError(404, 'Webpage not found or read-only');
    return { success: true, removed: automationId, grants: merged };
}

/** The author's automations, shaped for a picker (chat tool + REST share this). */
async function listAuthorAutomations({ userId }, _deps = {}) {
    const deps = resolveDeps(_deps);
    const list = await deps.getAutomationsForUser(userId).catch(() => []);
    return list.map(a => ({
        automationId: a.id,
        title: a.title,
        description: a.description || '',
        isActive: !!a.isActive,
        isDraft: !!a.isDraft,
        triggerType: a.triggerType,
    }));
}

/**
 * The author's connected integration tools, flattened from the registry and
 * filtered by the resolved tool set. When discovery fails, resolves to
 * { integrations: [], discoveryFailed: true } — fail closed, never the
 * registry-wide view.
 */
async function listAvailableIntegrations({ userId, session }, _deps = {}) {
    const deps = resolveDeps(_deps);
    let availableNames;
    try {
        availableNames = await resolveAvailableToolNames({ userId, session }, deps);
    } catch {
        return { integrations: [], discoveryFailed: true };
    }
    const out = [];
    for (const { entry, tools } of deps.loadRegistry()) {
        for (const t of tools) {
            const name = t?.function?.name;
            if (!name || !availableNames.has(name)) continue;
            out.push({
                tool: name,
                label: name.replace(/_/g, ' '),
                description: t.function?.description || '',
                integrationId: entry.app,
                integrationLabel: entry.label,
            });
        }
    }
    return { integrations: out };
}

/**
 * Read-model for the IDE panel: the webpage's current grants with each
 * integration entry enriched with registry metadata and a live `available`
 * flag (false → the author disconnected the app after granting; the UI shows
 * "needs reconnect"). When availability discovery fails the flag is null and
 * `discoveryFailed` is set — the UI shows status as unknown, never as OK.
 */
async function describeGrants({ webpageId, userId, session }, _deps = {}) {
    const deps = resolveDeps(_deps);
    const grants = await deps.getBridgeGrants(webpageId);
    let availableNames = null;
    try {
        availableNames = await resolveAvailableToolNames({ userId, session }, deps);
    } catch { /* null → per-entry available: null */ }
    const integrations = (grants.integrations || []).map((g) => {
        const owner = deps.findOwnerOfTool(g.tool) || null;
        return {
            tool: g.tool,
            label: g.label || null,
            hasFixedArgs: !!(g.fixedArgs && Object.keys(g.fixedArgs).length),
            integrationId: owner?.app || null,
            integrationLabel: owner?.label || null,
            available: availableNames ? availableNames.has(g.tool) : null,
        };
    });
    const automations = (grants.automations || []).map(g => ({
        automationId: g.automationId,
        label: g.label || null,
    }));
    return { ai: grants.ai, integrations, automations, discoveryFailed: availableNames === null };
}

module.exports = {
    grantError,
    grantIntegration,
    revokeIntegration,
    grantAutomation,
    revokeAutomation,
    listAuthorAutomations,
    listAvailableIntegrations,
    describeGrants,
};
