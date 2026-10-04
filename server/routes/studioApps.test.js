/**
 * Route tests for /api/studio-apps (routes/studioApps.js).
 *
 * The stores (studioAppStore, automationStore, userStore) and the auth
 * helpers are mocked via the Module._resolveFilename harness (same pattern
 * as auth/studioAuthz.test.js) so no DB/pool is opened; the appStudio layer
 * (componentSpecs / canonicalize / validate / templates) runs for real.
 * Requests go over real HTTP against express app.listen(0).
 *
 * Run: node --test routes/studioApps.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const Module = require('module');

// ── Fixtures ────────────────────────────────────────────────────────

const GROUPS = [
    { id: 'grp-a1', name: 'A1', organizationId: 'orgA' },
    { id: 'grp-a2', name: 'A2', organizationId: 'orgA' },
    { id: 'grp-b1', name: 'B1', organizationId: 'orgB' },
];

const USERS = {
    owner: { id: 'owner', displayName: 'Owner One', email: 'owner@example.test', organizationId: 'orgA', groups: ['grp-a1'] },
    orgmate: { id: 'orgmate', displayName: 'Org Mate', email: 'orgmate@example.test', organizationId: 'orgA', groups: ['grp-a1'] },
    // Org admin of orgA — passes requirePrimaryOrgAdmin (orgRole + own org).
    orgadmin: { id: 'orgadmin', displayName: 'Org Admin', email: 'admin@example.test', organizationId: 'orgA', orgRole: 'org_admin', groups: ['grp-a1'] },
    wronggroup: { id: 'wronggroup', displayName: 'Wrong Group', email: 'wronggroup@example.test', organizationId: 'orgA', groups: ['grp-a2'] },
    outsider: { id: 'outsider', displayName: 'Out Sider', email: 'outsider@example.test', organizationId: 'orgB', groups: ['grp-b1'] },
    // Ordinary member of orgA who may USE App Studio but not build with it.
    nopermission: { id: 'nopermission', displayName: 'No Permission', email: 'noperm@example.test', organizationId: 'orgA', groups: ['grp-a1'] },
};

const AUTOMATIONS = {
    owner: [
        { id: 'auto-1', userId: 'owner', isActive: true },
        { id: 'auto-off', userId: 'owner', isActive: false },
    ],
};

// ── Mock studioAppStore (in-memory, mirrors the real contract) ──────

function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }

const state = {
    apps: new Map(),
    versions: [],
    nextApp: 0,
    nextVersion: 0,
    forceTooLarge: false, // makes saveDefinition throw code='definition_too_large'
    // `${userId}:${projectId}` → role, the Solution-membership stand-in behind
    // canReadStudioAppAsync.
    projectRoles: {},
};

function metaOf(a) {
    const { definition, publishedDefinition, ...meta } = a;
    return clone(meta);
}

const mockStudioAppStore = {
    async createStudioApp({ userId, organizationId, name, description, icon, accentColor, definition,
        templateId, templateVersion, templateInstallHash } = {}) {
        const id = `app-${++state.nextApp}`;
        const now = new Date().toISOString();
        const app = {
            id, userId,
            organizationId: organizationId || null,
            name: name || 'Untitled app',
            description: description || '',
            icon: icon || null,
            accentColor: accentColor || null,
            definition: clone(definition),
            definitionVersion: 1,
            publishedDefinition: null,
            publishedVersion: null,
            isPublished: false,
            sharedGroups: [],
            nextcloudMenu: false,
            publishedAt: null,
            createdAt: now,
            updatedAt: now,
            // Template provenance — same nullability as the real store.
            templateId: templateId || null,
            templateVersion: Number.isInteger(templateVersion) ? templateVersion : null,
            templateInstallHash: templateInstallHash || null,
        };
        state.apps.set(id, app);
        return clone(app);
    },
    async setTemplateStamp(id, ownerId, { templateVersion, templateInstallHash } = {}) {
        const a = state.apps.get(id);
        if (!a || a.userId !== ownerId) return false;
        a.templateVersion = Number.isInteger(templateVersion) ? templateVersion : null;
        a.templateInstallHash = templateInstallHash || null;
        return true;
    },
    // Raw lookup (callers gate). Deliberately rides a builderSession along —
    // the REAL store never does — to prove the route strips it defensively.
    async getStudioApp(id) {
        const a = state.apps.get(id);
        return a ? { ...clone(a), builderSession: { messages: ['SECRET-BUILDER-CHAT'] } } : null;
    },
    async getStudioAppsByUser(userId) {
        return [...state.apps.values()].filter(a => a.userId === userId).map(metaOf);
    },
    async getAccessibleStudioApps(userId, userGroupIds = [], userOrgIds = []) {
        return [...state.apps.values()]
            .filter(a => mockStudioAppStore.canReadStudioApp(a, userId, userGroupIds, userOrgIds))
            .map(metaOf);
    },
    async updateStudioApp(id, updates = {}, ownerId) {
        const a = state.apps.get(id);
        if (!a || a.userId !== ownerId) return null;
        for (const k of ['name', 'description', 'icon', 'accentColor', 'category']) {
            if (updates[k] !== undefined) a[k] = updates[k];
        }
        return clone(a);
    },
    async saveDefinition(id, ownerId, definition, { expectedVersion = null } = {}) {
        if (state.forceTooLarge) {
            const err = new Error('App definition exceeds the byte ceiling');
            err.code = 'definition_too_large';
            throw err;
        }
        const a = state.apps.get(id);
        if (!a || a.userId !== ownerId) return { ok: false, notFound: true };
        if (expectedVersion != null && a.definitionVersion !== expectedVersion) {
            return { ok: false, conflict: true, currentVersion: a.definitionVersion, definition: clone(a.definition) };
        }
        a.definition = clone(definition);
        a.definitionVersion += 1;
        return { ok: true, version: a.definitionVersion };
    },
    async setStudioAppPublished(id, isPublished, ownerId, sharedGroups = undefined, organizationId = undefined, _publishedDefinition = undefined, publishedVersion = undefined) {
        const a = state.apps.get(id);
        if (!a || a.userId !== ownerId) return false;
        a.isPublished = !!isPublished;
        if (sharedGroups !== undefined) a.sharedGroups = sharedGroups || [];
        if (organizationId !== undefined) a.organizationId = organizationId || null;
        if (isPublished) {
            a.publishedDefinition = clone(a.definition);
            a.publishedVersion = Number.isInteger(publishedVersion) ? publishedVersion : a.definitionVersion;
            a.publishedAt = new Date().toISOString();
            state.versions.push({
                id: `ver-${++state.nextVersion}`, appId: id, userId: ownerId,
                definition: clone(a.definition), summary: 'Published',
                createdAt: new Date().toISOString(),
            });
        }
        return true;
    },
    async deleteStudioApp(id, ownerId) {
        const a = state.apps.get(id);
        if (!a || a.userId !== ownerId) return null;
        state.apps.delete(id);
        state.versions = state.versions.filter(v => v.appId !== id);
        return clone(a);
    },
    async setStudioAppNextcloudMenu(id, ownerId, enabled) {
        const a = state.apps.get(id);
        if (!a || a.userId !== ownerId) return null;
        a.nextcloudMenu = !!enabled;
        return metaOf(a);
    },
    async listVersions(appId, ownerId) {
        return state.versions
            .filter(v => v.appId === appId && v.userId === ownerId)
            .map(({ definition, userId, ...meta }) => clone(meta));
    },
    async getVersion(appId, versionId, ownerId) {
        const v = state.versions.find(x => x.id === versionId && x.appId === appId && x.userId === ownerId);
        return v ? clone(v) : null;
    },
    async restoreVersion(appId, versionId, ownerId) {
        const v = state.versions.find(x => x.id === versionId && x.appId === appId && x.userId === ownerId);
        const a = state.apps.get(appId);
        if (!v || !a || a.userId !== ownerId) return null;
        a.definition = clone(v.definition);
        a.definitionVersion += 1;
        return clone(a);
    },
    // The project-widened read predicate — same shape as the real store's:
    // consulted only after the sync one says no, publication still required,
    // and membership decided by state.projectRoles.
    async canReadStudioAppAsync(app, userId, userGroupIds = [], userOrgIds = []) {
        if (mockStudioAppStore.canReadStudioApp(app, userId, userGroupIds, userOrgIds)) return true;
        if (!app || !app.projectId || !userId || !app.isPublished) return false;
        return !!state.projectRoles[`${userId}:${app.projectId}`];
    },
    // Pure predicates — same semantics as the real store.
    canReadStudioApp(app, userId, userGroupIds = [], userOrgIds = []) {
        if (!app) return false;
        if (app.userId === userId) return true;
        if (!app.isPublished) return false;
        if (!app.organizationId) return false;
        const orgIds = Array.isArray(userOrgIds) ? userOrgIds : [...(userOrgIds || [])];
        if (!orgIds.includes(app.organizationId)) return false;
        const groups = Array.isArray(app.sharedGroups) ? app.sharedGroups : [];
        if (groups.length === 0) return true;
        return groups.some(g => userGroupIds.includes(g));
    },
    canWriteStudioApp(app, userId) {
        return !!app && app.userId === userId;
    },
};

// ── Mock studioAppDataStore (feeds rlsGateway.resolveViewerRole) ────
// The gateway itself runs FOR REAL — only its membership lookup and the
// route's data-model read are stubbed here.

const dataState = {
    models: new Map(),   // appId → data model
    members: new Map(),  // `${appId}:${userId}` → roleKey
    datasets: new Map(), // appId → [{ id }]
};

const mockStudioAppDataStore = {
    async getDataModel(appId, _ownerId) {
        const model = dataState.models.get(appId);
        return model ? { model: clone(model), modelVersion: 1 } : null;
    },
    async listDatasets(appId, _ownerId) {
        return clone(dataState.datasets.get(appId) || []);
    },
    async getMemberRole(appId, userId) {
        return dataState.members.get(`${appId}:${userId}`) || null;
    },
};

// ── Mock automationStore / userStore / auth helpers ─────────────────

const mockAutomationStore = {
    getAutomationsForUser: async (userId) => clone(AUTOMATIONS[userId] || []),
};

const mockUserStore = {
    getUser: async (id) => clone(USERS[id]) || null,
    getAllGroups: async () => clone(GROUPS),
    getOrganization: async (id) => (id === 'orgA'
        ? { id: 'orgA', name: 'Org A' }
        : (id === 'orgB' ? { id: 'orgB', name: 'Org B' } : null)),
};

// The connector push (appStudio/nextcloudMenuSync.js) is mocked as a recorder:
// which routes ask the connector to sync, for which org, and whether they wait
// for the answer. `outcome` is what the fake connector answers.
const ncMenuSyncCalls = [];
const mockNextcloudMenuSync = {
    outcome: 'synced',
    async requestMenuSync(orgId, meta = {}) {
        ncMenuSyncCalls.push({ orgId, ...meta, awaited: true });
        return { outcome: mockNextcloudMenuSync.outcome, ms: 1 };
    },
    notifyMenuChange(orgId, meta = {}) {
        ncMenuSyncCalls.push({ orgId, ...meta, awaited: false });
    },
};

const mockAuth = {
    // Same behavior as auth/permissions.validateSharedGroupsForOrg, driven by
    // the GROUPS fixture.
    validateSharedGroupsForOrg: async (orgId, sharedGroupIds) => {
        if (sharedGroupIds === undefined || sharedGroupIds === null) return undefined;
        if (!Array.isArray(sharedGroupIds)) {
            const e = new Error('sharedGroups must be an array'); e.status = 400; throw e;
        }
        const ids = Array.from(new Set(sharedGroupIds.filter(Boolean)));
        if (ids.length === 0) return [];
        if (!orgId) {
            const e = new Error('Cannot assign shared groups: resource has no organisation'); e.status = 400; throw e;
        }
        const orgGroupIds = new Set(GROUPS.filter(g => g.organizationId === orgId).map(g => g.id));
        const invalid = ids.filter(id => !orgGroupIds.has(id));
        if (invalid.length > 0) {
            const e = new Error(`Invalid groups for this organisation: ${invalid.join(', ')}`); e.status = 400; throw e;
        }
        return ids;
    },
};

// ── Mock studioAppQuota (the org-usage read side) ───────────────────
// The real module does raw Postgres aggregates; here it's a thin in-memory
// stand-in the /usage and /mine tests drive via quotaState.
const quotaState = {
    dbSizes: {},        // appId → db_size bytes (feeds /mine storage pill)
    orgTotals: {},      // orgId → { dbBytes, attachmentBytes, totalBytes }
    breakdown: {},      // orgId → per-app rows
};
const mockStudioAppQuota = {
    appDbSizes: async (ids) => {
        const out = {};
        for (const id of (Array.isArray(ids) ? ids : [])) {
            if (quotaState.dbSizes[id] != null) out[id] = quotaState.dbSizes[id];
        }
        return out;
    },
    orgUsage: async (orgId) => quotaState.orgTotals[orgId] || { dbBytes: 0, attachmentBytes: 0, totalBytes: 0 },
    orgAppBreakdown: async (orgId) => clone(quotaState.breakdown[orgId] || []),
};

// ── Mock templateInstall (the data-side instantiation path) ─────────
// Spy on the create-from-template data install so the route tests can assert
// it fires (and that the create survives an install failure) without opening
// SQLite/Postgres through the real writeRecord path.
const installState = {
    calls: [],
    result: { ok: true, appId: null, dataModelVersion: 1 },
    throwErr: null,
};
const mockTemplateInstall = {
    installTemplate: async ({ appId, ownerId, template, seedMode } = {}) => {
        installState.calls.push({ appId, ownerId, template, seedMode });
        if (installState.throwErr) throw installState.throwErr;
        return { ...installState.result, appId };
    },
};

// ── Mock appContentInstall (the archive's rows + documents) ─────────
// Spied for the same reason templateInstall is: the real one goes through
// writeRecord and storeDerivedFile, which means a database and a blob store.
// What the ROUTE has to get right is what it hands over and what it does with
// the answer, and that is testable without either.
const contentState = { calls: [], result: { ok: true, rows: 0, files: 0, skipped: [] } };
const mockAppContentInstall = {
    installAppContent: async ({ app, model, content } = {}) => {
        contentState.calls.push({ appId: app && app.id, model, content });
        return contentState.result;
    },
};

// ── Mock templates registry (thin delegate over the REAL one) ───────
// The template-upgrade tests need a registry that ships a NEWER version of a
// real template; overriding here keeps canonicalize/validate and the real
// definitions in play while letting a test dial one template's version up.
//
// Required WITH the .js extension on purpose: Node caches relative require
// RESOLUTIONS per (parent dir, request string), and this test file lives in
// the same directory as the router — pre-resolving the router's exact
// '../appStudio/templates' request here would let the router bypass the
// patched _resolveFilename below and load the real module instead of the mock.
const realTemplates = require('../appStudio/templates.js');
const templatesState = { versionOverrides: {} }; // templateId → version
const mockTemplates = {
    TEMPLATES: realTemplates.TEMPLATES,
    listTemplates: realTemplates.listTemplates,
    templateVersion: realTemplates.templateVersion,
    getTemplate: (id) => {
        const t = realTemplates.getTemplate(id);
        if (!t) return null;
        const v = templatesState.versionOverrides[id];
        return v ? { ...t, version: v } : t;
    },
};

// The router reads templates through appStudio/templateRegistry (built-in +
// captured, one list), so the version-override mock has to be injected THERE
// too: templateRegistry requires './templates', a different request string
// from the router's '../appStudio/templates', and would otherwise load the
// real module and quietly ignore every override below.
function asBuiltIn(t) { return t ? { ...t, source: 'builtin' } : null; }
const mockTemplateRegistry = {
    listBuiltIn: () => mockTemplates.listTemplates().map((t) => ({ ...t, source: 'builtin' })),
    listAvailableTemplates: async () => mockTemplates.listTemplates().map((t) => ({ ...t, source: 'builtin' })),
    resolveTemplate: async (id) => asBuiltIn(mockTemplates.getTemplate(id)),
    templateResolverFor: () => async (id) => asBuiltIn(mockTemplates.getTemplate(id)),
    templateVersion: realTemplates.templateVersion,
};

// Captured templates live in Postgres; the route only needs the predicates and
// the delete path here, and no test in this file creates one.
const capturedState = { rows: {}, deleted: [] };
const mockStudioAppTemplateStore = {
    isCapturedTemplateId: (id) => typeof id === 'string' && id.startsWith('utpl_'),
    canRead: () => true,
    async getTemplateById(id) { return capturedState.rows[id] || null; },
    async listTemplatesFor() { return []; },
    async saveTemplate(args) { return { ...args, id: 'utpl_test', version: 1 }; },
    async deleteTemplate(id, userId, { force = false } = {}) {
        const row = capturedState.rows[id];
        if (!row) return { ok: false, notFound: true };
        if (!force && row.createdBy !== userId) return { ok: false, forbidden: true };
        capturedState.deleted.push(id);
        delete capturedState.rows[id];
        return { ok: true };
    },
};

const mockAudience = {
    resolveAudienceContext: async (req) => {
        const userId = req.session?.user?.id || null;
        const u = USERS[userId];
        return {
            userId,
            orgIds: new Set(u?.organizationId ? [u.organizationId] : []),
            userGroups: u?.groups || [],
        };
    },
    resolveUserGroups: async (userId) => USERS[userId]?.groups || [],
};

// ── Mock auth/permissions — only the permission CHECK ───────────────
// The routes require '../auth/permissions'; this file previously mocked only
// '../auth', a different specifier, so the real permissions module loaded and
// its DB-backed requirePermission denied every fixture session. That was
// invisible until the write routes grew a `manage_apps` gate, at which point 34
// unrelated tests failed on "Permission 'manage_apps' required".
//
// So: keep the real module — requireAuth and requirePrimaryOrgAdmin already
// behave correctly against the session stand-in — and replace ONLY the
// permission lookup with the PERMISSIONS fixture below. Wrapping rather than
// replacing matters: a hand-written requireAuth would drift from the real one
// and these tests would stop saying anything about authentication.

// Who holds which permission. `owner` and `orgmate` build apps; `wronggroup`
// and `outsider` deliberately do NOT, so the gate has something to refuse.
// `wronggroup` and `outsider` DO hold manage_apps. That is deliberate: they are
// members of their own org and may build apps there, and the tests that use them
// are about OWNERSHIP and org scoping — "a stranger gets a uniform 404" only
// tests anything if the stranger gets past the permission gate first. Without
// this they would 403 at the gate and the ownership assertion would never run,
// which would quietly retire four anti-enumeration tests.
//
// The gate itself is covered separately by `nopermission` below: one property
// per test, rather than one test that happens to fail for two reasons.
const PERMISSIONS = {
    owner: ['manage_apps'],
    orgmate: ['manage_apps'],
    orgadmin: ['all'],
    wronggroup: ['manage_apps'],
    outsider: ['manage_apps'],
    nopermission: [],
};

// Filled in AFTER the resolve hook is installed — see the assignment below the
// hook. Loading the real module before the hook would give ITS OWN requires
// (userStore in particular) the real modules instead of the mocks, which broke
// the two /usage tests in a way that looked nothing like its cause.
let realPermissions = null;

const mockPermissions = {
    // Everything except the permission check is delegated to the real module,
    // so requireAuth and requirePrimaryOrgAdmin keep behaving exactly as they do
    // in production. A hand-written stand-in would drift and these tests would
    // stop saying anything about authentication.
    __proto__: new Proxy({}, { get: (_t, prop) => realPermissions?.[prop] }),
    requirePermission: (permissionId) => (req, res, next) => {
        const uid = req.session?.user?.id;
        if (!uid) return res.status(401).json({ error: 'Not authenticated' });
        const held = PERMISSIONS[uid] || [];
        if (held.includes('all') || held.includes(permissionId)) return next();
        return res.status(403).json({ error: `Permission '${permissionId}' required` });
    },
};

// ── Require-cache injection (before the router loads) ───────────────

const MOCKS = {
    '../stores/studioAppStore': mockStudioAppStore,
    '../stores/studioAppDataStore': mockStudioAppDataStore,
    '../stores/automationStore': mockAutomationStore,
    '../stores/userStore': mockUserStore,
    '../auth': mockAuth,
    '../auth/permissions': mockPermissions,
    '../auth/audience': mockAudience,
    '../appStudio/studioAppQuota': mockStudioAppQuota,
    '../appStudio/nextcloudMenuSync': mockNextcloudMenuSync,
    '../appStudio/templateInstall': mockTemplateInstall,
    '../appStudio/appContentInstall': mockAppContentInstall,
    '../appStudio/templates': mockTemplates,
    '../appStudio/templateRegistry': mockTemplateRegistry,
    '../stores/studioAppTemplateStore': mockStudioAppTemplateStore,
};
const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) return MOCK_IDS[request];
    return originalResolve.call(this, request, parent, ...rest);
};

// NOW the hook is in place, so permissions.js's own requires (userStore, …)
// resolve to the mocks. WITH the .js extension for the reason this file records
// above about '../appStudio/templates': Node caches relative resolutions per
// (parent dir, request string), and this test lives in the router's directory —
// pre-resolving the router's exact '../auth/permissions' request here would let
// the router bypass the hook and load the real module.
realPermissions = require('../auth/permissions.js');

const express = require('express');
const router = require('./studioApps');
// The owner's Studio tables: the one lookup in appStudio/datatableSource that
// needs a database. The rest of that module runs for real (the dry run reads
// rows through it). `null` is what the real one answers when it cannot read
// the owner's identity — the validator then falls back to warnings.
const datatableSource = require('../appStudio/datatableSource');
let ownerDatatables = null;
datatableSource.listOwnerDatatableIds = async () => ownerDatatables;
const { emptyDefinition, COMPONENT_TYPES, ACTION_KINDS } = require('../appStudio/componentSpecs');
const { validateAppDefinition } = require('../appStudio/validate');
const { DATA_LIMITS } = require('../appStudio/dataModel');
const { hashDefinition } = require('../appStudio/templateUpgrade');

// ── HTTP harness ────────────────────────────────────────────────────

let server;
let baseUrl;

test.before(async () => {
    const app = express();
    app.use(express.json());
    // Session stand-in: x-test-user selects one of the USERS fixtures.
    app.use((req, res, next) => {
        const uid = req.headers['x-test-user'];
        if (uid && USERS[uid]) req.session = { isAuthenticated: true, user: { id: uid } };
        next();
    });
    app.use('/api/studio-apps', router);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}/api/studio-apps`;
});

test.after(async () => {
    await new Promise((resolve) => server.close(resolve));
});

async function api(method, path, { user, body } = {}) {
    const headers = {};
    if (user) headers['x-test-user'] = user;
    let payload;
    if (body !== undefined) {
        headers['content-type'] = 'application/json';
        payload = JSON.stringify(body);
    }
    const res = await fetch(`${baseUrl}${path}`, { method, headers, body: payload });
    let json = null;
    try { json = await res.json(); } catch (_) { /* empty/non-JSON body */ }
    return { status: res.status, body: json };
}

// Draft with a button wired to a run_automation action.
function draftWithAutomation(automationId) {
    const def = emptyDefinition('Wired app');
    def.actions = { act_run001: { kind: 'run_automation', automationId, inputMapping: {} } };
    def.screens[0].sections[0].children.push({
        id: 'cmp_btn001', type: 'button',
        props: { label: 'Go', variant: 'primary', role: 'button' },
        style: { span: 3 }, visible: true, onClick: 'act_run001',
    });
    return def;
}

// Structurally broken: navigate to a screen that does not exist (confirmed
// unrepairable by canonicalize — validate flags action.navigate_unresolved).
function brokenDraft() {
    const def = emptyDefinition('Broken app');
    def.actions = { act_nav001: { kind: 'navigate', screenId: 'scr_nonexist' } };
    return def;
}

async function createApp(user, body = {}) {
    const res = await api('POST', '/', { user, body });
    assert.strictEqual(res.status, 200, `create failed: ${JSON.stringify(res.body)}`);
    return res.body.app;
}

// ── Tests ───────────────────────────────────────────────────────────

test('all endpoints require auth (401 without a session)', async () => {
    for (const [method, path] of [
        ['GET', '/catalog'], ['GET', '/templates'], ['GET', '/'], ['GET', '/mine'],
        ['POST', '/'], ['GET', '/x'], ['PUT', '/x'], ['PUT', '/x/definition'],
        ['PATCH', '/x/publish'], ['POST', '/x/template-upgrade'], ['PATCH', '/x/nextcloud-menu'],
        ['DELETE', '/x'], ['GET', '/x/versions'],
        ['POST', '/x/versions/y/restore'], ['GET', '/x/runtime'], ['GET', '/x/ref'],
    ]) {
        const res = await api(method, path, method === 'GET' ? {} : { body: {} });
        assert.strictEqual(res.status, 401, `${method} ${path} should 401`);
    }
});

test('GET /catalog serves the componentSpecs catalog verbatim', async () => {
    const res = await api('GET', '/catalog', { user: 'owner' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.schemaVersion, 2);
    assert.strictEqual(Object.keys(res.body.components).length, COMPONENT_TYPES.length);
    // Against the IMPORTED list, not a second copy of it. A hand-written
    // expectation here is a catalogue of its own, and it drifted the moment
    // P2 added `create_record`: componentSpecs.test.js was updated, this was
    // not, and the route test then failed for a change that was correct.
    // "Serves the catalogue verbatim" is exactly this assertion — the same
    // lockstep rule the spec side already follows.
    assert.deepStrictEqual(res.body.actions.kinds, ACTION_KINDS);
    assert.ok(res.body.limits.MAX_SCREENS > 0);
});

test('GET /templates lists meta only; detail returns the full template; unknown → 404', async () => {
    const list = await api('GET', '/templates', { user: 'owner' });
    assert.strictEqual(list.status, 200);
    assert.ok(Array.isArray(list.body.templates) && list.body.templates.length > 0);
    assert.ok(list.body.templates.every(t => t.definition === undefined), 'gallery rows carry no definition');

    const first = list.body.templates[0];
    const detail = await api('GET', `/templates/${first.id}`, { user: 'owner' });
    assert.strictEqual(detail.status, 200);
    assert.strictEqual(detail.body.template.id, first.id);
    assert.ok(detail.body.template.definition, 'detail includes the definition');

    const missing = await api('GET', '/templates/not-a-template', { user: 'owner' });
    assert.strictEqual(missing.status, 404);
});

test('DELETE /templates/:id — creator only, and never for a built-in', async () => {
    capturedState.rows = {
        utpl_mine: { id: 'utpl_mine', title: 'Mine', createdBy: 'owner', organizationId: 'orgA' },
        utpl_theirs: { id: 'utpl_theirs', title: 'Theirs', createdBy: 'someone-else', organizationId: 'orgA' },
    };
    capturedState.deleted = [];

    // A built-in template is code. 404 is the honest answer — a 403 would
    // imply it might work with more rights.
    const builtIn = await api('DELETE', '/templates/app-request-form', { user: 'owner' });
    assert.strictEqual(builtIn.status, 404);

    const gone = await api('DELETE', '/templates/utpl_nope', { user: 'owner' });
    assert.strictEqual(gone.status, 404);

    const theirs = await api('DELETE', '/templates/utpl_theirs', { user: 'owner' });
    assert.strictEqual(theirs.status, 403, 'a colleague\'s template is not yours to remove');

    const mine = await api('DELETE', '/templates/utpl_mine', { user: 'owner' });
    assert.strictEqual(mine.status, 200);
    assert.deepStrictEqual(capturedState.deleted, ['utpl_mine']);
    capturedState.rows = {};
});

test('POST / creates a blank app with a valid definition and the owner org', async () => {
    const app = await createApp('owner', { name: 'My blank app' });
    assert.strictEqual(app.name, 'My blank app');
    assert.strictEqual(app.userId, 'owner');
    assert.strictEqual(app.organizationId, 'orgA');
    assert.strictEqual(app.definitionVersion, 1);
    assert.strictEqual(app.isPublished, false);
    const check = validateAppDefinition(app.definition);
    assert.strictEqual(check.ok, true, JSON.stringify(check.errors));
    assert.strictEqual(app.definition.meta.name, 'My blank app');
});

test('POST / from a template deep-clones + canonicalizes; unknown templateId → 404', async () => {
    const missing = await api('POST', '/', { user: 'owner', body: { templateId: 'nope' } });
    assert.strictEqual(missing.status, 404);

    const res = await api('POST', '/', { user: 'owner', body: { templateId: 'app-request-form', name: 'Renamed intake' } });
    assert.strictEqual(res.status, 200);
    const app = res.body.app;
    assert.strictEqual(app.name, 'Renamed intake');
    assert.strictEqual(app.definition.meta.name, 'Renamed intake');
    const check = validateAppDefinition(app.definition);
    assert.strictEqual(check.ok, true, JSON.stringify(check.errors));
    // The stored copy must not alias the template constant.
    const { getTemplate } = require('../appStudio/templates');
    assert.notStrictEqual(app.definition, getTemplate('app-request-form').definition);
});

test('POST / with a data-backed templateId installs the data side (model + seed + datasets)', async () => {
    installState.calls.length = 0;
    installState.throwErr = null;
    installState.result = { ok: true, dataModelVersion: 3 };

    const res = await api('POST', '/', { user: 'owner', body: { templateId: 'app-crm-pipeline' } });
    assert.strictEqual(res.status, 200);
    const app = res.body.app;

    // installTemplate fired once, for THIS app + owner, with the full template
    // (its data side loaded via getTemplate — so dataModel/seed travel through).
    assert.strictEqual(installState.calls.length, 1);
    const call = installState.calls[0];
    assert.strictEqual(call.appId, app.id);
    assert.strictEqual(call.ownerId, 'owner');
    assert.ok(call.template && call.template.dataModel && call.template.seed, 'template data side is passed through');
    assert.strictEqual(call.template.id, 'app-crm-pipeline');
});

test('POST / from a template WITHOUT a data side does not call installTemplate', async () => {
    installState.calls.length = 0;
    // app-request-form is definition-only (no dataModel/seed/datasets).
    const res = await api('POST', '/', { user: 'owner', body: { templateId: 'app-request-form' } });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(installState.calls.length, 0, 'no data-side install for a definition-only template');
});

test('POST / survives a template data-install failure — the app still exists', async () => {
    // A clean { ok:false } from installTemplate must NOT 500 the create.
    installState.calls.length = 0;
    installState.throwErr = null;
    installState.result = { ok: false, error: 'data model failed validation' };
    const res = await api('POST', '/', { user: 'owner', body: { templateId: 'app-ticket-tracker', name: 'Survives fail' } });
    assert.strictEqual(res.status, 200, 'create succeeds despite the failed install');
    assert.strictEqual(res.body.app.name, 'Survives fail');
    assert.strictEqual(installState.calls.length, 1);

    // Even a THROWN install error is swallowed — the app is still returned.
    installState.calls.length = 0;
    installState.throwErr = new Error('db exploded');
    const res2 = await api('POST', '/', { user: 'owner', body: { templateId: 'app-ticket-tracker' } });
    assert.strictEqual(res2.status, 200, 'create succeeds despite a thrown install');
    assert.ok(res2.body.app.id);
    installState.throwErr = null;
});

test('POST / REPORTS a failed data install instead of swallowing it', async () => {
    // Swallowed, this produced an app with every screen, no tables and no
    // connectors — which reads as a template that forgot them. The only trace
    // was a console.warn on the server. The caller now learns what happened
    // (and the app is still created, which is why this is not a 500).
    installState.calls.length = 0;
    installState.throwErr = null;
    installState.result = { ok: false, error: 'data model failed validation' };
    const failed = await api('POST', '/', { user: 'owner', body: { templateId: 'app-ticket-tracker' } });
    assert.strictEqual(failed.status, 200);
    assert.deepStrictEqual(failed.body.dataInstall, { ok: false, error: 'data model failed validation' });

    installState.throwErr = new Error('db exploded');
    const threw = await api('POST', '/', { user: 'owner', body: { templateId: 'app-ticket-tracker' } });
    assert.strictEqual(threw.body.dataInstall.ok, false);
    assert.match(threw.body.dataInstall.error, /db exploded/);
    installState.throwErr = null;

    // The happy path reports success, and a definition-only template says
    // nothing at all — there was no data side to install.
    installState.result = { ok: true, dataModelVersion: 3 };
    const good = await api('POST', '/', { user: 'owner', body: { templateId: 'app-ticket-tracker' } });
    assert.deepStrictEqual(good.body.dataInstall, { ok: true, dataModelVersion: 3 });

    const noData = await api('POST', '/', { user: 'owner', body: { templateId: 'app-request-form' } });
    assert.strictEqual(noData.body.dataInstall, undefined);
});

test('GET / respects visibility; GET /mine is owner-scoped', async () => {
    const app = await createApp('owner', { name: 'Visibility probe' });

    const mine = await api('GET', '/mine', { user: 'owner' });
    assert.ok(mine.body.apps.some(a => a.id === app.id));
    assert.ok(mine.body.apps.every(a => a.definition === undefined), 'meta-only rows');

    const orgmateList = await api('GET', '/', { user: 'orgmate' });
    assert.ok(!orgmateList.body.apps.some(a => a.id === app.id), 'unpublished app hidden from org mates');

    await api('PATCH', `/${app.id}/publish`, { user: 'owner', body: { isPublished: true, sharedGroups: [] } });
    const afterPublish = await api('GET', '/', { user: 'orgmate' });
    assert.ok(afterPublish.body.apps.some(a => a.id === app.id), 'org-published app visible to org mates');

    const outsiderList = await api('GET', '/', { user: 'outsider' });
    assert.ok(!outsiderList.body.apps.some(a => a.id === app.id), 'other-org user never sees it');
});

// ── Storage usage (GET /mine pill + GET /usage org-admin view) ──────

test('GET /mine carries a compact per-app storage usage field (dbBytes + dbRatio)', async () => {
    const app = await createApp('owner', { name: 'Sized app' });
    // ~90% of the DB cap → the client should render the amber pill.
    quotaState.dbSizes[app.id] = Math.round(0.9 * DATA_LIMITS.MAX_DB_BYTES);

    const mine = await api('GET', '/mine', { user: 'owner' });
    assert.strictEqual(mine.status, 200);
    const row = mine.body.apps.find(a => a.id === app.id);
    assert.ok(row, 'the owned app is listed');
    assert.strictEqual(row.usage.dbBytes, quotaState.dbSizes[app.id]);
    assert.ok(Math.abs(row.usage.dbRatio - 0.9) < 1e-6, `dbRatio ~0.9 (got ${row.usage.dbRatio})`);

    // An app with no recorded size reports a zero-usage (no pill) shape.
    const empty = await createApp('owner', { name: 'Empty app' });
    const mine2 = await api('GET', '/mine', { user: 'owner' });
    const emptyRow = mine2.body.apps.find(a => a.id === empty.id);
    assert.deepStrictEqual(emptyRow.usage, { dbBytes: 0, dbRatio: 0 });

    delete quotaState.dbSizes[app.id];
});

test('GET /usage returns org totals + per-app breakdown + limits for an org admin', async () => {
    quotaState.orgTotals.orgA = { dbBytes: 4096, attachmentBytes: 1024, totalBytes: 5120 };
    quotaState.breakdown.orgA = [
        { id: 'app-big', name: 'Big', ownerUserId: 'owner', isPublished: true, dbBytes: 4096, rowTotal: 42, updatedAt: '2026-07-01T00:00:00.000Z' },
    ];

    const res = await api('GET', '/usage', { user: 'orgadmin' });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.totals, { dbBytes: 4096, attachmentBytes: 1024, totalBytes: 5120 });
    assert.strictEqual(res.body.apps.length, 1);
    assert.deepStrictEqual(res.body.apps[0], quotaState.breakdown.orgA[0]);
    assert.deepStrictEqual(res.body.limits, {
        maxDbBytes: DATA_LIMITS.MAX_DB_BYTES,
        maxRowsPerApp: DATA_LIMITS.MAX_ROWS_PER_APP,
        maxRowsPerTable: DATA_LIMITS.MAX_ROWS_PER_TABLE,
        maxAttachmentsPerApp: DATA_LIMITS.MAX_ATTACHMENTS_PER_APP,
        maxAttachmentBytes: DATA_LIMITS.MAX_ATTACHMENT_BYTES,
    });

    delete quotaState.orgTotals.orgA;
    delete quotaState.breakdown.orgA;
});

test('GET /usage is org-admin only — a non-admin org member gets 403', async () => {
    const res = await api('GET', '/usage', { user: 'orgmate' });
    assert.strictEqual(res.status, 403);
});

test('GET /usage requires a session (401)', async () => {
    const res = await api('GET', '/usage', {});
    assert.strictEqual(res.status, 401);
});

test('GET /:id — owner gets the full row; non-owner gets published-only; no draft/builder_session ever leaks', async () => {
    const app = await createApp('owner', { name: 'Detail probe' });

    const ownerGet = await api('GET', `/${app.id}`, { user: 'owner' });
    assert.strictEqual(ownerGet.status, 200);
    assert.strictEqual(ownerGet.body.readOnly, false);
    assert.ok(ownerGet.body.app.definition, 'owner sees the working draft');
    assert.ok(!('builderSession' in ownerGet.body.app), 'builderSession never rides along');
    assert.ok(!('builder_session' in ownerGet.body.app));

    // Unpublished → invisible to everyone else (404, not 403 — no existence leak).
    assert.strictEqual((await api('GET', `/${app.id}`, { user: 'orgmate' })).status, 404);

    await api('PATCH', `/${app.id}/publish`, { user: 'owner', body: { isPublished: true, sharedGroups: [] } });
    // Owner keeps editing after publish — the draft must diverge from published.
    const draft2 = emptyDefinition('Detail probe v2');
    await api('PUT', `/${app.id}/definition`, { user: 'owner', body: { definition: draft2, baseVersion: 1 } });

    const reader = await api('GET', `/${app.id}`, { user: 'orgmate' });
    assert.strictEqual(reader.status, 200);
    assert.strictEqual(reader.body.readOnly, true);
    assert.strictEqual(reader.body.app.definition, undefined, 'non-owner never sees the draft');
    assert.ok(reader.body.app.publishedDefinition, 'non-owner sees the frozen published copy');
    assert.strictEqual(reader.body.app.publishedDefinition.meta.name, 'Detail probe', 'published copy is the freeze-time draft');
    assert.ok(!('builderSession' in reader.body.app));
    assert.ok(!JSON.stringify(reader.body).includes('SECRET-BUILDER-CHAT'), 'builder chat never serialized');

    assert.strictEqual((await api('GET', `/${app.id}`, { user: 'outsider' })).status, 404, 'other org → 404');
});

test('PUT /:id metadata is owner-only and validated', async () => {
    const app = await createApp('owner', { name: 'Rename me' });

    const renamed = await api('PUT', `/${app.id}`, { user: 'owner', body: { name: 'Renamed', description: 'now with text', icon: 'Sparkles' } });
    assert.strictEqual(renamed.status, 200);
    assert.strictEqual(renamed.body.app.name, 'Renamed');
    assert.strictEqual(renamed.body.app.description, 'now with text');

    assert.strictEqual((await api('PUT', `/${app.id}`, { user: 'orgmate', body: { name: 'Hijacked' } })).status, 404, 'non-owner update → 404');
    assert.strictEqual((await api('PUT', `/${app.id}`, { user: 'owner', body: { name: '   ' } })).status, 400, 'blank name → 400');
    assert.strictEqual((await api('PUT', `/${app.id}`, { user: 'owner', body: {} })).status, 400, 'no fields → 400');
    assert.strictEqual(state.apps.get(app.id).name, 'Renamed', 'rejected writes changed nothing');
});

test('PUT /:id category — trimmed, capped, and clearable (APPS-04)', async () => {
    // The org's closed list of categories does not live in this route, so what
    // it owes the directory is only this: a value that is safe to render as a
    // filter pill, and a way back out of one.
    const app = await createApp('owner', { name: 'Categorised' });

    const set = await api('PUT', `/${app.id}`, { user: 'owner', body: { category: '  sales  ' } });
    assert.strictEqual(set.status, 200);
    assert.strictEqual(set.body.app.category, 'sales', 'stored trimmed');

    const long = await api('PUT', `/${app.id}`, { user: 'owner', body: { category: 'x'.repeat(500) } });
    assert.strictEqual(long.status, 200);
    assert.strictEqual(long.body.app.category.length, 64, 'a pasted paragraph never becomes a pill');

    const cleared = await api('PUT', `/${app.id}`, { user: 'owner', body: { category: '' } });
    assert.strictEqual(cleared.body.app.category, null, 'uncategorised stays reachable, and is null not ""');
    assert.strictEqual(
        (await api('PUT', `/${app.id}`, { user: 'owner', body: { category: null } })).body.app.category, null);

    assert.strictEqual((await api('PUT', `/${app.id}`, { user: 'owner', body: { category: 7 } })).status, 400,
        'a non-string category is a 400, not a silently stringified pill');
    assert.strictEqual((await api('PUT', `/${app.id}`, { user: 'orgmate', body: { category: 'hr' } })).status, 404,
        'categorising someone else\'s app is not a thing');
});

test('PUT /:id/definition — happy path returns version/warnings/repairs', async () => {
    const app = await createApp('owner', { name: 'Def saves' });
    const def = draftWithAutomation('auto-1');

    const res = await api('PUT', `/${app.id}/definition`, { user: 'owner', body: { definition: def, baseVersion: 1 } });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.version, 2);
    assert.ok(Array.isArray(res.body.warnings));
    assert.ok(Array.isArray(res.body.repairs));
    assert.strictEqual(state.apps.get(app.id).definition.actions.act_run001.kind, 'run_automation');
});

test('PUT /:id/definition — 400 / 404 / 409 / 413 / 422 error paths', async () => {
    const app = await createApp('owner', { name: 'Def errors' });

    // 400 — malformed body
    assert.strictEqual((await api('PUT', `/${app.id}/definition`, { user: 'owner', body: { baseVersion: 1 } })).status, 400);
    assert.strictEqual((await api('PUT', `/${app.id}/definition`, { user: 'owner', body: { definition: emptyDefinition('x') } })).status, 400, 'missing baseVersion → 400');

    // 422 — validation errors (with structured records)
    const invalid = await api('PUT', `/${app.id}/definition`, { user: 'owner', body: { definition: brokenDraft(), baseVersion: 1 } });
    assert.strictEqual(invalid.status, 422);
    assert.ok(invalid.body.errors.some(e => e.code === 'action.navigate_unresolved'), JSON.stringify(invalid.body.errors));
    assert.strictEqual(state.apps.get(app.id).definitionVersion, 1, 'invalid save persisted nothing');

    // 409 — stale baseVersion hands back the server copy
    const ok = await api('PUT', `/${app.id}/definition`, { user: 'owner', body: { definition: emptyDefinition('v2'), baseVersion: 1 } });
    assert.strictEqual(ok.status, 200);
    const stale = await api('PUT', `/${app.id}/definition`, { user: 'owner', body: { definition: emptyDefinition('v3'), baseVersion: 1 } });
    assert.strictEqual(stale.status, 409);
    assert.strictEqual(stale.body.conflict, true);
    assert.strictEqual(stale.body.currentVersion, 2);
    assert.strictEqual(stale.body.definition.meta.name, 'v2', 'conflict response carries the server copy');

    // 404 — non-owner (store CAS is owner-scoped)
    assert.strictEqual((await api('PUT', `/${app.id}/definition`, { user: 'orgmate', body: { definition: emptyDefinition('x'), baseVersion: 2 } })).status, 404);

    // 413 — store byte-ceiling throw maps to 413
    state.forceTooLarge = true;
    try {
        const big = await api('PUT', `/${app.id}/definition`, { user: 'owner', body: { definition: emptyDefinition('x'), baseVersion: 2 } });
        assert.strictEqual(big.status, 413);
    } finally {
        state.forceTooLarge = false;
    }
});

test('PATCH /:id/publish — refuses validation errors and dangling/foreign/inactive automations', async () => {
    const app = await createApp('owner', { name: 'Publish gate' });

    // Draft referencing an automation the owner does NOT have. Draft-save allows it
    // (no ownedAutomations opts at save time) — publish must block it.
    const save = await api('PUT', `/${app.id}/definition`, { user: 'owner', body: { definition: draftWithAutomation('auto-nope'), baseVersion: 1 } });
    assert.strictEqual(save.status, 200, 'draft save tolerates unresolved automation ids');
    const dangling = await api('PATCH', `/${app.id}/publish`, { user: 'owner', body: { isPublished: true } });
    assert.strictEqual(dangling.status, 422);
    assert.ok(dangling.body.errors.some(e => e.code === 'action.automation_missing'), JSON.stringify(dangling.body.errors));
    assert.strictEqual(state.apps.get(app.id).isPublished, false, 'refused publish flipped nothing');

    // Inactive automation blocks too.
    await api('PUT', `/${app.id}/definition`, { user: 'owner', body: { definition: draftWithAutomation('auto-off'), baseVersion: 2 } });
    const inactive = await api('PATCH', `/${app.id}/publish`, { user: 'owner', body: { isPublished: true } });
    assert.strictEqual(inactive.status, 422);
    assert.ok(inactive.body.errors.some(e => e.code === 'action.automation_inactive'));

    // Structurally broken CURRENT draft (injected directly — simulates drift).
    state.apps.get(app.id).definition = brokenDraft();
    const broken = await api('PATCH', `/${app.id}/publish`, { user: 'owner', body: { isPublished: true } });
    assert.strictEqual(broken.status, 422);
    assert.ok(broken.body.errors.some(e => e.code === 'action.navigate_unresolved'));

    // Healthy draft with an owned active automation publishes.
    state.apps.get(app.id).definition = draftWithAutomation('auto-1');
    const good = await api('PATCH', `/${app.id}/publish`, { user: 'owner', body: { isPublished: true, sharedGroups: [] } });
    assert.strictEqual(good.status, 200, JSON.stringify(good.body));
    assert.strictEqual(good.body.isPublished, true);
    assert.strictEqual(state.apps.get(app.id).isPublished, true);
    assert.ok(state.apps.get(app.id).publishedDefinition, 'publish froze the draft');
});

test('PATCH /:id/publish — owner-only (403 for readers, 404 for strangers), group scoping validated', async () => {
    const app = await createApp('owner', { name: 'Publish ACL' });

    // Cross-org groups are rejected against the app org.
    const wrongOrg = await api('PATCH', `/${app.id}/publish`, { user: 'owner', body: { isPublished: true, sharedGroups: ['grp-b1'] } });
    assert.strictEqual(wrongOrg.status, 400);

    // Group-scoped publish.
    const scoped = await api('PATCH', `/${app.id}/publish`, { user: 'owner', body: { isPublished: true, sharedGroups: ['grp-a1'] } });
    assert.strictEqual(scoped.status, 200);
    assert.deepStrictEqual(scoped.body.sharedGroups, ['grp-a1']);

    // Reader (orgmate in grp-a1) can see it but cannot publish → 403.
    const readerAttempt = await api('PATCH', `/${app.id}/publish`, { user: 'orgmate', body: { isPublished: false } });
    assert.strictEqual(readerAttempt.status, 403);
    // Same-org wrong-group user cannot even see it → 404.
    const wrongGroupAttempt = await api('PATCH', `/${app.id}/publish`, { user: 'wronggroup', body: { isPublished: false } });
    assert.strictEqual(wrongGroupAttempt.status, 404);
    // Other-org user → 404.
    const outsiderAttempt = await api('PATCH', `/${app.id}/publish`, { user: 'outsider', body: { isPublished: false } });
    assert.strictEqual(outsiderAttempt.status, 404);
    assert.strictEqual(state.apps.get(app.id).isPublished, true, 'non-owners flipped nothing');
});

test('PATCH /:id/nextcloud-menu — publish-gated, owner-only, pushes to the connector and reports its verdict', async () => {
    const app = await createApp('owner', { name: 'NC menu app' });
    ncMenuSyncCalls.length = 0;

    // Enabling before publish is refused with an actionable code — and the
    // connector is not bothered about a toggle that did not happen.
    const early = await api('PATCH', `/${app.id}/nextcloud-menu`, { user: 'owner', body: { enabled: true } });
    assert.strictEqual(early.status, 409);
    assert.strictEqual(early.body.code, 'not_published');
    assert.strictEqual(ncMenuSyncCalls.length, 0);

    await api('PATCH', `/${app.id}/publish`, { user: 'owner', body: { isPublished: true, sharedGroups: [] } });
    ncMenuSyncCalls.length = 0; // (the publish of a not-yet-flagged app pushes nothing — asserted below)
    const on = await api('PATCH', `/${app.id}/nextcloud-menu`, { user: 'owner', body: { enabled: true } });
    assert.strictEqual(on.status, 200, JSON.stringify(on.body));
    assert.strictEqual(on.body.nextcloudMenu, true);
    // The toggle WAITED for the org's connector and relays what it said, so the
    // dialog can say "reload Nextcloud to see it" only when that is true.
    assert.deepStrictEqual(ncMenuSyncCalls, [{ orgId: 'orgA', reason: 'nextcloud_menu', appId: app.id, awaited: true }]);
    assert.strictEqual(on.body.ncConnected, true);
    assert.strictEqual(on.body.ncSync, 'synced');
    assert.strictEqual(state.apps.get(app.id).nextcloudMenu, true);

    // A connector that is down is an outcome, not a failure of the toggle.
    mockNextcloudMenuSync.outcome = 'unreachable';
    const down = await api('PATCH', `/${app.id}/nextcloud-menu`, { user: 'owner', body: { enabled: true } });
    assert.strictEqual(down.status, 200);
    assert.deepStrictEqual({ ncConnected: down.body.ncConnected, ncSync: down.body.ncSync }, { ncConnected: true, ncSync: 'unreachable' });
    // No paired Nextcloud at all → ncConnected false (the old always-false hint
    // read a camelCase column the org row never had; this is the real probe).
    mockNextcloudMenuSync.outcome = 'not_connected';
    const none = await api('PATCH', `/${app.id}/nextcloud-menu`, { user: 'owner', body: { enabled: true } });
    assert.strictEqual(none.body.ncConnected, false);
    mockNextcloudMenuSync.outcome = 'synced';
    // The flag rides on app meta reads so the editor can hydrate the modal.
    const read = await api('GET', `/${app.id}`, { user: 'owner' });
    assert.strictEqual(read.body.app.nextcloudMenu, true);

    // Owner-only: readers 403, strangers 404, and nothing flips.
    const reader = await api('PATCH', `/${app.id}/nextcloud-menu`, { user: 'orgmate', body: { enabled: false } });
    assert.strictEqual(reader.status, 403);
    const outsider = await api('PATCH', `/${app.id}/nextcloud-menu`, { user: 'outsider', body: { enabled: false } });
    assert.strictEqual(outsider.status, 404);
    assert.strictEqual(state.apps.get(app.id).nextcloudMenu, true, 'non-owners flipped nothing');

    // Disabling is always allowed (also for an unpublished app).
    const off = await api('PATCH', `/${app.id}/nextcloud-menu`, { user: 'owner', body: { enabled: false } });
    assert.strictEqual(off.status, 200);
    assert.strictEqual(off.body.nextcloudMenu, false);
});

test('publish, rename, and delete of a menu-flagged app tell the connector; unflagged apps never do', async () => {
    const app = await createApp('owner', { name: 'Menu-flagged app', icon: 'Sparkles' });
    await api('PATCH', `/${app.id}/publish`, { user: 'owner', body: { isPublished: true, sharedGroups: [] } });
    await api('PATCH', `/${app.id}/nextcloud-menu`, { user: 'owner', body: { enabled: true } });
    ncMenuSyncCalls.length = 0;

    // Unpublish removes the icon (the connector lists published apps only) …
    await api('PATCH', `/${app.id}/publish`, { user: 'owner', body: { isPublished: false } });
    // … and re-publish brings it back. Neither waits on the connector.
    await api('PATCH', `/${app.id}/publish`, { user: 'owner', body: { isPublished: true, sharedGroups: ['grp-a1'] } });
    assert.deepStrictEqual(ncMenuSyncCalls, [
        { orgId: 'orgA', reason: 'unpublish', appId: app.id, awaited: false },
        { orgId: 'orgA', reason: 'publish', appId: app.id, awaited: false },
    ]);

    // The menu shows name + icon: those changes sync; a description does not.
    ncMenuSyncCalls.length = 0;
    await api('PUT', `/${app.id}`, { user: 'owner', body: { description: 'only the blurb' } });
    assert.strictEqual(ncMenuSyncCalls.length, 0, 'a description edit is invisible in the menu');
    await api('PUT', `/${app.id}`, { user: 'owner', body: { name: 'Menu-flagged app v2' } });
    await api('PUT', `/${app.id}`, { user: 'owner', body: { icon: 'Contact' } });
    assert.deepStrictEqual(ncMenuSyncCalls.map(c => c.reason), ['update', 'update']);

    // Delete takes the icon with it.
    ncMenuSyncCalls.length = 0;
    assert.strictEqual((await api('DELETE', `/${app.id}`, { user: 'owner' })).status, 200);
    assert.deepStrictEqual(ncMenuSyncCalls, [{ orgId: 'orgA', reason: 'delete', appId: app.id, awaited: false }]);

    // An app that was never put in the menu never generates a push.
    const plain = await createApp('owner', { name: 'Plain app' });
    ncMenuSyncCalls.length = 0;
    await api('PATCH', `/${plain.id}/publish`, { user: 'owner', body: { isPublished: true, sharedGroups: [] } });
    await api('PUT', `/${plain.id}`, { user: 'owner', body: { name: 'Plain app v2' } });
    await api('PATCH', `/${plain.id}/publish`, { user: 'owner', body: { isPublished: false } });
    await api('DELETE', `/${plain.id}`, { user: 'owner' });
    assert.strictEqual(ncMenuSyncCalls.length, 0);
});

test('an org member outside the audience gets a 403 that says so; strangers and unpublished apps stay 404', async () => {
    const app = await createApp('owner', { name: 'Group-only app' });

    // Unpublished: nobody but the owner learns it exists — same-org included.
    assert.strictEqual((await api('GET', `/${app.id}`, { user: 'wronggroup' })).status, 404);
    assert.strictEqual((await api('GET', `/${app.id}/runtime`, { user: 'wronggroup' })).status, 404);

    await api('PATCH', `/${app.id}/publish`, { user: 'owner', body: { isPublished: true, sharedGroups: ['grp-a1'] } });

    // `wronggroup` is in orgA but only in grp-a2. They reached the app by its
    // id (from the org's Nextcloud menu, say) — telling them "not found" would
    // be false and give them nothing to act on.
    for (const path of [`/${app.id}`, `/${app.id}/runtime`]) {
        const res = await api('GET', path, { user: 'wronggroup' });
        assert.strictEqual(res.status, 403, `${path} → 403 for an in-org non-member`);
        assert.strictEqual(res.body.code, 'not_in_audience');
        assert.ok(!('name' in res.body) && !('app' in res.body) && !('definition' in res.body),
            'the refusal carries no app name, owner or definition');
        assert.ok(!JSON.stringify(res.body).includes('Group-only app'));
    }

    // Another organisation still gets the uniform 404 — existence is not confirmed.
    assert.strictEqual((await api('GET', `/${app.id}`, { user: 'outsider' })).status, 404);
    assert.strictEqual((await api('GET', `/${app.id}/runtime`, { user: 'outsider' })).status, 404);

    // Widening to the whole org turns the 403 into a read.
    await api('PATCH', `/${app.id}/publish`, { user: 'owner', body: { isPublished: true, sharedGroups: [] } });
    assert.strictEqual((await api('GET', `/${app.id}/runtime`, { user: 'wronggroup' })).status, 200);
});

test('PATCH /:id/publish — reports publishedVersion, and app reads expose the gap with the draft', async () => {
    const app = await createApp('owner', { name: 'Drift probe' });
    assert.strictEqual(app.publishedVersion, null, 'never published → null, not 0');

    // Edit once (v1 → v2), then publish that draft.
    await api('PUT', `/${app.id}/definition`, { user: 'owner', body: { definition: emptyDefinition('Drift probe v2'), baseVersion: 1 } });
    const published = await api('PATCH', `/${app.id}/publish`, { user: 'owner', body: { isPublished: true, sharedGroups: [] } });
    assert.strictEqual(published.status, 200, JSON.stringify(published.body));
    assert.strictEqual(published.body.publishedVersion, 2);
    // Nothing that already existed on the response changed shape.
    assert.strictEqual(published.body.success, true);
    assert.strictEqual(published.body.isPublished, true);
    assert.deepStrictEqual(published.body.sharedGroups, []);

    // Two more autosaves — the live copy is still version 2.
    await api('PUT', `/${app.id}/definition`, { user: 'owner', body: { definition: emptyDefinition('v3'), baseVersion: 2 } });
    await api('PUT', `/${app.id}/definition`, { user: 'owner', body: { definition: emptyDefinition('v4'), baseVersion: 3 } });

    const detail = await api('GET', `/${app.id}`, { user: 'owner' });
    assert.strictEqual(detail.body.app.publishedVersion, 2);
    assert.strictEqual(detail.body.app.definitionVersion, 4, 'the gap is visible without a second call');

    const mine = await api('GET', '/mine', { user: 'owner' });
    const row = mine.body.apps.find(a => a.id === app.id);
    assert.strictEqual(row.publishedVersion, 2, 'list rows carry it too');
    assert.strictEqual(row.definitionVersion, 4);

    // Unpublishing does not pretend the frozen copy moved.
    const unpublished = await api('PATCH', `/${app.id}/publish`, { user: 'owner', body: { isPublished: false } });
    assert.strictEqual(unpublished.status, 200);
    assert.strictEqual(unpublished.body.publishedVersion, 2);
});

test('GET /:id/ref — names the button for its owner, ids only for anyone else', async () => {
    const app = await createApp('owner', { name: 'Expenses' });
    const def = draftWithAutomation('auto-1');
    await api('PUT', `/${app.id}/definition`, { user: 'owner', body: { definition: def, baseVersion: 1 } });
    const screenId = def.screens[0].id;
    const q = `screenId=${screenId}&nodeId=cmp_btn001`;

    // The owner is told everything, and told the link will open.
    const mine = await api('GET', `/${app.id}/ref?${q}`, { user: 'owner' });
    assert.strictEqual(mine.status, 200);
    assert.strictEqual(mine.body.status, 'ok');
    assert.strictEqual(mine.body.appName, 'Expenses');
    assert.strictEqual(mine.body.screenName, 'Home');
    assert.strictEqual(mine.body.nodeLabel, 'Go');
    assert.strictEqual(mine.body.canOpen, true);

    // Publishing to the whole org changes nothing: the breadcrumb links into
    // App Studio's EDITOR, which is owner-only, so a reader gets ids and no
    // link rather than a name and a link that would land on a refusal.
    await api('PATCH', `/${app.id}/publish`, { user: 'owner', body: { isPublished: true, sharedGroups: [] } });
    const theirs = await api('GET', `/${app.id}/ref?${q}`, { user: 'orgmate' });
    assert.strictEqual(theirs.status, 200, 'a refusal is an ANSWER this screen renders, not an error');
    assert.strictEqual(theirs.body.status, 'restricted');
    assert.strictEqual(theirs.body.appName, null);
    assert.strictEqual(theirs.body.screenName, null);
    assert.strictEqual(theirs.body.canOpen, false);
    assert.strictEqual(theirs.body.appId, app.id, 'the ids still come back — they are all that is left to say');

    // A non-owner cannot tell a deleted screen from an intact one.
    const theirsGone = await api('GET', `/${app.id}/ref?screenId=scr_gone01&nodeId=cmp_btn001`, { user: 'orgmate' });
    assert.strictEqual(theirsGone.body.status, 'restricted');
});

test('GET /:id/ref — a pointer that leads nowhere says so, and never 404s', async () => {
    const app = await createApp('owner', { name: 'Expenses' });
    const def = draftWithAutomation('auto-1');
    await api('PUT', `/${app.id}/definition`, { user: 'owner', body: { definition: def, baseVersion: 1 } });
    const screenId = def.screens[0].id;

    // A deleted screen / button is NOT "no trigger" — the automation still fires,
    // so the answer has to name which level stopped resolving.
    const noScreen = await api('GET', `/${app.id}/ref?screenId=scr_gone01&nodeId=cmp_btn001`, { user: 'owner' });
    assert.strictEqual(noScreen.status, 200);
    assert.strictEqual(noScreen.body.status, 'screen_missing');
    assert.strictEqual(noScreen.body.appName, 'Expenses');

    const noNode = await api('GET', `/${app.id}/ref?screenId=${screenId}&nodeId=cmp_gone01`, { user: 'owner' });
    assert.strictEqual(noNode.body.status, 'node_missing');
    assert.strictEqual(noNode.body.screenName, 'Home');

    // A deleted APP answers the same way for everyone: the id is a UUID, so
    // "no app has this id" is not a secret worth a 404 the card cannot read.
    const noApp = await api('GET', `/app-gone/ref?screenId=${screenId}&nodeId=cmp_btn001`, { user: 'owner' });
    assert.strictEqual(noApp.status, 200);
    assert.strictEqual(noApp.body.status, 'app_missing');
    assert.strictEqual(noApp.body.canOpen, false);
});

test('GET /:id/runtime — draft vs published matrix', async () => {
    const app = await createApp('owner', { name: 'Runtime app' });

    // Owner + ?draft=1 → the working draft, marked as such.
    const ownerDraft = await api('GET', `/${app.id}/runtime?draft=1`, { user: 'owner' });
    assert.strictEqual(ownerDraft.status, 200);
    assert.strictEqual(ownerDraft.body.draft, true);
    assert.strictEqual(ownerDraft.body.definition.meta.name, 'Runtime app');

    // Unpublished: no published copy to run — owner without draft flag AND
    // non-owners all get 404 (no existence leak).
    assert.strictEqual((await api('GET', `/${app.id}/runtime`, { user: 'owner' })).status, 404);
    assert.strictEqual((await api('GET', `/${app.id}/runtime`, { user: 'orgmate' })).status, 404);
    assert.strictEqual((await api('GET', `/${app.id}/runtime?draft=1`, { user: 'orgmate' })).status, 404, 'draft flag grants nothing to non-owners');

    await api('PATCH', `/${app.id}/publish`, { user: 'owner', body: { isPublished: true, sharedGroups: [] } });
    // Draft keeps evolving after the freeze.
    await api('PUT', `/${app.id}/definition`, { user: 'owner', body: { definition: emptyDefinition('Runtime app EDITED'), baseVersion: 1 } });

    const ownerLive = await api('GET', `/${app.id}/runtime`, { user: 'owner' });
    assert.strictEqual(ownerLive.status, 200);
    assert.strictEqual(ownerLive.body.draft, undefined);
    assert.strictEqual(ownerLive.body.definition.meta.name, 'Runtime app', 'no-draft runtime serves the frozen copy');

    const ownerDraft2 = await api('GET', `/${app.id}/runtime?draft=1`, { user: 'owner' });
    assert.strictEqual(ownerDraft2.body.definition.meta.name, 'Runtime app EDITED', 'draft runtime serves the working draft');

    const mate = await api('GET', `/${app.id}/runtime?draft=1`, { user: 'orgmate' });
    assert.strictEqual(mate.status, 200);
    assert.strictEqual(mate.body.definition.meta.name, 'Runtime app', 'non-owner draft=1 still gets the published copy');
    assert.strictEqual(mate.body.draft, undefined);

    assert.strictEqual((await api('GET', `/${app.id}/runtime`, { user: 'outsider' })).status, 404);

    // Unpublish → readers lose the runtime again.
    await api('PATCH', `/${app.id}/publish`, { user: 'owner', body: { isPublished: false } });
    assert.strictEqual((await api('GET', `/${app.id}/runtime`, { user: 'orgmate' })).status, 404);
});

test('a Solution member reaches an app the org/group audience misses (APPS-15)', async () => {
    // Published to grp-a1 in orgA; `outsider` is in orgB and in no group of it,
    // so nothing but the Solution can carry them.
    const app = await createApp('owner', { name: 'Solution app' });
    await api('PATCH', `/${app.id}/publish`, { user: 'owner', body: { isPublished: true, sharedGroups: ['grp-a1'] } });
    state.apps.get(app.id).projectId = 'p1';

    assert.strictEqual((await api('GET', `/${app.id}`, { user: 'outsider' })).status, 404,
        'filing an app into a project widens it to that project, not to everyone');
    assert.strictEqual((await api('GET', `/${app.id}/runtime`, { user: 'outsider' })).status, 404);

    state.projectRoles['outsider:p1'] = 'viewer';
    try {
        const meta = await api('GET', `/${app.id}`, { user: 'outsider' });
        assert.strictEqual(meta.status, 200);
        assert.strictEqual(meta.body.readOnly, true, 'a member reads, a member does not author');
        assert.strictEqual(meta.body.app.definition, undefined, 'still never the owner\'s working draft');

        const rt = await api('GET', `/${app.id}/runtime`, { user: 'outsider' });
        assert.strictEqual(rt.status, 200, 'and the app they can see is an app they can open');
        assert.strictEqual(rt.body.definition.meta.name, 'Solution app');

        // Unpublish: membership answers WHO, never whether there is anything to
        // serve — the frozen copy is gone, so the member is gone with it.
        await api('PATCH', `/${app.id}/publish`, { user: 'owner', body: { isPublished: false } });
        assert.strictEqual((await api('GET', `/${app.id}/runtime`, { user: 'outsider' })).status, 404);
        assert.strictEqual((await api('GET', `/${app.id}`, { user: 'outsider' })).status, 404);
    } finally {
        delete state.projectRoles['outsider:p1'];
    }
});

test('versions — owner-only history, restore bumps the CAS version', async () => {
    const app = await createApp('owner', { name: 'Versioned' });
    await api('PATCH', `/${app.id}/publish`, { user: 'owner', body: { isPublished: true, sharedGroups: [] } });

    const versions = await api('GET', `/${app.id}/versions`, { user: 'owner' });
    assert.strictEqual(versions.status, 200);
    assert.strictEqual(versions.body.versions.length, 1, 'publish wrote one snapshot');
    assert.strictEqual(versions.body.versions[0].definition, undefined, 'history rows are meta-only');

    assert.strictEqual((await api('GET', `/${app.id}/versions`, { user: 'orgmate' })).status, 404, 'history is owner-only');

    // Diverge, then restore the snapshot.
    await api('PUT', `/${app.id}/definition`, { user: 'owner', body: { definition: emptyDefinition('Diverged'), baseVersion: 1 } });
    const vid = versions.body.versions[0].id;
    const restored = await api('POST', `/${app.id}/versions/${vid}/restore`, { user: 'owner' });
    assert.strictEqual(restored.status, 200);
    assert.strictEqual(restored.body.version, 3, 'restore bumps definition_version (1→2 edit, 2→3 restore)');
    assert.strictEqual(state.apps.get(app.id).definition.meta.name, 'Versioned', 'draft matches the snapshot again');

    assert.strictEqual((await api('POST', `/${app.id}/versions/${vid}/restore`, { user: 'orgmate' })).status, 404, 'restore is owner-only');
    assert.strictEqual((await api('POST', `/${app.id}/versions/ver-nope/restore`, { user: 'owner' })).status, 404, 'unknown snapshot → 404');
});

// ── Wave 2A: data-reference validation (publish blocks, draft save warns) ────

// Draft with a data_grid bound to a records binding on `tableId`.
function draftWithRecordsBinding(tableId) {
    const def = emptyDefinition('Data-bound app');
    def.screens[0].sections[0].children.push({
        id: 'cmp_grid01', type: 'data_grid',
        props: {
            source: { kind: 'records', tableId, filter: [{ field: 'title', op: 'eq', value: { kind: 'formula', expr: 'vars.q' } }] },
            columns: [{ key: 'title', label: 'Title' }],
        },
        style: { span: 12 }, visible: true,
    });
    return def;
}

const TASKS_MODEL = {
    modelVersion: 1,
    tables: [{
        id: 'tbl_task01', key: 'tasks', name: 'Tasks',
        fields: [{ id: 'fld_tt01', key: 'title', type: 'text', required: true, unique: false }],
        access: { default: 'app', roles: {}, rowFilters: {} },
    }],
    roles: [], roleMapping: { default: 'app', byGroup: {} },
};

test('PUT /:id/definition — dangling data references save fine but come back as WARNINGS', async () => {
    const app = await createApp('owner', { name: 'Data warn app' });
    // No data model at all → every table reference is unknown.
    const res = await api('PUT', `/${app.id}/definition`, {
        user: 'owner',
        body: { definition: draftWithRecordsBinding('tbl_ghost'), baseVersion: 1 },
    });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.warnings.some(w => w.code === 'binding.unknown_table'), JSON.stringify(res.body.warnings));
    assert.ok(res.body.warnings.every(w => w.severity === 'warning'));
    assert.strictEqual(state.apps.get(app.id).definitionVersion, 2, 'save persisted despite the dangling reference');

    // Structural errors still 422 on save (unchanged semantics).
    const invalid = await api('PUT', `/${app.id}/definition`, { user: 'owner', body: { definition: brokenDraft(), baseVersion: 2 } });
    assert.strictEqual(invalid.status, 422);
});

test('PATCH /:id/publish — blocked by a dangling tableId / unknown field, passes once the model matches', async () => {
    const app = await createApp('owner', { name: 'Data publish gate' });
    await api('PUT', `/${app.id}/definition`, {
        user: 'owner',
        body: { definition: draftWithRecordsBinding('tbl_ghost'), baseVersion: 1 },
    });

    // No data model → binding.unknown_table blocks publish with a 422.
    const dangling = await api('PATCH', `/${app.id}/publish`, { user: 'owner', body: { isPublished: true } });
    assert.strictEqual(dangling.status, 422);
    assert.ok(dangling.body.errors.some(e => e.code === 'binding.unknown_table'), JSON.stringify(dangling.body.errors));
    assert.strictEqual(state.apps.get(app.id).isPublished, false);

    // Model exists but the binding filters on a field the table lacks.
    dataState.models.set(app.id, TASKS_MODEL);
    const badField = draftWithRecordsBinding('tbl_task01');
    badField.screens[0].sections[0].children[0].props.source.filter = [{ field: 'nope', op: 'eq', value: 1 }];
    await api('PUT', `/${app.id}/definition`, { user: 'owner', body: { definition: badField, baseVersion: 2 } });
    const unknownField = await api('PATCH', `/${app.id}/publish`, { user: 'owner', body: { isPublished: true } });
    assert.strictEqual(unknownField.status, 422);
    assert.ok(unknownField.body.errors.some(e => e.code === 'binding.unknown_field'), JSON.stringify(unknownField.body.errors));

    // Matching model + field (formula-valued filter) → publish freezes the draft.
    await api('PUT', `/${app.id}/definition`, { user: 'owner', body: { definition: draftWithRecordsBinding('tbl_task01'), baseVersion: 3 } });
    const good = await api('PATCH', `/${app.id}/publish`, { user: 'owner', body: { isPublished: true, sharedGroups: [] } });
    assert.strictEqual(good.status, 200, JSON.stringify(good.body));
    assert.strictEqual(state.apps.get(app.id).isPublished, true);
    dataState.models.delete(app.id);
});

test('PATCH /:id/publish — a connector binding must resolve against model.connectors[]', async () => {
    const app = await createApp('owner', { name: 'Connector publish gate' });
    const def = emptyDefinition('Connector app');
    def.screens[0].sections[0].children.push({
        id: 'cmp_grid01', type: 'data_grid',
        props: {
            source: { kind: 'connector', connectorId: 'conn_ghost1', params: { q: { kind: 'formula', expr: 'vars.q' } } },
            columns: [{ key: 'title', label: 'Title' }],
        },
        style: { span: 12 }, visible: true,
    });
    // Model with NO matching connector → binding.unknown_connector blocks publish.
    dataState.models.set(app.id, TASKS_MODEL);
    await api('PUT', `/${app.id}/definition`, { user: 'owner', body: { definition: def, baseVersion: 1 } });
    const dangling = await api('PATCH', `/${app.id}/publish`, { user: 'owner', body: { isPublished: true } });
    assert.strictEqual(dangling.status, 422);
    assert.ok(dangling.body.errors.some(e => e.code === 'binding.unknown_connector'), JSON.stringify(dangling.body.errors));
    assert.strictEqual(state.apps.get(app.id).isPublished, false);

    // Add the connector to the model → publish freezes the draft.
    dataState.models.set(app.id, {
        ...TASKS_MODEL,
        connectors: [{ id: 'conn_ghost1', kind: 'automation', name: 'Sync', automationId: 'auto-1' }],
    });
    const good = await api('PATCH', `/${app.id}/publish`, { user: 'owner', body: { isPublished: true, sharedGroups: [] } });
    assert.strictEqual(good.status, 200, JSON.stringify(good.body));
    assert.strictEqual(state.apps.get(app.id).isPublished, true);
    dataState.models.delete(app.id);
});

test('PATCH /:id/publish — a dataset binding must resolve against the app datasets', async () => {
    const app = await createApp('owner', { name: 'Dataset publish gate' });
    const def = emptyDefinition('Dataset app');
    def.screens[0].sections[0].children.push({
        id: 'cmp_chart1', type: 'chart',
        props: { chartType: 'bar', source: { kind: 'dataset', datasetId: 'ds_ghost' }, series: [{ key: 'v' }] },
        style: { span: 6 }, visible: true,
    });
    dataState.models.set(app.id, TASKS_MODEL);
    await api('PUT', `/${app.id}/definition`, { user: 'owner', body: { definition: def, baseVersion: 1 } });

    const dangling = await api('PATCH', `/${app.id}/publish`, { user: 'owner', body: { isPublished: true } });
    assert.strictEqual(dangling.status, 422);
    assert.ok(dangling.body.errors.some(e => e.code === 'binding.unknown_dataset'), JSON.stringify(dangling.body.errors));

    dataState.datasets.set(app.id, [{ id: 'ds_ghost' }]);
    const good = await api('PATCH', `/${app.id}/publish`, { user: 'owner', body: { isPublished: true, sharedGroups: [] } });
    assert.strictEqual(good.status, 200, JSON.stringify(good.body));
    dataState.models.delete(app.id);
    dataState.datasets.delete(app.id);
});

test('DELETE /:id is owner-scoped', async () => {
    const app = await createApp('owner', { name: 'Delete me' });

    assert.strictEqual((await api('DELETE', `/${app.id}`, { user: 'orgmate' })).status, 404);
    assert.strictEqual((await api('DELETE', `/${app.id}`, { user: 'outsider' })).status, 404);
    assert.ok(state.apps.has(app.id), 'non-owner deletes changed nothing');

    assert.strictEqual((await api('DELETE', `/${app.id}`, { user: 'owner' })).status, 200);
    assert.ok(!state.apps.has(app.id));
    assert.strictEqual((await api('GET', `/${app.id}`, { user: 'owner' })).status, 404);
});

test('GET /:id/runtime — viewer block: own identity + rlsGateway role-resolution chain', async () => {
    const app = await createApp('owner', { name: 'Viewer probe' });

    // Owner draft preview → own identity, owner role.
    const ownerDraft = await api('GET', `/${app.id}/runtime?draft=1`, { user: 'owner' });
    assert.strictEqual(ownerDraft.status, 200);
    assert.deepStrictEqual(ownerDraft.body.viewer, {
        id: 'owner', name: 'Owner One', email: 'owner@example.test', isOwner: true, roleKey: 'owner',
    });

    await api('PATCH', `/${app.id}/publish`, { user: 'owner', body: { isPublished: true, sharedGroups: [] } });

    // No membership, no model mapping → roleKey null (no data access).
    const plain = await api('GET', `/${app.id}/runtime`, { user: 'orgmate' });
    assert.strictEqual(plain.status, 200);
    assert.deepStrictEqual(plain.body.viewer, {
        id: 'orgmate', name: 'Org Mate', email: 'orgmate@example.test', isOwner: false, roleKey: null,
    });

    // 1. explicit studio_app_members row wins.
    dataState.members.set(`${app.id}:orgmate`, 'editor');
    assert.strictEqual((await api('GET', `/${app.id}/runtime`, { user: 'orgmate' })).body.viewer.roleKey, 'editor');
    dataState.members.delete(`${app.id}:orgmate`);

    // 2. roleMapping.byGroup ∩ the viewer's groups.
    dataState.models.set(app.id, { modelVersion: 1, tables: [], roles: [], roleMapping: { default: null, byGroup: { 'grp-a1': 'member' } } });
    assert.strictEqual((await api('GET', `/${app.id}/runtime`, { user: 'orgmate' })).body.viewer.roleKey, 'member');
    // wronggroup (grp-a2) misses the mapping → null default → roleKey null.
    assert.strictEqual((await api('GET', `/${app.id}/runtime`, { user: 'wronggroup' })).body.viewer.roleKey, null);

    // 3. roleMapping.default catches everyone.
    dataState.models.set(app.id, { modelVersion: 1, tables: [], roles: [], roleMapping: { default: 'member', byGroup: {} } });
    assert.strictEqual((await api('GET', `/${app.id}/runtime`, { user: 'wronggroup' })).body.viewer.roleKey, 'member');
    dataState.models.delete(app.id);

    // Owner running the published copy keeps isOwner + owner role.
    const ownerLive = await api('GET', `/${app.id}/runtime`, { user: 'owner' });
    assert.strictEqual(ownerLive.body.viewer.isOwner, true);
    assert.strictEqual(ownerLive.body.viewer.roleKey, 'owner');

    // The viewer block is the CALLER's identity only — never another user's.
    assert.ok(!JSON.stringify(plain.body.viewer).includes('owner@example.test'));
});

// ── POST /:id/check — the pre-flight a person can run ───────────────
//
// appDryRun has existed since Wave 4 and only the AI builder could reach it
// (the app_dry_run tool). A hand-builder had no way to ask "will this work?"
// short of publishing and clicking through the app.

test('POST /:id/check — reports a clean app without changing anything', async () => {
    const app = await createApp('owner', { name: 'Checkable' });
    const before = clone(state.apps.get(app.id));

    const res = await api('POST', `/${app.id}/check`, { user: 'owner', body: {} });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.ok, true);
    assert.deepStrictEqual(res.body.static.errors, []);
    assert.ok(Array.isArray(res.body.bindings));
    assert.ok(Array.isArray(res.body.actions));

    // Read-only: nothing about the stored row moved.
    assert.strictEqual(state.apps.get(app.id).isPublished, before.isPublished);
    assert.strictEqual(state.apps.get(app.id).definitionVersion, before.definitionVersion);
});

test('POST /:id/check — surfaces the same automation problems that block publish', async () => {
    const app = await createApp('owner', { name: 'Check automations' });
    await api('PUT', `/${app.id}/definition`, {
        user: 'owner',
        body: { definition: draftWithAutomation('auto-nope'), baseVersion: 1 },
    });

    // appDryRun's own static pass has no automations list, so without the
    // route's second validate pass this would come back clean — and then the
    // publish would be refused for a reason the check never mentioned.
    const res = await api('POST', `/${app.id}/check`, { user: 'owner', body: {} });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.ok, false);
    assert.ok(
        res.body.static.errors.some(e => e.code === 'action.automation_missing'),
        JSON.stringify(res.body.static.errors),
    );

    // And the publish gate agrees, which is the point.
    const publish = await api('PATCH', `/${app.id}/publish`, { user: 'owner', body: { isPublished: true } });
    assert.strictEqual(publish.status, 422);
});

// An app the AI builder made LINKS a Studio table (app_link_datatable), so
// every binding on it carries a `source`. The check re-validates with the
// automations list; until it also carried the owner's Studio tables, each of those
// bindings came back as `binding.datatable_unverified` — five warnings on a
// freshly built app that the author could not act on, and that the publish
// gate (which has the list) never raised.
test('POST /:id/check — a linked Studio table is checked against the owner\'s tables, not warned about', async () => {
    const app = await createApp('owner', { name: 'Linked app' });
    dataState.models.set(app.id, {
        modelVersion: 1,
        tables: [{
            id: 'tbl_link01', key: 'invoices', name: 'Invoices',
            fields: [{ id: 'fld_ii01', key: 'title', type: 'text', required: false, unique: false }],
            access: { default: 'app', roles: {}, rowFilters: {} },
            source: { kind: 'datatable', datatableId: 'tbl_dt0001', mode: 'read' },
        }],
        roles: [], roleMapping: { default: 'app', byGroup: {} },
    });
    await api('PUT', `/${app.id}/definition`, {
        user: 'owner',
        body: { definition: draftWithRecordsBinding('tbl_link01'), baseVersion: 1 },
    });
    try {
        ownerDatatables = ['tbl_dt0001'];
        const res = await api('POST', `/${app.id}/check`, { user: 'owner', body: {} });
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.ok(
            !res.body.static.warnings.some(w => w.code === 'binding.datatable_unverified'),
            JSON.stringify(res.body.static.warnings),
        );
        assert.ok(!res.body.static.errors.some(e => e.code === 'binding.unknown_datatable'));

        // …and a link to a table the owner does NOT have is the same ERROR the
        // publish gate gives, said here first.
        ownerDatatables = ['tbl_somethingelse'];
        const gone = await api('POST', `/${app.id}/check`, { user: 'owner', body: {} });
        assert.ok(
            gone.body.static.errors.some(e => e.code === 'binding.unknown_datatable'),
            JSON.stringify(gone.body.static.errors),
        );
    } finally {
        ownerDatatables = null;
    }
});

test('POST /:id/check — owner-only: 403 for a reader, 404 for a stranger', async () => {
    const app = await createApp('owner', { name: 'Check ACL' });
    await api('PATCH', `/${app.id}/publish`, { user: 'owner', body: { isPublished: true, sharedGroups: ['grp-a1'] } });

    const reader = await api('POST', `/${app.id}/check`, { user: 'orgmate', body: {} });
    assert.strictEqual(reader.status, 403);

    // Same-org wrong group and other-org alike get the uniform 404 — a check
    // endpoint must not become the one that leaks which apps exist.
    const wrongGroup = await api('POST', `/${app.id}/check`, { user: 'wronggroup', body: {} });
    assert.strictEqual(wrongGroup.status, 404);
    const outsider = await api('POST', `/${app.id}/check`, { user: 'outsider', body: {} });
    assert.strictEqual(outsider.status, 404);

    const missing = await api('POST', '/app-nope/check', { user: 'owner', body: {} });
    assert.strictEqual(missing.status, 404);
});

test('POST /:id/check — reports the canonicalized draft, so it agrees with publish', async () => {
    const app = await createApp('owner', { name: 'Check canon' });
    // Structurally broken draft injected directly (simulates drift), the same
    // fixture the publish gate test uses.
    state.apps.get(app.id).definition = brokenDraft();

    const res = await api('POST', `/${app.id}/check`, { user: 'owner', body: {} });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.ok, false);
    assert.ok(res.body.static.errors.some(e => e.code === 'action.navigate_unresolved'), JSON.stringify(res.body.static.errors));
});

// ── Template upgrade (install stamp + pristine hash + POST /:id/template-upgrade) ──

test('POST / from a template stamps templateId/version/install hash; blank apps carry no stamp', async () => {
    const res = await api('POST', '/', { user: 'owner', body: { templateId: 'app-request-form' } });
    assert.strictEqual(res.status, 200);
    const app = res.body.app;
    assert.strictEqual(app.templateId, 'app-request-form');
    assert.strictEqual(app.templateVersion, 1);
    // The hash covers the definition AS SAVED (post-canonicalize) — recomputing
    // over the stored copy must reproduce it exactly.
    assert.strictEqual(app.templateInstallHash, hashDefinition(app.definition));

    const blank = await createApp('owner', { name: 'No template here' });
    assert.strictEqual(blank.templateId, null);
    assert.strictEqual(blank.templateVersion, null);
    assert.strictEqual(blank.templateInstallHash, null);
});

test('GET /mine — templateUpgrade.available only when the registry is newer AND the app is pristine', async () => {
    const created = await api('POST', '/', { user: 'owner', body: { templateId: 'app-request-form' } });
    const app = created.body.app;

    // (a) Freshly installed at the registry version → nothing to offer.
    let mine = await api('GET', '/mine', { user: 'owner' });
    let row = mine.body.apps.find(a => a.id === app.id);
    assert.deepStrictEqual(row.templateUpgrade, { available: false });

    try {
        // (b) The registry ships v2 → available while the definition is untouched.
        templatesState.versionOverrides['app-request-form'] = 2;
        mine = await api('GET', '/mine', { user: 'owner' });
        row = mine.body.apps.find(a => a.id === app.id);
        assert.deepStrictEqual(row.templateUpgrade, { available: true, fromVersion: 1, toVersion: 2 });

        // (c) A hand edit flips it to unavailable — versions still reported.
        await api('PUT', `/${app.id}/definition`, { user: 'owner', body: { definition: emptyDefinition('Edited by hand'), baseVersion: 1 } });
        mine = await api('GET', '/mine', { user: 'owner' });
        row = mine.body.apps.find(a => a.id === app.id);
        assert.deepStrictEqual(row.templateUpgrade, { available: false, fromVersion: 1, toVersion: 2 });
    } finally {
        delete templatesState.versionOverrides['app-request-form'];
    }
});

test('POST /:id/template-upgrade — happy path: definition replaced, data re-installed missing-only, stamp bumped', async () => {
    installState.calls.length = 0;
    installState.throwErr = null;
    installState.result = { ok: true, dataModelVersion: 2 };
    const created = await api('POST', '/', { user: 'owner', body: { templateId: 'app-crm-pipeline', name: 'Mijn CRM' } });
    assert.strictEqual(created.status, 200);
    const app = created.body.app;
    installState.calls.length = 0; // drop the create-time install call

    try {
        templatesState.versionOverrides['app-crm-pipeline'] = 2;
        const res = await api('POST', `/${app.id}/template-upgrade`, { user: 'owner' });
        assert.strictEqual(res.status, 200, JSON.stringify(res.body));
        assert.strictEqual(res.body.ok, true);
        assert.strictEqual(res.body.fromVersion, 1);
        assert.strictEqual(res.body.toVersion, 2);
        assert.deepStrictEqual(res.body.dataInstall, { ok: true, dataModelVersion: 2 });

        // The data side re-ran in the non-duplicating mode — never a full re-seed.
        assert.strictEqual(installState.calls.length, 1);
        assert.strictEqual(installState.calls[0].appId, app.id);
        assert.strictEqual(installState.calls[0].seedMode, 'missing-tables-only');

        const stored = state.apps.get(app.id);
        // Definition replaced by the registry template's (canonicalized), the
        // app's in-app name carried over exactly like the create-time override.
        assert.strictEqual(stored.definition.meta.name, 'Mijn CRM');
        assert.strictEqual(stored.templateVersion, 2);
        assert.strictEqual(stored.templateInstallHash, hashDefinition(stored.definition), 'stamp hash covers the NEW definition');
        assert.strictEqual(stored.definitionVersion, 2, 'CAS version bumped so open editors conflict, not clobber');

        // Pristine at the new version → the offer disappears from /mine.
        const mine = await api('GET', '/mine', { user: 'owner' });
        const row = mine.body.apps.find(a => a.id === app.id);
        assert.deepStrictEqual(row.templateUpgrade, { available: false });
    } finally {
        delete templatesState.versionOverrides['app-crm-pipeline'];
    }
});

test('POST /:id/template-upgrade — 409 codes: not_from_template / no_newer_version / not_pristine', async () => {
    // Not created from a template at all.
    const blank = await createApp('owner', { name: 'Blank, no stamp' });
    const noTpl = await api('POST', `/${blank.id}/template-upgrade`, { user: 'owner' });
    assert.strictEqual(noTpl.status, 409);
    assert.strictEqual(noTpl.body.code, 'not_from_template');

    // From a template, registry not newer.
    const created = await api('POST', '/', { user: 'owner', body: { templateId: 'app-request-form' } });
    const app = created.body.app;
    const same = await api('POST', `/${app.id}/template-upgrade`, { user: 'owner' });
    assert.strictEqual(same.status, 409);
    assert.strictEqual(same.body.code, 'no_newer_version');

    try {
        // Newer version but hand-edited → not_pristine, and NOTHING moves.
        templatesState.versionOverrides['app-request-form'] = 2;
        await api('PUT', `/${app.id}/definition`, { user: 'owner', body: { definition: emptyDefinition('Edited'), baseVersion: 1 } });
        const before = clone(state.apps.get(app.id));
        const edited = await api('POST', `/${app.id}/template-upgrade`, { user: 'owner' });
        assert.strictEqual(edited.status, 409);
        assert.strictEqual(edited.body.code, 'not_pristine');
        assert.deepStrictEqual(state.apps.get(app.id), before, 'a refused upgrade changes nothing');
    } finally {
        delete templatesState.versionOverrides['app-request-form'];
    }
});

test('POST /:id/template-upgrade — owner-only: 403 for a reader, uniform 404 for strangers', async () => {
    const created = await api('POST', '/', { user: 'owner', body: { templateId: 'app-request-form' } });
    const app = created.body.app;
    try {
        templatesState.versionOverrides['app-request-form'] = 2;

        // Unpublished → invisible to everyone else (no existence leak).
        assert.strictEqual((await api('POST', `/${app.id}/template-upgrade`, { user: 'orgmate' })).status, 404);

        await api('PATCH', `/${app.id}/publish`, { user: 'owner', body: { isPublished: true, sharedGroups: [] } });
        assert.strictEqual((await api('POST', `/${app.id}/template-upgrade`, { user: 'orgmate' })).status, 403, 'a reader may not upgrade');
        assert.strictEqual((await api('POST', `/${app.id}/template-upgrade`, { user: 'outsider' })).status, 404);
        assert.strictEqual((await api('POST', '/app-nope/template-upgrade', { user: 'owner' })).status, 404);
    } finally {
        delete templatesState.versionOverrides['app-request-form'];
    }
});

// ── The permission gate itself ──────────────────────────────────────
// The four ownership tests above now run with manage_apps in hand, so this is
// the only place the gate is proved. Without it, giving `outsider` the
// permission would have quietly removed the gate from the suite's coverage
// while every test stayed green.
test('a member without manage_apps cannot create, publish, or delete an app', async () => {
    // Same org, same groups as `owner` — the ONLY difference is the permission.
    const created = await api('POST', '/', { user: 'nopermission', body: { name: 'Should not exist' } });
    assert.strictEqual(created.status, 403, 'a member without manage_apps created an app');
    assert.match(created.body.error, /manage_apps/);

    // And on an app that already exists and that they can see.
    const app = await createApp('owner', { name: 'Owned by owner' });

    const published = await api('PATCH', `/${app.id}/publish`, { user: 'nopermission', body: { isPublished: true } });
    assert.strictEqual(published.status, 403, 'a member without manage_apps published an app');

    const updated = await api('PUT', `/${app.id}`, { user: 'nopermission', body: { name: 'Renamed' } });
    assert.strictEqual(updated.status, 403);

    const removed = await api('DELETE', `/${app.id}`, { user: 'nopermission' });
    assert.strictEqual(removed.status, 403);

    // The app is untouched — a refused write must not be a partial write.
    // Read the store directly: the API shape could hide a half-applied write.
    const stored = state.apps.get(app.id);
    assert.ok(stored, 'a refused DELETE removed the app anyway');
    assert.strictEqual(stored.name, 'Owned by owner', 'a refused PUT renamed the app anyway');
    assert.strictEqual(stored.isPublished, false, 'a refused PATCH published the app anyway');
});

test('the same member may still READ and RUN what others built', async () => {
    // The gate is about building, not about using. If this ever starts failing,
    // manage_apps has been put on a read path and every ordinary member has
    // lost access to the apps made for them.
    const app = await createApp('owner', { name: 'Shared with the org' });
    await api('PATCH', `/${app.id}/publish`, { user: 'owner', body: { isPublished: true } });

    const list = await api('GET', '/', { user: 'nopermission' });
    assert.strictEqual(list.status, 200);

    const one = await api('GET', `/${app.id}`, { user: 'nopermission' });
    assert.strictEqual(one.status, 200, 'a member without manage_apps can no longer open a published app');
});

// ── Templates as files (export / import) ────────────────────────────
//
// The round trip is the test that matters: a template this installation serves
// has to be readable by the route that takes one in, or the two halves of the
// feature are two features. Everything else here is a refusal.

test('GET /templates/:id/export writes a template down; unknown → 404', async () => {
    const list = await api('GET', '/templates', { user: 'owner' });
    const first = list.body.templates[0];

    const res = await api('GET', `/templates/${first.id}/export`, { user: 'owner' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.envelope.format, 'beeflow.apptemplate');
    assert.strictEqual(res.body.envelope.schemaVersion, 1);
    assert.strictEqual(res.body.envelope.template.title, first.title);
    assert.ok(res.body.filename.endsWith('.beeflow-app.json'));

    // The provenance block is stamped by the ROUTE (the capture never knew the
    // tenant it sat in), and it is a claim: the importer sees it, nothing acts
    // on it.
    assert.strictEqual(res.body.envelope.source.orgId, 'orgA');
    assert.strictEqual(res.body.envelope.source.orgName, 'Org A');

    const missing = await api('GET', '/templates/not-a-template/export', { user: 'owner' });
    assert.strictEqual(missing.status, 404);
});

test('?download=1 hands the browser a named file', async () => {
    const list = await api('GET', '/templates', { user: 'owner' });
    const first = list.body.templates[0];

    const res = await fetch(`${baseUrl}/templates/${first.id}/export?download=1`, {
        headers: { 'x-test-user': 'owner' },
    });
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-disposition') || '', /^attachment; filename=".+\.beeflow-app\.json"$/);
    const envelope = await res.json();
    assert.strictEqual(envelope.format, 'beeflow.apptemplate');
    // The warnings belong to the exporter, not to the file.
    assert.strictEqual(envelope.warnings, undefined);
});

test('an exported template imports back as a captured template, never as an app', async () => {
    const list = await api('GET', '/templates', { user: 'owner' });
    // A data-backed starter, so the model + seed make the round trip too.
    const withData = list.body.templates.find(t => t.id === 'app-ticket-tracker') || list.body.templates[0];
    const exported = await api('GET', `/templates/${withData.id}/export`, { user: 'owner' });

    const appsBefore = state.apps.size;
    const res = await api('POST', '/templates/import', {
        user: 'owner', body: { envelope: exported.body.envelope },
    });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.strictEqual(res.body.template.id, 'utpl_test');
    assert.strictEqual(res.body.template.title, withData.title);
    // Org-scoped, so the colleagues who will install it can see it.
    assert.strictEqual(res.body.template.organizationId, 'orgA');
    // Imported, not captured: claiming a source app would claim a provenance
    // this installation cannot vouch for.
    assert.strictEqual(res.body.template.sourceAppId, null);
    assert.strictEqual(state.apps.size, appsBefore, 'importing a template created an app');
});

test('a bare envelope body is accepted too — a file read off disk is not wrapped', async () => {
    const list = await api('GET', '/templates', { user: 'owner' });
    const exported = await api('GET', `/templates/${list.body.templates[0].id}/export`, { user: 'owner' });

    const res = await api('POST', '/templates/import', { user: 'owner', body: exported.body.envelope });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
});

test('a title in the body renames the imported template and the app it will make', async () => {
    const list = await api('GET', '/templates', { user: 'owner' });
    const exported = await api('GET', `/templates/${list.body.templates[0].id}/export`, { user: 'owner' });

    const res = await api('POST', '/templates/import', {
        user: 'owner', body: { envelope: exported.body.envelope, title: 'Our intake' },
    });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.template.title, 'Our intake');
    assert.strictEqual(res.body.template.payload.definition.meta.name, 'Our intake',
        'the app made from it carries the name too, not the one the file came with');
});

test('a file this installation will not take is refused with each reason named', async () => {
    for (const body of [{}, { envelope: { format: 'something.else' } }, { envelope: { format: 'beeflow.apptemplate', schemaVersion: 99 } }]) {
        const res = await api('POST', '/templates/import', { user: 'owner', body });
        assert.strictEqual(res.status, 400, JSON.stringify(res.body));
        assert.strictEqual(res.body.code, 'invalid_template');
        assert.ok(Array.isArray(res.body.details) && res.body.details.length > 0,
            'a bare "invalid" leaves the only person who can fix the file with nothing to go on');
    }
});

test('export and import are BUILDING, so a member without manage_apps is refused', async () => {
    const list = await api('GET', '/templates', { user: 'owner' });
    const first = list.body.templates[0];

    const exported = await api('GET', `/templates/${first.id}/export`, { user: 'nopermission' });
    assert.strictEqual(exported.status, 403);

    const imported = await api('POST', '/templates/import', { user: 'nopermission', body: {} });
    assert.strictEqual(imported.status, 403);
});

test('both file routes require a session', async () => {
    assert.strictEqual((await api('GET', '/templates/x/export')).status, 401);
    assert.strictEqual((await api('POST', '/templates/import', { body: {} })).status, 401);
});

// ── POST /import — an app archive becomes a live app ────────────────
//
// The two routes are deliberately different doors. `/templates/import` puts a
// blueprint in the gallery and creates nothing; this one stands up one
// particular app, with its rows and its documents, and creates exactly one.
// The tests below are mostly about the seam between them and about the one
// place this route is stricter than `POST /`: nobody asked for an app with no
// tables, so a data model that will not install takes the app row with it.

const { canonicalizeDataModel: canonModel } = require('../appStudio/dataModel');

function archive(extra = {}) {
    const def = emptyDefinition('Imported demo');
    return {
        format: 'beeflow.app',
        schemaVersion: 1,
        app: { name: 'Imported demo', description: 'with data', icon: 'Inbox' },
        template: {
            definition: def,
            dataModel: canonModel({
                tables: [{ id: 'tbl_a', key: 'people', name: 'People', fields: [{ id: 'fld_1', key: 'name', type: 'text' }] }],
            }).model,
            datasets: [],
        },
        content: { records: { tbl_a: [{ $id: 'people_1', name: 'Ada' }] }, files: [] },
        ...extra,
    };
}

function resetImportSpies() {
    installState.calls.length = 0;
    installState.result = { ok: true, appId: null, dataModelVersion: 1 };
    installState.throwErr = null;
    contentState.calls.length = 0;
    contentState.result = { ok: true, rows: 1, files: 0, skipped: [] };
}

test('POST /import creates the app, installs the model, then fills it', async () => {
    resetImportSpies();
    const res = await api('POST', '/import', { user: 'owner', body: { envelope: archive() } });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.strictEqual(res.body.app.name, 'Imported demo');
    // Owner and organisation come from the SESSION, never from the file.
    assert.strictEqual(res.body.app.userId, 'owner');
    assert.strictEqual(res.body.app.organizationId, 'orgA');
    // An archive is not a template, so nothing claims it can be upgraded later.
    assert.strictEqual(res.body.app.templateId ?? null, null);

    assert.strictEqual(installState.calls.length, 1);
    assert.strictEqual(contentState.calls.length, 1);
    assert.strictEqual(contentState.calls[0].appId, res.body.app.id);
    assert.deepStrictEqual(Object.keys(contentState.calls[0].content.records), ['tbl_a']);
    assert.deepStrictEqual(res.body.report.installed, { rows: 1, files: 0, dataModelVersion: 1 });
});

test('POST /import — a name in the body wins over the one in the file', async () => {
    resetImportSpies();
    const res = await api('POST', '/import', { user: 'owner', body: { envelope: archive(), name: 'Mine' } });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.app.name, 'Mine');
    assert.strictEqual(res.body.app.definition.meta.name, 'Mine');
});

test('POST /import — a bare envelope body is read the same as { envelope }', async () => {
    resetImportSpies();
    const res = await api('POST', '/import', { user: 'owner', body: archive() });
    assert.strictEqual(res.status, 201);
});

// The route is rate-limited to 3/min per USER, so the tests below share the
// work out among colleagues instead of asking for the cap to be raised: a
// ceiling that the test suite has to dodge is a ceiling worth having.
test('POST /import — what did not arrive is reported, never swallowed', async () => {
    resetImportSpies();
    contentState.result = { ok: true, rows: 1, files: 2, skipped: ['file x.pdf: That file type is not supported'] };
    const res = await api('POST', '/import', { user: 'orgmate', body: { envelope: archive() } });
    assert.strictEqual(res.status, 201);
    assert.ok(res.body.warnings.some((w) => /x\.pdf/.test(w)));
});

test('POST /import — a file that is not an archive is refused with its reasons', async () => {
    resetImportSpies();
    const res = await api('POST', '/import', { user: 'orgmate', body: { envelope: { hello: 'world' } } });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.code, 'invalid_archive');
    assert.ok(Array.isArray(res.body.details) && res.body.details.length);
    // Nothing was created on the way to saying no.
    assert.strictEqual(installState.calls.length, 0);
    assert.strictEqual(contentState.calls.length, 0);
});

test('POST /import — a template file is refused HERE and told where to go', async () => {
    resetImportSpies();
    const res = await api('POST', '/import', {
        user: 'orgmate',
        body: { envelope: { format: 'beeflow.apptemplate', schemaVersion: 1, template: {} } },
    });
    assert.strictEqual(res.status, 400);
    assert.match(res.body.details[0], /From a template file/);
});

test('POST /import — a data model that will not install takes the app row with it', async () => {
    resetImportSpies();
    installState.result = { ok: false, error: 'data model failed validation' };
    const before = state.apps.size;
    const res = await api('POST', '/import', { user: 'orgadmin', body: { envelope: archive() } });
    assert.strictEqual(res.status, 422);
    assert.strictEqual(res.body.code, 'model_install_failed');
    assert.match(res.body.error, /data model failed validation/);
    // No shell left behind: an app with every screen and no tables reads as a
    // broken import rather than a failed one.
    assert.strictEqual(state.apps.size, before);
    assert.strictEqual(contentState.calls.length, 0);
});

test('POST /import — a throw part-way leaves nothing behind either', async () => {
    resetImportSpies();
    installState.throwErr = new Error('boom');
    const before = state.apps.size;
    const res = await api('POST', '/import', { user: 'orgadmin', body: { envelope: archive() } });
    assert.strictEqual(res.status, 500);
    assert.strictEqual(state.apps.size, before);
});

test('POST /import needs a session and the manage_apps permission', async () => {
    assert.strictEqual((await api('POST', '/import', { body: archive() })).status, 401);
    const res = await api('POST', '/import', { user: 'nopermission', body: { envelope: archive() } });
    assert.strictEqual(res.status, 403);
});
