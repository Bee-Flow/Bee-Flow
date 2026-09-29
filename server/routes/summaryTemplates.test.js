/**
 * Summary Templates API — CRUD + scope authorization.
 *
 * Drives the REAL Express router with require-cache-stubbed store + auth and a
 * stubbed req/res dispatch harness (same trick as transcriptions.reprocess.test.js) —
 * no HTTP listener, no DB. The pure default-precedence logic is covered
 * separately in core/meetingNotes/summaryTemplates.test.js.
 *
 * Run: cd server && node --test routes/summaryTemplates.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

function stub(p, exports) {
    const filename = require.resolve(p);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

// ── Controllable context ─────────────────────────────────────────────────────
let ctx;               // { orgId, groups, isOrgAdmin, orgGroups }
let templates;         // in-memory rows (camelCase, as the real store returns)
let idc;

function resetState() {
    ctx = { orgId: 'org-1', groups: ['g1'], isOrgAdmin: true, orgGroups: ['g1', 'g2'] };
    templates = [];
    idc = 0;
}
resetState();

// In-memory store faithful to the real store's shapes.
stub('../stores/summaryTemplateStore', {
    getById: async (id) => templates.find(t => t.id === id) || null,
    listVisible: async ({ userId, orgIds = [], groupIds = [] }) => templates.filter(t =>
        (t.scope === 'user' && t.userId === userId)
        || (t.scope === 'org' && orgIds.includes(t.organizationId))
        || (t.scope === 'group' && groupIds.includes(t.groupId))),
    listForUser: async (userId) => templates.filter(t => t.scope === 'user' && t.userId === userId),
    listForOrg: async (orgId) => templates.filter(t => t.organizationId === orgId && (t.scope === 'org' || t.scope === 'group')),
    create: async (data) => {
        const row = {
            id: `tpl-${++idc}`, isDefault: false,
            userId: null, organizationId: null, groupId: null,
            createdAt: '2026-01-01', updatedAt: '2026-01-01',
            ...data,
        };
        templates.push(row);
        return row;
    },
    update: async (id, updates) => {
        const t = templates.find(x => x.id === id);
        if (!t) return null;
        Object.assign(t, updates);
        return t;
    },
    remove: async (id) => {
        const before = templates.length;
        templates = templates.filter(x => x.id !== id);
        return templates.length < before;
    },
    resolveDefaultPrompt: async () => null, resolveDefaultTemplate: async () => null,
});

stub('../stores/userStore', {
    getUser: async (id) => ({ id, organizationId: ctx.orgId, groups: ctx.groups }),
    getAllGroups: async () => ctx.orgGroups.map(gid => ({ id: gid, name: `Group ${gid}`, description: '', organizationId: ctx.orgId })),
});

stub('../auth/permissions', {
    requireAuth: (req, res, next) => next(),
    resolveUserOrgIds: async () => new Set([ctx.orgId]),
    isOrgAdminForOrg: async (req, orgId) => ctx.isOrgAdmin && orgId === ctx.orgId,
    validateSharedGroupsForOrg: async (orgId, ids) => {
        const invalid = (ids || []).filter(gid => !ctx.orgGroups.includes(gid));
        if (invalid.length) { const e = new Error(`Invalid groups: ${invalid.join(',')}`); e.status = 400; throw e; }
        return ids;
    },
});

const router = require('./summaryTemplates');
// A schema refusal is passed to next(err); index.js answers it with the
// terminal handler, so this harness does the same instead of rejecting.
const { terminalErrorHandler } = require('../core/http/terminalErrorHandler');

// ── Dispatch harness ─────────────────────────────────────────────────────────
function dispatch({ method = 'GET', url, user = 'u1', body }) {
    return new Promise((resolve, reject) => {
        const req = {
            method, url, query: {}, headers: {},
            session: user ? { isAuthenticated: true, user: { id: user } } : null,
            get(name) { return this.headers[String(name).toLowerCase()]; },
        };
        if (body !== undefined) req.body = body;
        const res = {
            statusCode: 200, headers: {}, body: undefined, headersSent: false,
            set(k, v) { this.headers[String(k).toLowerCase()] = v; return this; },
            setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            send(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            end() { this.headersSent = true; resolve(this); return this; },
        };
        router(req, res, (err) => {
            if (!err) return reject(new Error(`fell through router: ${method} ${url}`));
            terminalErrorHandler(err, req, res, (e) => reject(e));
        });
    });
}

test.beforeEach(resetState);

// ── GET / ────────────────────────────────────────────────────────────────────
test('GET / returns the five built-ins, visible custom templates and manage flag', async () => {
    templates.push({ id: 'own', scope: 'user', userId: 'u1', name: 'Mine', prompt: 'p', organizationId: null, groupId: null, isDefault: false, updatedAt: '2026-01-01' });
    templates.push({ id: 'other', scope: 'user', userId: 'u2', name: 'Theirs', prompt: 'p', organizationId: null, groupId: null, isDefault: false, updatedAt: '2026-01-01' });
    templates.push({ id: 'org', scope: 'org', organizationId: 'org-1', name: 'Org', prompt: 'p', userId: null, groupId: null, isDefault: false, updatedAt: '2026-01-01' });
    templates.push({ id: 'grp', scope: 'group', groupId: 'g1', organizationId: 'org-1', name: 'Grp', prompt: 'p', userId: null, isDefault: false, updatedAt: '2026-01-01' });

    const res = await dispatch({ method: 'GET', url: '/' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.builtins.length, 5);
    const customIds = res.body.custom.map(t => t.id).sort();
    // Sees own user-scope + org + their group; NOT another user's personal template.
    assert.deepStrictEqual(customIds, ['grp', 'org', 'own']);
    assert.strictEqual(res.body.canManageOrg, true);
    assert.strictEqual(res.body.primaryOrgId, 'org-1');
});

test('GET / for a non-admin reports canManageOrg=false', async () => {
    ctx.isOrgAdmin = false;
    const res = await dispatch({ method: 'GET', url: '/' });
    assert.strictEqual(res.body.canManageOrg, false);
});

// ── POST / user scope ────────────────────────────────────────────────────────
test('POST / creates a personal template for any authenticated user', async () => {
    ctx.isOrgAdmin = false;
    const res = await dispatch({ method: 'POST', url: '/', body: { scope: 'user', name: 'My style', prompt: 'Summarise nicely' } });
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(res.body.scope, 'user');
    assert.strictEqual(res.body.userId, 'u1');
    assert.strictEqual(res.body.name, 'My style');
});

test('POST / rejects a blank name or prompt', async () => {
    const a = await dispatch({ method: 'POST', url: '/', body: { scope: 'user', name: '  ', prompt: 'x' } });
    assert.strictEqual(a.statusCode, 400);
    const b = await dispatch({ method: 'POST', url: '/', body: { scope: 'user', name: 'x', prompt: '' } });
    assert.strictEqual(b.statusCode, 400);
});

// ── POST / org + group scope (admin-gated) ───────────────────────────────────
test('POST / org scope requires org admin (403 for non-admin)', async () => {
    ctx.isOrgAdmin = false;
    const res = await dispatch({ method: 'POST', url: '/', body: { scope: 'org', name: 'Org tmpl', prompt: 'p' } });
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(templates.length, 0);
});

test('POST / org scope as admin creates an org-wide template', async () => {
    const res = await dispatch({ method: 'POST', url: '/', body: { scope: 'org', name: 'Org tmpl', prompt: 'p' } });
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(res.body.scope, 'org');
    assert.strictEqual(res.body.organizationId, 'org-1');
});

test('POST / group scope validates the group belongs to the org', async () => {
    const bad = await dispatch({ method: 'POST', url: '/', body: { scope: 'group', name: 'G', prompt: 'p', groupId: 'not-in-org' } });
    assert.strictEqual(bad.statusCode, 400);

    const ok = await dispatch({ method: 'POST', url: '/', body: { scope: 'group', name: 'G', prompt: 'p', groupId: 'g2' } });
    assert.strictEqual(ok.statusCode, 201);
    assert.strictEqual(ok.body.groupId, 'g2');
    assert.strictEqual(ok.body.organizationId, 'org-1');
});

test('POST / group scope requires a groupId', async () => {
    const res = await dispatch({ method: 'POST', url: '/', body: { scope: 'group', name: 'G', prompt: 'p' } });
    assert.strictEqual(res.statusCode, 400);
});

// ── PATCH / DELETE authorization ─────────────────────────────────────────────
test('PATCH /:id — a user may edit their own template but not another user\'s', async () => {
    templates.push({ id: 'own', scope: 'user', userId: 'u1', name: 'Mine', prompt: 'p', organizationId: null, groupId: null, isDefault: false });
    templates.push({ id: 'other', scope: 'user', userId: 'u2', name: 'Theirs', prompt: 'p', organizationId: null, groupId: null, isDefault: false });

    const ok = await dispatch({ method: 'PATCH', url: '/own', body: { name: 'Renamed' } });
    assert.strictEqual(ok.statusCode, 200);
    assert.strictEqual(ok.body.name, 'Renamed');

    const forbidden = await dispatch({ method: 'PATCH', url: '/other', body: { name: 'Hijack' } });
    assert.strictEqual(forbidden.statusCode, 403);
});

test('PATCH /:id — org template editable only by an org admin', async () => {
    templates.push({ id: 'org', scope: 'org', organizationId: 'org-1', name: 'Org', prompt: 'p', userId: null, groupId: null, isDefault: false });
    ctx.isOrgAdmin = false;
    const forbidden = await dispatch({ method: 'PATCH', url: '/org', body: { prompt: 'new' } });
    assert.strictEqual(forbidden.statusCode, 403);

    ctx.isOrgAdmin = true;
    const ok = await dispatch({ method: 'PATCH', url: '/org', body: { prompt: 'new' } });
    assert.strictEqual(ok.statusCode, 200);
    assert.strictEqual(ok.body.prompt, 'new');
});

test('PATCH /:id — unknown id is 404', async () => {
    const res = await dispatch({ method: 'PATCH', url: '/nope', body: { name: 'x' } });
    assert.strictEqual(res.statusCode, 404);
});

test('DELETE /:id — owner may delete, others may not', async () => {
    templates.push({ id: 'own', scope: 'user', userId: 'u1', name: 'Mine', prompt: 'p', organizationId: null, groupId: null, isDefault: false });
    const forbidden = await dispatch({ method: 'DELETE', url: '/own', user: 'u2' });
    assert.strictEqual(forbidden.statusCode, 403);
    assert.strictEqual(templates.length, 1);

    const ok = await dispatch({ method: 'DELETE', url: '/own', user: 'u1' });
    assert.strictEqual(ok.statusCode, 200);
    assert.strictEqual(templates.length, 0);
});

// ── GET /org (admin panel) ───────────────────────────────────────────────────
test('GET /org lists all org + group templates and the org groups (admin only)', async () => {
    templates.push({ id: 'org', scope: 'org', organizationId: 'org-1', name: 'Org', prompt: 'p', userId: null, groupId: null, isDefault: false });
    templates.push({ id: 'grpX', scope: 'group', groupId: 'g2', organizationId: 'org-1', name: 'Grp', prompt: 'p', userId: null, isDefault: false });
    templates.push({ id: 'mine', scope: 'user', userId: 'u1', name: 'Mine', prompt: 'p', organizationId: null, groupId: null, isDefault: false });

    const res = await dispatch({ method: 'GET', url: '/org' });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body.templates.map(t => t.id).sort(), ['grpX', 'org']);
    assert.strictEqual(res.body.groups.length, 2);

    ctx.isOrgAdmin = false;
    const forbidden = await dispatch({ method: 'GET', url: '/org' });
    assert.strictEqual(forbidden.statusCode, 403);
});

// ── DE VERSIE IS VAN DE SERVER, NIET VAN DE CLIENT (M4 stap 3) ───────
//
// `version` zegt met welke promptrevisie een samenvatting geschreven is. Zou
// een client hem kunnen zetten, dan is elke stempel op elke notitie een
// bewering die de client heeft gekozen — en de kolom waardeloos.
//
// Sinds de body strict is, wordt een PATCH die `version` noemt GEWEIGERD in
// plaats van half uitgevoerd: de hernoeming ernaast gaat dan ook niet door,
// en de client leest waarom.

test('PATCH /:id kan `version` niet zetten', async () => {
    templates.push({ id: 'own', scope: 'user', userId: 'u1', name: 'Mine', prompt: 'p', version: 3, organizationId: null, groupId: null, isDefault: false });
    const res = await dispatch({ method: 'PATCH', url: '/own', body: { name: 'Hernoemd', version: 99 } });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.details.some((d) => d.path === 'body'), JSON.stringify(res.body.details));
    assert.strictEqual(templates[0].version, 3, 'de client heeft de versie niet aangeraakt');
    assert.strictEqual(templates[0].name, 'Mine', 'een geweigerde PATCH verandert niets');
});

test('GET / geeft de versie mee, zodat een sjabloonrij te herkennen is', async () => {
    templates.push({ id: 'own', scope: 'user', userId: 'u1', name: 'Mine', prompt: 'p', version: 5, organizationId: null, groupId: null, isDefault: false });
    const res = await dispatch({ method: 'GET', url: '/' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.custom[0].version, 5);
});
