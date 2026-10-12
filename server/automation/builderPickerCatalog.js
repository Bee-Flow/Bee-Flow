/**
 * The id lists the builder model needs to FILL an id: the agents an ai_step may
 * hand its thinking to, the knowledge bases a step may read or write, and the
 * app_event providers THIS user has.
 *
 * ── ONE SOURCE WITH THE CANVAS ──────────────────────────────────────
 * routes/automation/catalog.js (the canvas pickers) and the AI builder read
 * these from here, so the two can never offer different sets. The permission
 * filters are the canvas ones, unchanged: `agentPickerRows` for agents,
 * `canUserManageKB` for the write ability of a knowledge base, the user's own
 * resolved tool set for the providers. A list the model reads is a menu, not a
 * discovery surface, so nothing here is wider than the canvas picker.
 *
 * ── "COULD NOT READ" IS NOT "NONE" ──────────────────────────────────
 * Every function returns the list AND an error string. A failed read yields an
 * empty list plus a non-null error, never an empty list alone: a model told
 * "none" stops and tells the user they have no agents, which is a different
 * sentence than "I could not look". The renderers (builderPrompt/catalogRender)
 * keep the two apart.
 *
 * ── NO PERSONAL DATA ────────────────────────────────────────────────
 * Ids, names and descriptions of the user's own objects, as the canvas shows
 * them. Nothing about other people (no owners, no group members).
 */

'use strict';

const log = require('../telemetry/log');

/**
 * Collaborators, resolved lazily and overridable per call (`opts.deps`): the
 * stores and the permission helpers load a database, and a test injects them
 * here instead of reaching into the module cache.
 */
function defaultDeps() {
    return {
        agentStore: () => require('../stores/agentStore'),
        resolveUserGroups: (userId) => require('../auth/audience').resolveUserGroups(userId),
        resolvePrincipal: (userId) => require('../auth/datatableAccess').resolveDatatablePrincipalForUser(userId),
        kbStore: () => require('../stores/knowledgeBases'),
        askerContext: (userId) => require('../core/kb/askerContext').askerContext(userId),
        hasPermission: (userId, perm) => require('../auth').hasPermission(userId, perm),
        isOrgAdmin: async (userId) => {
            const user = await require('../stores/userStore').getUser(userId);
            return !!(user && require('../auth').isOrgAdminRole(user.orgRole));
        },
        hasFeature: (userId, feature, session) => require('../core/entitlements/betaFeatures').userHasBetaFeature(userId, feature, session),
        listInboxes: (orgId) => require('../stores/supportInboxStore').listInboxes(orgId),
        publicBaseUrl: () => require('./triggerBus').getPublicBaseUrl(),
        availableMcpServerIds: (names, userId) => require('../core/integrations/integrationTools').availableMcpServerIds(names, userId),
    };
}
const depsOf = (deps) => ({ ...defaultDeps(), ...(deps || {}) });

/**
 * The agents an ai_step may hand its thinking to: the owner's own agents plus
 * the published ones their org and groups show them, each with `canUse` and the
 * reason when not. Own-first, because `agentPickerRows` dedupes first-wins.
 *
 * @param {string} userId
 * @param {{ principal?: object|null }} [opts]  the canvas already resolved the
 *   principal from its request; the builder resolves it from the user id.
 * @returns {Promise<{agents: Array, agentsError: string|null}>}
 */
async function buildAgentPickerForUser(userId, { principal = null, deps = null } = {}) {
    const d = depsOf(deps);
    try {
        const agentStore = d.agentStore();
        const { agentPickerRows } = require('./agentPickerRows');
        const p = principal || await d.resolvePrincipal(userId);
        // The HOME organisation from the user row, the same column the save-time
        // check and the run measure against. A FAILED identity read is not a
        // policy answer: with the org null every shared org agent would come
        // back `other_org`, and the author would pull a good agent out of the
        // automation on the strength of a database hiccup.
        if (p.identityError) throw new Error(`identity unavailable (${p.identityError})`);
        const viewerOrgId = p.organizationId || null;
        const viewerGroups = await d.resolveUserGroups(userId);
        const [mine, published] = await Promise.all([
            agentStore.getAgents(userId),
            agentStore.getPublishedAgentsForUser(viewerGroups || [], viewerOrgId, null),
        ]);
        const agents = agentPickerRows([...(mine || []), ...(published || [])], {
            userId, orgId: viewerOrgId, groups: viewerGroups || [],
        });
        return { agents, agentsError: null };
    } catch (e) {
        const agentsError = e.message || 'agent list unavailable';
        log.warn('[automation/pickerCatalog] agents unavailable:', agentsError);
        return { agents: [], agentsError };
    }
}

/**
 * The knowledge bases this person can see, each with `canWrite`: the predicate
 * is the WRITE one (`canUserManageKB`), not the read one, because a knowledge_write
 * step to a base its owner may not manage is refused at save. System bases are
 * reference text the product ships and never a choice.
 *
 * Throws on a failed read; the callers decide what that means.
 *
 * @param {object} p
 * @param {string} p.userId
 * @param {Set<string>} p.orgIds       ALWAYS a Set: `canUserManageKB` reads a null as super-admin
 * @param {string[]} p.userGroups
 * @param {boolean} p.canManage        holds `manage_knowledge`
 * @param {boolean} p.isOrgAdmin
 */
async function listKnowledgeBasePicker({ userId, orgIds, userGroups, canManage, isOrgAdmin }, { deps = null } = {}) {
    const kbStore = depsOf(deps).kbStore();
    const orgSet = orgIds instanceof Set ? orgIds : new Set(Array.isArray(orgIds) ? orgIds : []);
    const kbs = await kbStore.listKBs(userId, orgSet, { sourceKind: null, isOrgAdmin: !!isOrgAdmin });
    const out = [];
    for (const kb of kbStore.filterByGroupAccess(kbs, userId, userGroups || [], { orgIds: orgSet, isOrgAdmin: !!isOrgAdmin })) {
        if (typeof kbStore.isSystemKB === 'function' && kbStore.isSystemKB(kb)) continue;
        out.push({
            id: kb.id,
            name: kb.name,
            description: kb.description || null,
            canWrite: kbStore.canUserManageKB(kb, userId, orgSet, !!canManage),
            scope: kb.organization_id ? 'org' : 'personal',
        });
    }
    return out;
}

/** The builder's version: resolves the person's context itself, off-request. */
async function buildKnowledgeBasePickerForUser(userId, { deps = null } = {}) {
    const d = depsOf(deps);
    try {
        const { orgIds, userGroups } = await d.askerContext(userId);
        const canManage = await Promise.resolve(d.hasPermission(userId, 'manage_knowledge')).catch(() => false);
        let isOrgAdmin = false;
        try { isOrgAdmin = await d.isOrgAdmin(userId); } catch (_) { isOrgAdmin = false; }
        const knowledgeBases = await listKnowledgeBasePicker({ userId, orgIds, userGroups, canManage, isOrgAdmin }, { deps });
        return { knowledgeBases, knowledgeBasesError: null };
    } catch (e) {
        const knowledgeBasesError = e.message || 'knowledge base list unavailable';
        log.warn('[automation/pickerCatalog] knowledge bases unavailable:', knowledgeBasesError);
        return { knowledgeBases: [], knowledgeBasesError };
    }
}

/**
 * The app_event providers THIS user has, catalog-ready (see
 * builderTools/triggerProviders.buildAppEventProviders). Availability derives
 * only from the user's resolved tool set plus connection-backed checks; the
 * checks are booleans and fail closed, and no connection data reaches the list.
 *
 * Throws only for what no check can absorb; every individual check is
 * fail-closed on its own.
 *
 * @param {object} p
 * @param {string} p.userId
 * @param {object|null} p.session
 * @param {Array} p.apps           the catalog's apps (`id`, `label`, `available`)
 * @param {Set<string>} p.userToolNames
 * @param {Array} p.userToolDefs   the resolved tool definitions (auto-derived providers)
 * @param {string|null} p.orgId
 */
async function buildAppEventProvidersFor({ userId, session, apps, userToolNames, userToolDefs, orgId }, { deps = null } = {}) {
    const d = depsOf(deps);
    const { buildAppEventProviders } = require('./builderTools/triggerProviders');
    const availableAppIds = new Set((apps || []).filter(a => a && a.available).map(a => a.id));

    let supportOk = false;
    try {
        if (await d.hasFeature(userId, 'support_inbox', session)) {
            const inboxes = await d.listInboxes(orgId);
            supportOk = Array.isArray(inboxes) && inboxes.length > 0;
        }
    } catch (_) { /* fail closed */ }

    // Meeting Notes is a composite capability (licence + beta + module); the
    // provider declares `availability: {kind:'check', check:'meeting_notes'}`.
    let meetingNotesOk = false;
    try {
        meetingNotesOk = await d.hasFeature(userId, 'meeting_notes', session) === true;
    } catch (_) { /* fail closed */ }

    // msgraph is webhook-only: without a public base URL it can never fire.
    let publicBaseUrl = false;
    try { publicBaseUrl = !!d.publicBaseUrl(); } catch (_) { /* fail closed */ }

    // MCP servers have no TOOL_REGISTRY row; resolve them from the same
    // userToolNames authority plus a per-user credential check.
    let availableMcpServerIds = new Set();
    try {
        availableMcpServerIds = await d.availableMcpServerIds(userToolNames, userId);
    } catch (_) { /* fail closed — no MCP providers */ }

    // Integrations with no trigger declaration still expose their read-only
    // list tools as watchable sources.
    let derivedProviders = [];
    try {
        const labels = new Map((apps || []).map(a => [a.id, a.label]));
        derivedProviders = require('./triggerSources/autoDerive')
            .deriveProviders(userToolDefs || [], { labels, mcpServerIds: availableMcpServerIds });
    } catch (_) { /* declared providers only */ }

    return buildAppEventProviders({
        availableAppIds,
        availableMcpServerIds,
        // approvals: always on — produced by the approvals feature itself.
        checks: { support: supportOk, approvals: true, meeting_notes: meetingNotesOk },
        publicBaseUrl,
        orgId,
        derivedProviders,
    });
}

/**
 * Everything the builder prompt adds to the catalog, in one call that NEVER
 * throws: each list fails on its own into its own error marker.
 *
 * @param {string} userId
 * @param {object|null} session
 * @param {object} catalog   from buildCatalogForUser
 * @param {{providers?: boolean, deps?: object}} [opts]  `providers:false` skips the app_event list; `deps` replaces collaborators (tests)
 * @returns {Promise<{agents, agentsError, knowledgeBases, knowledgeBasesError, appEventProviders, appEventProvidersError}>}
 */
async function buildPickerCatalogsForUser(userId, session, catalog, { providers: withProviders = true, deps = null } = {}) {
    const providers = (async () => {
        // The flowlet sub-agent has no trigger of its own: no providers for it.
        if (!withProviders) return {};
        try {
            const userToolNames = catalog && catalog.toolNames instanceof Set ? catalog.toolNames : new Set();
            const orgId = session?.user?.organizationId || null;
            return {
                appEventProviders: await buildAppEventProvidersFor({
                    userId, session, apps: catalog?.apps || [], userToolNames,
                    userToolDefs: catalog?.toolDefs || [], orgId,
                }, { deps }),
                appEventProvidersError: null,
            };
        } catch (e) {
            log.warn('[automation/pickerCatalog] app-event providers unavailable:', e.message);
            return { appEventProviders: [], appEventProvidersError: e.message || 'providers unavailable' };
        }
    })();
    const [agents, kbs, prov] = await Promise.all([
        buildAgentPickerForUser(userId, { deps }), buildKnowledgeBasePickerForUser(userId, { deps }), providers,
    ]);
    return { ...agents, ...kbs, ...prov };
}

module.exports = {
    buildAgentPickerForUser,
    listKnowledgeBasePicker,
    buildKnowledgeBasePickerForUser,
    buildAppEventProvidersFor,
    buildPickerCatalogsForUser,
};
