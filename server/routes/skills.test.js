'use strict';

/**
 * routes/skills — the S1 API surface (Bee Flow Builder redesign, Sep 2026).
 *
 * What is pinned here is what the Studio (S2/S3), the Used-by tab and mobile
 * depend on:
 *   - `/usage-summary` is registered BEFORE `/:id`, or the literal string
 *     "usage-summary" is read as a skill id and the summary 404s;
 *   - `GET /:id/usage` answers `{ usage: [...] }` — the shape
 *     `hooks/useUsage.js` normalises — and 404s for a skill the caller
 *     cannot see, so the endpoint is never a visibility oracle;
 *   - DELETE asks once: 409 `in_use` WITH the list, unless the caller
 *     confirmed. The confirmation is a real boolean, not any truthy value;
 *   - PUT is owner OR manage_skills in the skill's OWN org: visible but not
 *     editable is a 403 `not_editable` (the 350ms autosave must not retry a
 *     404 forever), and the manager widening is never handed to the store
 *     for a skill of another org;
 *   - a string in a structured field is a 400 `invalid_structure` naming the
 *     field, not a 500;
 *   - the list carries `canEdit` and `lastTest` per row;
 *   - S3's routes are registered (`/ai/draft`, `/:id/ai/improve`,
 *     `/:id/test`, `/test-agents`) and none of their handlers is LOADED by
 *     requiring this router — they reach the LLM client and a real database,
 *     and this suite has neither;
 *   - S3's two READS carry `manage_skills` like the rest of the editor, and
 *     `/:id/test-runs` refuses a visible-but-not-editable skill with a 403:
 *     the rows hold other people's free-text test questions.
 *
 * DB-free: every dependency of skills.js is stubbed through the
 * Module._resolveFilename hook (the pattern of routes/agents/crud.authz.test.js);
 * core/skills/skillStructure stays REAL, since the 400 contract is its own.
 *
 * Run: cd server && node --test --test-force-exit routes/skills.test.js
 */

const test = require('node:test');
const { beforeEach } = require('node:test');
const assert = require('node:assert');
const Module = require('module');

const { SkillStructureError } = require('../core/skills/skillStructure');

// ── Fixtures the mocks close over ───────────────────────────────────
const fx = {
    userId: 'owner',
    orgId: 'org1',
    canManage: true,
    skill: null,          // what getSkill resolves
    list: [],             // what getAvailableSkills resolves
    usage: [],            // the rows listSkillUsage resolves
    uncheckedKinds: [],   // the kinds it could NOT scan (missing automations table)
    throwOnWrite: null,   // an error createSkill/updateSkill should throw
    updated: true,        // updateSkill's return
    deleted: true,        // deleteSkill's return
    calls: [],
};
const rec = (name, args) => { fx.calls.push({ name, args }); };
const lastCall = (name) => [...fx.calls].reverse().find(c => c.name === name);

const mw = () => (req, res, next) => next();
/**
 * `requirePermission` as a pass-through that REMEMBERS which permission it was
 * asked for. Same runtime behaviour as `mw` — every existing test still walks
 * straight through it — but the tag makes the gate itself assertable, which a
 * bare pass-through cannot be: a route whose gate is deleted keeps answering
 * exactly as before.
 */
const gate = (permission) => {
    const fn = (req, res, next) => next();
    fn.permission = permission;
    return fn;
};

const MOCKS = {
    '../stores/skillStore': {
        getAvailableSkills: async (orgId, userId, viewer) => { rec('getAvailableSkills', { orgId, userId, viewer }); return fx.list; },
        getSkill: async (id, orgId, userId, viewer) => { rec('getSkill', { id, orgId, userId, viewer }); return fx.skill; },
        createSkill: async (p) => { rec('createSkill', p); if (fx.throwOnWrite) throw fx.throwOnWrite; return { id: 'new1', ...p }; },
        updateSkill: async (id, userId, updates, opts) => { rec('updateSkill', { id, userId, updates, opts }); if (fx.throwOnWrite) throw fx.throwOnWrite; return fx.updated; },
        deleteSkill: async (id, userId, isAdmin) => { rec('deleteSkill', { id, userId, isAdmin }); return fx.deleted; },
        // `{ rows, unchecked }` — the store names the kinds it could not scan
        // instead of folding them into an empty list, because the two callers
        // of this function make the loudest claims in the product off it.
        listSkillUsage: async (id, orgId) => { rec('listSkillUsage', { id, orgId }); return { rows: fx.usage, unchecked: fx.uncheckedKinds }; },
        getUsageSummary: async (orgId, ids) => { rec('getUsageSummary', { orgId, ids }); return Object.fromEntries(ids.map(i => [i, { agents: 0, automations: 0, lastUsedAt: null }])); },
        listTestRuns: async (id) => { rec('listTestRuns', { id }); return [{ id: 'tr1', skillId: id, status: 'warning' }]; },
    },
    '../auth': {
        requirePermission: gate,
        requireActiveOrgForMutations: mw,
        validateSharedGroupsForOrg: async (orgId, groups) => (Array.isArray(groups) ? groups : []),
    },
    '../auth/permissions': {
        requireAuth: (req, res, next) => next(),
        hasPermission: async () => fx.canManage,
    },
    '../core/tools/skillInjection': { sanitizeEnabledIntegrations: (v) => (Array.isArray(v) ? v : []) },
    '../stores/userStore': { getUser: async () => ({ id: fx.userId, organizationId: fx.orgId }) },
    '../stores/agentStore': { scrubSkillFromAllAgents: async () => 0 },
};
const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:skills-routes:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /routes[\\/]skills\.js$/.test(parent.filename) && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./skills');
test.after(() => { Module._resolveFilename = originalResolve; });

// ── Driving the router without a server ─────────────────────────────
function routeStack(method, routePath) {
    for (const layer of router.stack) {
        if (layer.route && layer.route.path === routePath && layer.route.methods[method]) {
            return layer.route.stack.map(l => l.handle);
        }
    }
    throw new Error(`route not found: ${method} ${routePath}`);
}

// A schema refusal is `next(err)`, which Express hands to the terminal
// handler instead of the next layer. Walking on would run the handler with
// the body the schema just refused.
const { terminalErrorHandler } = require('../core/http/terminalErrorHandler');

async function call(method, routePath, req = {}) {
    const res = { statusCode: 200, body: null, sent: false, headersSent: false };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; res.sent = true; res.headersSent = true; return res; };
    const full = { params: {}, query: {}, body: {}, headers: {}, session: { user: { id: fx.userId } }, ...req };
    for (const handle of routeStack(method, routePath)) {
        let advanced = false;
        let failure = null;
        await handle(full, res, (err) => { advanced = true; failure = err || null; });
        if (failure) { terminalErrorHandler(failure, full, res, () => {}); break; }
        if (res.sent || !advanced) break;
    }
    return res;
}

const SKILL = (over = {}) => ({ id: 'sk1', orgId: 'org1', userId: 'owner', name: 'Quote helper', canEdit: true, ...over });

beforeEach(() => {
    fx.userId = 'owner'; fx.orgId = 'org1'; fx.canManage = true;
    fx.skill = SKILL(); fx.list = []; fx.usage = []; fx.uncheckedKinds = [];
    fx.throwOnWrite = null; fx.updated = true; fx.deleted = true;
    fx.calls.length = 0;
});

// ── route order ─────────────────────────────────────────────────────
test('/usage-summary is registered before /:id (otherwise it is read as a skill id)', () => {
    const paths = router.stack.filter(l => l.route).map(l => l.route.path);
    assert.ok(paths.includes('/usage-summary'), 'the summary route exists');
    assert.ok(paths.indexOf('/usage-summary') < paths.indexOf('/:id'), '/usage-summary must come first');
});

test('/test-agents is registered before /:id too (S3)', () => {
    const paths = router.stack.filter(l => l.route).map(l => l.route.path);
    assert.ok(paths.includes('/test-agents'), 'the agent picker route exists');
    assert.ok(paths.indexOf('/test-agents') < paths.indexOf('/:id'), '/test-agents must come first');
});

/**
 * S2's example routes: registered before `/:id`, and all three behind
 * `manage_skills`.
 *
 * The two GETs return only the CALLER'S OWN conversations, so leaving them
 * open would leak nothing across accounts — but they exist for one purpose,
 * feeding the POST, and reaching the skill editor at all already requires this
 * permission (PUT /:id does). Gating them means an account that could never
 * have created the example is refused when the picker OPENS, instead of after
 * it has read a list of chat titles and one conversation in full.
 */
test('the example routes come before /:id and all three demand manage_skills', () => {
    const EXAMPLE_ROUTES = [
        ['get', '/examples/conversations'],
        ['get', '/examples/conversations/:conversationId/messages'],
        ['post', '/:id/examples/from-message'],
    ];
    const paths = router.stack.filter(l => l.route).map(l => l.route.path);
    for (const [method, path] of EXAMPLE_ROUTES) {
        assert.ok(paths.includes(path), `${method.toUpperCase()} ${path} is registered`);
        const gates = routeStack(method, path).map(h => h.permission).filter(Boolean);
        assert.deepStrictEqual(gates, ['manage_skills'], `${path} is gated on manage_skills`);
    }
    // The literal `/examples/...` prefix would otherwise be read as a skill id.
    assert.ok(
        paths.indexOf('/examples/conversations') < paths.indexOf('/:id'),
        'the conversation list must be registered before /:id',
    );
    assert.ok(
        paths.indexOf('/examples/conversations/:conversationId/messages') < paths.indexOf('/:id'),
        'the message list must be registered before /:id',
    );
});

test('requiring routes/skills.js does not load the S2 example handler', () => {
    // Same lazy-require contract as S3's routes below: examples.js reaches a
    // real database and the real PII guard, and this suite has neither.
    const loaded = Object.keys(require.cache).filter(f => /routes[\\/]skills[\\/]examples\.js$/.test(f));
    assert.deepStrictEqual(loaded, [], 'no example handler was loaded by requiring routes/skills.js');
});

test("S3's routes exist and none of them loads its handler at registration", () => {
    // The sub-handlers reach the LLM client, the provider adapters and the
    // knowledge search. They are required lazily, per request — an eager
    // require would pull all of that (and a real database) into THIS suite,
    // which is the whole reason it can run without one.
    const paths = router.stack.filter(l => l.route).map(l => l.route.path);
    for (const p of ['/ai/draft', '/:id/ai/improve', '/:id/test']) {
        assert.ok(paths.includes(p), `${p} is registered`);
    }
    const loaded = Object.keys(require.cache).filter(f => /routes[\\/]skills[\\/](ai|test)\.js$/.test(f));
    assert.deepStrictEqual(loaded, [], 'no S3 handler was loaded by requiring routes/skills.js');
});

// ── list ────────────────────────────────────────────────────────────
test('GET / asks the store for canEdit and lastTest per row', async () => {
    fx.list = [SKILL({ lastTest: { status: 'warning', adviceCount: 1, ranAt: '2026-09-03T10:00:00.000Z' } })];
    const res = await call('get', '/');
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body[0].lastTest, { status: 'warning', adviceCount: 1, ranAt: '2026-09-03T10:00:00.000Z' });
    assert.deepStrictEqual(lastCall('getAvailableSkills').args.viewer, { canManage: true, withLastTest: true });
});

test('GET / without manage_skills still lists, read-only', async () => {
    fx.canManage = false;
    fx.list = [SKILL({ canEdit: false })];
    const res = await call('get', '/');
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(lastCall('getAvailableSkills').args.viewer.canManage, false);
});

test('GET /usage-summary answers { summary } keyed by skill id', async () => {
    fx.list = [SKILL(), SKILL({ id: 'sk2' })];
    const res = await call('get', '/usage-summary');
    assert.deepStrictEqual(Object.keys(res.body.summary), ['sk1', 'sk2']);
    assert.deepStrictEqual(lastCall('getUsageSummary').args.ids, ['sk1', 'sk2']);
});

// ── usage ───────────────────────────────────────────────────────────
test('GET /:id/usage answers { usage } and scans the SKILL\'S org, not the caller\'s', async () => {
    fx.skill = SKILL({ orgId: 'orgOwner' });
    fx.usage = [{ kind: 'agent', id: 'a1', title: 'Offerte-assistent', role: 'chat', lastAt: null, ownerId: 'owner' }];
    const res = await call('get', '/:id/usage', { params: { id: 'sk1' } });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { usage: fx.usage, unchecked: [] });
    assert.deepStrictEqual(lastCall('listSkillUsage').args, { id: 'sk1', orgId: 'orgOwner' });
});

/**
 * The half that could never fire before. `listSkillUsage` has a branch that
 * skips the `automation` kind entirely (no automations table on an install
 * without routines) and this route answered a bare `{ usage }`, so the client
 * side that was BUILT for this — useUsage's `normaliseUnchecked`, UsedByTab's
 * narrower empty line, DangerZone's narrower delete line — could not be
 * reached down the real path. The tab said "No agent or automation uses this
 * skill yet" and the delete card said "can be deleted without breaking
 * anything else" over a kind nobody had looked at.
 */
test('GET /:id/usage passes on the kinds the scan could not check', async () => {
    fx.usage = [];
    fx.uncheckedKinds = ['automation'];
    const res = await call('get', '/:id/usage', { params: { id: 'sk1' } });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { usage: [], unchecked: ['automation'] });
});

test('GET /:id/usage 404s for a skill the caller cannot see (never a visibility oracle)', async () => {
    fx.skill = null;
    const res = await call('get', '/:id/usage', { params: { id: 'sk1' } });
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(lastCall('listSkillUsage'), undefined, 'nothing scanned');
});

test('GET /:id/test-runs answers the last runs, 404 when invisible', async () => {
    const ok = await call('get', '/:id/test-runs', { params: { id: 'sk1' } });
    assert.strictEqual(ok.body.runs[0].status, 'warning');
    fx.skill = null;
    assert.strictEqual((await call('get', '/:id/test-runs', { params: { id: 'sk1' } })).statusCode, 404);
});

/**
 * S3's two read routes, gated like the rest of the editor.
 *
 * `/test-agents` is the picker at the top of the Test tab. It leaks nothing by
 * itself, but it exists for one screen — the one behind `manage_skills` — and
 * this file's own rule (its header) is that such a route refuses when the
 * picker OPENS, not after someone has chosen an agent. `/examples/
 * conversations` carries the gate for exactly that reason.
 */
test('GET /test-agents carries manage_skills like every other editor route', () => {
    const gates = routeStack('get', '/test-agents').map(h => h.permission).filter(Boolean);
    assert.deepStrictEqual(gates, ['manage_skills']);
});

test('GET /:id/test-runs carries manage_skills', () => {
    const gates = routeStack('get', '/:id/test-runs').map(h => h.permission).filter(Boolean);
    assert.deepStrictEqual(gates, ['manage_skills']);
});

/**
 * The gate alone is not enough here, and this is the row that says why.
 *
 * A test run stores the question a colleague TYPED, in free text, and in this
 * product those questions routinely carry a customer name, a person or a case
 * (BFSF-441 territory). Being allowed to SEE a skill does not hand that over:
 * a skill shared to a group is visible to people who may not edit it —
 * skillStore.canEditSkill keeps the two apart on purpose — and a manager of
 * another org sees it too. So visibility must not open the history.
 *
 * 403, not 404: the skill itself is visible, so a 404 would lie about it.
 * That is the answer POST /:id/ai/improve already gives.
 */
test('GET /:id/test-runs on a skill this account may see but not edit is 403, not a history', async () => {
    fx.skill = SKILL({ canEdit: false });
    const res = await call('get', '/:id/test-runs', { params: { id: 'sk1' } });
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.body.code, 'not_editable');
    assert.strictEqual(lastCall('listTestRuns'), undefined, 'no question of anyone else was read');
    // And the row was fetched WITH a viewer — without it `canEdit` is whatever
    // the store defaults to, and this refusal is decided on a guess.
    assert.deepStrictEqual(lastCall('getSkill').args.viewer, { canManage: true });
});

test('GET /:id/test-runs on a skill this account may edit returns the rows', async () => {
    fx.skill = SKILL({ canEdit: true });
    const res = await call('get', '/:id/test-runs', { params: { id: 'sk1' } });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { runs: [{ id: 'tr1', skillId: 'sk1', status: 'warning' }] });
});

// ── create ──────────────────────────────────────────────────────────
test('POST / forwards the structured fields and answers 201 with canEdit', async () => {
    const body = {
        name: 'Quote helper',
        steps: [{ text: 'Read' }],
        rulesV2: [{ polarity: 'never', text: 'Never guess' }],
        examplesV2: [{ question: 'q', good: 'a' }],
        outputSchema: { properties: { amount: { type: 'number' } } },
        knowledgeBaseIds: ['kb1'],
        allowedAutomationIds: ['au1'],
    };
    const res = await call('post', '/', { body });
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(res.body.canEdit, true);
    const args = lastCall('createSkill').args;
    for (const k of ['steps', 'rulesV2', 'examplesV2', 'outputSchema', 'knowledgeBaseIds', 'allowedAutomationIds']) {
        assert.deepStrictEqual(args[k], body[k], `${k} forwarded verbatim`);
    }
});

test('POST / turns a structure error into a 400 that names the field, not a 500', async () => {
    fx.throwOnWrite = new SkillStructureError('steps must be an array, not a string', 'steps');
    const res = await call('post', '/', { body: { name: 'x', steps: '1. One' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'invalid_structure');
    assert.strictEqual(res.body.field, 'steps');
});

test('POST / still refuses a nameless skill and an over-long instructions field', async () => {
    assert.strictEqual((await call('post', '/', { body: { name: '  ' } })).statusCode, 400);
    assert.strictEqual((await call('post', '/', { body: { name: 'x', instructions: 'a'.repeat(4001) } })).statusCode, 400);
});

// ── update ──────────────────────────────────────────────────────────
test('PUT /:id passes managerOrgId ONLY for a skill of the caller\'s own org', async () => {
    const res = await call('put', '/:id', { params: { id: 'sk1' }, body: { name: 'Renamed' } });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { success: true }, 'mobile reads exactly this');
    assert.deepStrictEqual(lastCall('updateSkill').args.opts, { managerOrgId: 'org1' });

    // A personal skill (org-less) never gets the org widening.
    fx.skill = SKILL({ orgId: null });
    await call('put', '/:id', { params: { id: 'sk1' }, body: { name: 'Renamed' } });
    assert.deepStrictEqual(lastCall('updateSkill').args.opts, { managerOrgId: null });

    // A skill of ANOTHER org: the widening would be a cross-org edit.
    fx.skill = SKILL({ orgId: 'org2' });
    await call('put', '/:id', { params: { id: 'sk1' }, body: { name: 'Renamed' } });
    assert.deepStrictEqual(lastCall('updateSkill').args.opts, { managerOrgId: null });
});

test('PUT /:id is 403 not_editable when the caller may see but not edit — never a 404 the autosave retries', async () => {
    fx.skill = SKILL({ canEdit: false });
    const res = await call('put', '/:id', { params: { id: 'sk1' }, body: { name: 'x' } });
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.body.code, 'not_editable');
    assert.strictEqual(lastCall('updateSkill'), undefined, 'nothing written');
});

test('PUT /:id 404s for an invisible skill, and a structure error is a 400', async () => {
    fx.skill = null;
    assert.strictEqual((await call('put', '/:id', { params: { id: 'sk1' }, body: {} })).statusCode, 404);
    fx.skill = SKILL();
    fx.throwOnWrite = new SkillStructureError('outputSchema must be an object, not a string', 'outputSchema');
    const res = await call('put', '/:id', { params: { id: 'sk1' }, body: { outputSchema: '{}' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.field, 'outputSchema');
});

/**
 * De 4000-grens op `instructions` staat op de SERVER, en dat is de bedoeling:
 * de tekst gaat elke beurt mee in de systeemprompt, dus de grens hoort waar
 * de prompt wordt gebouwd en niet bij één van de clients.
 *
 * POST had die test al. PUT niet — terwijl PUT de route is waar de Studio elke
 * 350ms op uitkomt. Twee dingen worden hier vastgehouden:
 *
 *   1. te lang is een 400 die NIETS schrijft. Een weigering die de rest van de
 *      body wel had opgeslagen zou een halve save zijn, en de editor toont er
 *      één rood lampje voor;
 *   2. precies 4000 mag WEL. De editor kapt zelf af op 4000 (SkillDetail's
 *      INSTRUCTION_LIMIT) om die 400 nooit uit te lokken. Zou de server op
 *      `>= 4000` weigeren, dan stuurt de client eindeloos de enige waarde die
 *      hij kan maken en die de server nooit accepteert — een lus die alleen
 *      als een kapot opslaanlampje zichtbaar is. De twee grenzen moeten dus
 *      dezelfde grens zijn, en dat is wat deze regel bewaakt.
 */
test('PUT /:id refuses instructions over the cap and writes nothing; exactly 4000 still passes', async () => {
    const tooLong = await call('put', '/:id', { params: { id: 'sk1' }, body: { instructions: 'a'.repeat(4001) } });
    assert.strictEqual(tooLong.statusCode, 400);
    assert.strictEqual(lastCall('updateSkill'), undefined, 'a refused save writes nothing at all');

    fx.calls.length = 0;
    const atTheLine = await call('put', '/:id', { params: { id: 'sk1' }, body: { instructions: 'a'.repeat(4000) } });
    assert.strictEqual(atTheLine.statusCode, 200);
    assert.strictEqual(lastCall('updateSkill').args.updates.instructions.length, 4000);
});

test('PUT /:id leaves an unsent facet undefined — a text-only phone save must not blank the structure', async () => {
    await call('put', '/:id', { params: { id: 'sk1' }, body: { workflow: '1. Phone edit' } });
    const u = lastCall('updateSkill').args.updates;
    assert.strictEqual(u.workflow, '1. Phone edit');
    for (const k of ['steps', 'rulesV2', 'examplesV2', 'outputSchema', 'knowledgeBaseIds', 'allowedAutomationIds', 'sharedGroups', 'enabledIntegrations']) {
        assert.strictEqual(u[k], undefined, `${k} not sent = leave as-is`);
    }
});

// ── delete ──────────────────────────────────────────────────────────
test('DELETE /:id answers 409 in_use WITH the list, and writes nothing', async () => {
    fx.usage = [{ kind: 'agent', id: 'a1', title: 'Offerte-assistent', role: 'chat' }];
    const res = await call('delete', '/:id', { params: { id: 'sk1' } });
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.body.code, 'in_use');
    assert.deepStrictEqual(res.body.usage, fx.usage);
    assert.deepStrictEqual(res.body.unchecked, []);
    assert.strictEqual(lastCall('deleteSkill'), undefined);
});

test('DELETE /:id deletes once the breakage is confirmed — and only on a real confirmation', async () => {
    fx.usage = [{ kind: 'agent', id: 'a1', role: 'chat' }];
    const ok = await call('delete', '/:id', { params: { id: 'sk1' }, body: { confirmBreaking: true } });
    assert.strictEqual(ok.statusCode, 200);
    assert.deepStrictEqual(ok.body, { success: true });
    const viaQuery = await call('delete', '/:id', { params: { id: 'sk1' }, query: { confirmBreaking: 'true' } });
    assert.strictEqual(viaQuery.statusCode, 200);
    // A truthy-but-not-true value is not a confirmation. It used to fall
    // through to the 409; it is refused now, naming the field — either way
    // nothing is deleted.
    fx.calls.length = 0;
    for (const bad of ['yes', 1, {}]) {
        const res = await call('delete', '/:id', { params: { id: 'sk1' }, body: { confirmBreaking: bad } });
        assert.strictEqual(res.statusCode, 400, `confirmBreaking=${JSON.stringify(bad)} must not delete`);
        assert.ok(res.body.details.some((d) => d.path === 'body.confirmBreaking'));
    }
    assert.strictEqual(lastCall('deleteSkill'), undefined, 'nothing deleted');
});

test('DELETE /:id of an unused skill needs no confirmation; a missing row is a 404', async () => {
    assert.strictEqual((await call('delete', '/:id', { params: { id: 'sk1' } })).statusCode, 200);
    fx.deleted = false;
    assert.strictEqual((await call('delete', '/:id', { params: { id: 'sk1' } })).statusCode, 404);
});
