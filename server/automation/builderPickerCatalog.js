// @typecheck
/**
 * The id lists the builder model needs to FILL an id: the agents an ai_step may
 * hand its thinking to, the knowledge bases a step may read or write, the
 * reusable building blocks a call_block step may run, and the app_event
 * providers THIS user has.
 *
 * ── ONE SOURCE WITH THE CANVAS ──────────────────────────────────────
 * routes/automation/catalog.js (the canvas pickers) and the AI builder read
 * these from here, so the two can never offer different sets. The permission
 * filters are the canvas ones, unchanged: `agentPickerRows` for agents,
 * `canUserManageKB` for the write ability of a knowledge base,
 * `getCallableStepsForUser` plus the apps gate of the palette's Steps group for
 * building blocks, the user's own resolved tool set for the providers. A list the model reads is a menu, not a
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
const { fallback } = require('../utils/bestEffort');

/**
 * Collaborators, resolved lazily and overridable per call (`opts.deps`): the
 * stores and the permission helpers load a database, and a test injects them
 * here instead of reaching into the module cache.
 */
function defaultDeps() {
    return {
        agentStore: () => require('../stores/agentStore'),
        resolveUserGroups: (/** @type {string} */ userId) => require('../auth/audience').resolveUserGroups(userId),
        resolvePrincipal: (userId) => require('../auth/datatableAccess').resolveDatatablePrincipalForUser(userId),
        kbStore: () => require('../stores/knowledgeBases'),
        askerContext: (userId) => require('../core/kb/askerContext').askerContext(userId),
        resolvePermissionsByOrg: (/** @type {string} */ userId) => require('../auth/permissions').resolvePermissionsByOrg(userId),
        // The organisations this user administers, off-request: the session-less
        // request names the user and nothing else (no admin flag).
        resolveAdminOrgIds: (/** @type {string} */ userId) => require('../auth/permissions')
            .resolveAdminOrgIds({ session: { user: { id: userId } } }),
        hasFeature: (userId, feature, session) => require('../core/entitlements/betaFeatures').userHasBetaFeature(userId, feature, session),
        listInboxes: (/** @type {string} */ orgId) => require('../stores/supportInboxStore').listInboxes(orgId),
        publicBaseUrl: () => require('./triggerBus').getPublicBaseUrl(),
        availableMcpServerIds: (names, userId) => require('../core/integrations/integrationTools').availableMcpServerIds(names, userId),
        stepStore: () => require('../stores/automationStore'),
        resolveIntegration: (/** @type {string} */ tool) => require('../core/integrations/integrationToolMap').resolveIntegration(tool),
    };
}
const depsOf = (deps) => ({ ...defaultDeps(), ...(deps || {}) });

/**
 * The agents an ai_step may hand its thinking to: the owner's own agents plus
 * the published ones their org and groups show them, each with `canUse` and the
 * reason when not. Own-first, because `agentPickerRows` dedupes first-wins.
 *
 * @param {string} userId
 * @param {{ principal?: object|null, deps?: PickerDeps|null }} [opts]  the canvas already resolved the
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
        const agentsError = /** @type {Error} */ (e).message || 'agent list unavailable';
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
 * @param {{ userId: string, orgIds: Set<string>, userGroups: string[], manageOrgIds?: Set<string>, adminOrgIds?: Set<string> }} p
 *   orgIds: ALWAYS a Set (`canUserManageKB` reads a null as super-admin); manageOrgIds: the organisations in
 *   which the person holds `manage_knowledge`; adminOrgIds: the organisations they administer (drafts and
 *   group-restricted bases of those are listed too)
 */
async function listKnowledgeBasePicker({ userId, orgIds, userGroups, manageOrgIds, adminOrgIds }, { deps = null } = {}) {
    const kbStore = depsOf(deps).kbStore();
    const orgSet = orgIds instanceof Set ? orgIds : new Set(Array.isArray(orgIds) ? orgIds : []);
    const manageIn = manageOrgIds instanceof Set ? manageOrgIds : new Set();
    const adminIn = adminOrgIds instanceof Set ? adminOrgIds : new Set();
    const kbs = await kbStore.listKBs(userId, orgSet, { sourceKind: null, adminOrgIds: adminIn });
    const out = [];
    for (const kb of kbStore.filterByGroupAccess(kbs, userId, userGroups || [], { orgIds: orgSet, adminOrgIds: adminIn })) {
        if (typeof kbStore.isSystemKB === 'function' && kbStore.isSystemKB(kb)) continue;
        out.push({
            id: kb.id,
            name: kb.name,
            description: kb.description || null,
            canWrite: kbStore.canUserManageKB(kb, userId, orgSet, !!kb.organization_id && manageIn.has(kb.organization_id)),
            scope: kb.organization_id ? 'org' : 'personal',
        });
    }
    return out;
}

/**
 * The organisations of `orgIds` in which `byOrg` holds `permission`. A missing
 * answer (a failed read) holds in none.
 * @param {Set<string>|string[]|null|undefined} orgIds
 * @param {{ holds: (permission: string, orgId: string) => boolean } | null | undefined} byOrg
 * @param {string} permission
 * @returns {Set<string>}
 */
function orgsHolding(orgIds, byOrg, permission) {
    const list = orgIds instanceof Set ? [...orgIds] : (Array.isArray(orgIds) ? orgIds : []);
    return new Set(byOrg ? list.filter((o) => byOrg.holds(permission, o)) : []);
}

/**
 * The builder's version: resolves the person's context itself, off-request.
 * @param {string} userId
 */
async function buildKnowledgeBasePickerForUser(userId, { deps = null } = {}) {
    const d = depsOf(deps);
    try {
        const { orgIds, userGroups } = await d.askerContext(userId);
        const byOrg = await Promise.resolve().then(() => d.resolvePermissionsByOrg(userId))
            .catch((e) => fallback('automation/builderPickerCatalog:permissionsByOrg', e, null));
        const manageOrgIds = orgsHolding(orgIds, byOrg, 'manage_knowledge');
        /** @type {Set<string>} */
        let adminOrgIds = new Set();
        try {
            const resolved = await d.resolveAdminOrgIds(userId);
            if (resolved instanceof Set) adminOrgIds = resolved;
        } catch (e) { adminOrgIds = fallback('automation/builderPickerCatalog:adminOrgIds', e, new Set()); }
        const knowledgeBases = await listKnowledgeBasePicker({ userId, orgIds, userGroups, manageOrgIds, adminOrgIds }, { deps });
        return { knowledgeBases, knowledgeBasesError: null };
    } catch (e) {
        const knowledgeBasesError = /** @type {Error} */ (e).message || 'knowledge base list unavailable';
        log.warn('[automation/pickerCatalog] knowledge bases unavailable:', knowledgeBasesError);
        return { knowledgeBases: [], knowledgeBasesError };
    }
}

/**
 * The integration ids this user can use right now, from the catalog's runnable
 * apps: the gate routes/automation/catalogApps.buildSteps puts on the palette's
 * Steps group (a block that touches an app the user lacks fails mid-run).
 * @param {Array<{ id: string, available?: boolean, actions?: Array<{ name?: string }> }>} apps
 * @param {(tool: string) => { integration?: string } | null} resolve
 */
function availableIntegrationIds(apps, resolve) {
    const ids = new Set();
    for (const app of apps || []) {
        if (!app || !app.available) continue;
        ids.add(app.id);
        for (const a of app.actions || []) {
            let owner = null;
            try { owner = a && a.name ? resolve(a.name) : null; } catch (err) { fallback('automation/builderPickerCatalog:availableIntegrationIds', err); }
            if (owner && owner.integration) ids.add(owner.integration);
        }
    }
    return ids;
}

/**
 * The reusable building blocks (published Steps, kind='block') a call_block
 * step may run: the published, shared-with-me set the canvas palette lists
 * (`getCallableStepsForUser`, the org and group scope resolved off-request the
 * way the knowledge-base list does), each with its contract (inputs, outputs)
 * and `available`, false when the block touches an app this user has not
 * connected. A catalog that could not be built (`catalogError`) cannot tell, so
 * every block stays available and the run decides, the permissive posture of
 * the other gates.
 *
 * @param {string} userId
 * @param {{ apps?: Array<{ id: string, available?: boolean, actions?: Array<{ name?: string }> }>, catalogError?: string } | null} catalog
 * @returns {Promise<{ blocks: BlockRow[], blocksError: string | null }>}
 */
async function buildBlockPickerForUser(userId, catalog, { deps = null } = {}) {
    const d = depsOf(deps);
    try {
        const { orgIds, userGroups } = await d.askerContext(userId);
        const orgIdList = orgIds instanceof Set ? [...orgIds] : (Array.isArray(orgIds) ? orgIds : []);
        const callable = await d.stepStore().getCallableStepsForUser(userId, { orgIds: orgIdList, userGroups: userGroups || [] });
        const known = catalog && !catalog.catalogError ? availableIntegrationIds(catalog.apps || [], d.resolveIntegration) : null;
        const blocks = (callable || []).filter(s => s && s.id).map(s => ({
            id: s.id,
            name: s.title || s.id,
            description: s.description || '',
            category: s.category || null,
            inputs: (Array.isArray(s.params) ? s.params : []).map(p => ({
                name: p.name, type: p.type || 'string', required: !!p.required, description: p.description || '',
            })),
            outputs: Array.isArray(s.outputFields) ? s.outputFields.filter(f => typeof f === 'string') : [],
            available: !known || (s.requiredIntegrations || []).every(i => known.has(i)),
        }));
        return { blocks, blocksError: null };
    } catch (e) {
        const blocksError = /** @type {Error} */ (e).message || 'building block list unavailable';
        log.warn('[automation/pickerCatalog] building blocks unavailable:', blocksError);
        return { blocks: [], blocksError };
    }
}

/**
 * The list a step builder checks a call_block against (draftWrap._blocks):
 * null when the read failed (could not tell, so the builder stays permissive).
 * @param {{ blocks?: BlockRow[], blocksError?: string | null } | null | undefined} picker
 * @returns {BlockRow[] | null}
 */
function blockCatalogOf(picker) {
    return picker && !picker.blocksError && Array.isArray(picker.blocks) ? picker.blocks : null;
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
 * @param {{ userId: string, session: object|null, apps: Array, userToolNames: Set<string>, userToolDefs: Array, orgId: string|null }} p
 *   apps: the catalog's apps (`id`, `label`, `available`); userToolDefs: the resolved tool definitions (auto-derived providers)
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
    } catch (err) { fallback('automation/builderPickerCatalog:buildAppEventProvidersFor', err); /* fail closed */ }

    // Meeting Notes is a composite capability (licence + beta + module); the
    // provider declares `availability: {kind:'check', check:'meeting_notes'}`.
    let meetingNotesOk = false;
    try {
        meetingNotesOk = await d.hasFeature(userId, 'meeting_notes', session) === true;
    } catch (err) { fallback('automation/builderPickerCatalog:buildAppEventProvidersFor#2', err); /* fail closed */ }

    // msgraph is webhook-only: without a public base URL it can never fire.
    let publicBaseUrl = false;
    try { publicBaseUrl = !!d.publicBaseUrl(); } catch (err) { fallback('automation/builderPickerCatalog:buildAppEventProvidersFor#3', err); /* fail closed */ }

    // MCP servers have no TOOL_REGISTRY row; resolve them from the same
    // userToolNames authority plus a per-user credential check.
    let availableMcpServerIds = new Set();
    try {
        availableMcpServerIds = await d.availableMcpServerIds(userToolNames, userId);
    } catch (err) { fallback('automation/builderPickerCatalog:buildAppEventProvidersFor#4', err); /* fail closed — no MCP providers */ }

    // Integrations with no trigger declaration still expose their read-only
    // list tools as watchable sources.
    let derivedProviders = [];
    try {
        const labels = new Map((apps || []).map(a => [a.id, a.label]));
        derivedProviders = require('./triggerSources/autoDerive')
            .deriveProviders(userToolDefs || [], { labels, mcpServerIds: availableMcpServerIds });
    } catch (err) { fallback('automation/builderPickerCatalog:buildAppEventProvidersFor#5', err); /* declared providers only */ }

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
 * @param {{ user?: { organizationId?: string | null } } | null} session
 * @param {Awaited<ReturnType<typeof import('./builderCatalog').buildCatalogForUser>>} catalog   from buildCatalogForUser
 * @param {{providers?: boolean, deps?: object}} [opts]  `providers:false` skips the app_event list; `deps` replaces collaborators (tests)
 * @returns {Promise<{agents, agentsError: unknown, knowledgeBases, knowledgeBasesError: unknown, blocks: BlockRow[], blocksError: string | null, appEventProviders?: unknown, appEventProvidersError?: unknown}>}
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
            log.warn('[automation/pickerCatalog] app-event providers unavailable:', /** @type {Error} */ (e).message);
            return { appEventProviders: [], appEventProvidersError: /** @type {Error} */ (e).message || 'providers unavailable' };
        }
    })();
    const [agents, kbs, blocks, prov] = await Promise.all([
        buildAgentPickerForUser(userId, { deps }), buildKnowledgeBasePickerForUser(userId, { deps }),
        buildBlockPickerForUser(userId, catalog, { deps }), providers,
    ]);
    return { ...agents, ...kbs, ...blocks, ...prov };
}

module.exports = {
    buildAgentPickerForUser,
    listKnowledgeBasePicker,
    buildKnowledgeBasePickerForUser,
    buildBlockPickerForUser,
    blockCatalogOf,
    buildAppEventProvidersFor,
    buildPickerCatalogsForUser,
};

/** @typedef {Partial<ReturnType<typeof defaultDeps>>} PickerDeps */

/**
 * One building block as the model and the call_block builder read it.
 * @typedef {{ id: string, name: string, description: string, category: string | null,
 *   inputs: Array<{ name: string, type: string, required: boolean, description: string }>,
 *   outputs: string[], available: boolean }} BlockRow
 */
