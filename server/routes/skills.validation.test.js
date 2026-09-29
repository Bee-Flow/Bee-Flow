/**
 * What the skills routes accept, and what they say when they refuse
 * (routes/skills.js — including the door of the handlers in ./skills/*.js).
 *
 * Every refusal here used to be a 2xx that did something else: a misspelled
 * `sharedGroup` next to `isShared: true` shared the skill with the whole
 * organisation, a blank group entry did the same, `enabledIntegrations` sent
 * as a string cleared every integration, `isShared: "true"` was stored as
 * false (unsharing the skill), a misspelled `notes` had the AI rewrite and store
 * the skill without the instruction, and `messageIndex: null` filed message 0
 * as the example. What this file pins:
 *
 *   - the 400 NAMES the field (`body.sharedGroups.0`), not just "invalid request";
 *   - the message is a sentence, including for a field simply left out;
 *   - neither the store nor the handler is reached, so nothing changes;
 *   - the structured facets still reach the store, whose 400 names the field
 *     the Studio's autosave points at.
 *
 * Run: cd server && node --test routes/skills.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const { SkillStructureError } = require('../core/skills/skillStructure');

// Every store call and every delegated handler lands in `touched`.
const touched = [];
const pass = (req, res, next) => next();
const fx = { throwOnWrite: null };
const handler = (name) => (req, res) => { touched.push({ what: name, body: req.body }); res.json({ ok: true }); };

const MOCKS = {
    '../stores/skillStore': {
        getAvailableSkills: async () => [],
        getSkill: async (id) => ({ id, orgId: 'org1', userId: 'u1', canEdit: true }),
        createSkill: async (p) => { touched.push({ what: 'createSkill', body: p }); return { id: 'new1', ...p }; },
        updateSkill: async (id, userId, updates) => {
            touched.push({ what: 'updateSkill', body: updates });
            if (fx.throwOnWrite) throw fx.throwOnWrite;
            return true;
        },
        deleteSkill: async () => { touched.push({ what: 'deleteSkill' }); return true; },
        listSkillUsage: async () => ({ rows: [], unchecked: [] }),
    },
    '../auth': {
        requirePermission: () => pass,
        requireActiveOrgForMutations: () => pass,
        validateSharedGroupsForOrg: async (orgId, groups) => (Array.isArray(groups) ? groups : undefined),
    },
    '../auth/permissions': { requireAuth: pass, hasPermission: async () => true },
    '../core/tools/skillInjection': { sanitizeEnabledIntegrations: (v) => (Array.isArray(v) ? v : []) },
    '../stores/userStore': { getUser: async () => ({ id: 'u1', organizationId: 'org1' }) },
    '../stores/agentStore': { scrubSkillFromAllAgents: async () => 0 },
    './skills/ai': { limiter: pass, draft: handler('ai.draft'), improve: handler('ai.improve') },
    './skills/test': { limiter: pass, run: handler('test.run'), listAgents: handler('test.listAgents') },
    './skills/examples': {
        listConversations: handler('examples.listConversations'),
        listMessages: handler('examples.listMessages'),
        fromMessage: handler('examples.fromMessage'),
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:skills-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /routes[\\/]skills\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./skills');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../core/http/terminalErrorHandler');

function dispatch({ method, url, body }) {
    const [pathname, search = ''] = url.split('?');
    const query = Object.fromEntries(new URLSearchParams(search));
    return new Promise((resolve, reject) => {
        const req = {
            method, url, originalUrl: url, path: pathname, body, query, headers: {},
            session: { user: { id: 'u1' } }, get() { return undefined; },
        };
        const res = {
            statusCode: 200, headersSent: false,
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            send(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            end() { this.headersSent = true; resolve(this); return this; },
        };
        router(req, res, (err) => {
            if (!err) return reject(new Error(`fell through: ${method} ${url}`));
            terminalErrorHandler(err, req, res, (e) => reject(e));
        });
    });
}

const refusedAt = (res, path) => {
    assert.strictEqual(res.statusCode, 400, JSON.stringify(res.body));
    assert.strictEqual(res.body.code, 'invalid_request');
    assert.ok(res.body.details.some((d) => d.path === path), `the refusal names ${path}: ${JSON.stringify(res.body.details)}`);
    assert.notStrictEqual(res.body.error, 'Required');
    assert.deepStrictEqual(touched, [], 'a refused request reaches neither store nor handler');
};

test.beforeEach(() => { touched.length = 0; fx.throwOnWrite = null; });

// ── sharing ─────────────────────────────────────────────────────────

test('a misspelled sharedGroup is refused instead of sharing with the whole organisation', async () => {
    const res = await dispatch({ method: 'POST', url: '/', body: { name: 'Quotes', isShared: true, sharedGroup: ['g1'] } });
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(touched, []);
});

test('a blank shared group is refused instead of being dropped into "everyone"', async () => {
    refusedAt(await dispatch({ method: 'PUT', url: '/sk1', body: { isShared: true, sharedGroups: [''] } }), 'body.sharedGroups.0');
});

test('isShared as the string "true" is refused — the store read it as false and unshared the skill', async () => {
    refusedAt(await dispatch({ method: 'POST', url: '/', body: { name: 'Quotes', isShared: 'true' } }), 'body.isShared');
    refusedAt(await dispatch({ method: 'PUT', url: '/sk1', body: { isShared: 'true' } }), 'body.isShared');
    refusedAt(await dispatch({ method: 'PUT', url: '/sk1', body: { dynamicActivation: 'true' } }), 'body.dynamicActivation');
});

// ── the writable fields ─────────────────────────────────────────────

test('enabledIntegrations as a string is refused instead of clearing every integration', async () => {
    refusedAt(await dispatch({ method: 'PUT', url: '/sk1', body: { enabledIntegrations: 'gmail' } }), 'body.enabledIntegrations');
});

test('a skill without a name is refused in words, on create and on update', async () => {
    const created = await dispatch({ method: 'POST', url: '/', body: {} });
    refusedAt(created, 'body.name');
    assert.strictEqual(created.body.error, 'A skill needs a name.');
    refusedAt(await dispatch({ method: 'PUT', url: '/sk1', body: { name: '  ' } }), 'body.name');
});

test('a structured facet still reaches the store, whose 400 names the field for the Studio', async () => {
    fx.throwOnWrite = new SkillStructureError('steps must be an array, not a string', 'steps');
    const res = await dispatch({ method: 'PUT', url: '/sk1', body: { steps: '1. One' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'invalid_structure');
    assert.strictEqual(res.body.field, 'steps');
});

test('the Studio\'s autosave payload passes, and a name is trimmed once', async () => {
    const body = {
        name: '  Quote helper ', description: '', instructions: 'Be brief.', icon: '⚡',
        isShared: false, dynamicActivation: false, sharedGroups: [], enabledIntegrations: [],
        steps: [], rulesV2: [], examplesV2: [], outputSchema: null, knowledgeBaseIds: [], allowedAutomationIds: [],
    };
    const res = await dispatch({ method: 'PUT', url: '/sk1', body });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(touched.find((t) => t.what === 'updateSkill').body.name, 'Quote helper');
});

test('mobile\'s six text fields pass on create', async () => {
    const res = await dispatch({
        method: 'POST', url: '/',
        body: { name: 'Mail', description: 'd', instructions: 'i', workflow: 'w', rules: 'r', examples: 'e', icon: '📧', isShared: false, dynamicActivation: false },
    });
    assert.strictEqual(res.statusCode, 201);
});

// ── the delegated handlers ──────────────────────────────────────────

test('improve with a misspelled note is refused instead of rewriting without it', async () => {
    refusedAt(await dispatch({ method: 'POST', url: '/sk1/ai/improve', body: { notes: 'make it formal' } }), 'body');
    const ok = await dispatch({ method: 'POST', url: '/sk1/ai/improve', body: { note: 'make it formal' } });
    assert.strictEqual(ok.statusCode, 200);
    assert.deepStrictEqual(touched.map((t) => t.what), ['ai.improve']);
});

test('an example from message null is refused instead of filing message 0', async () => {
    refusedAt(await dispatch({
        method: 'POST', url: '/sk1/examples/from-message', body: { conversationId: 'c1', messageIndex: null },
    }), 'body.messageIndex');
    refusedAt(await dispatch({
        method: 'POST', url: '/sk1/examples/from-message', body: { conversationId: 'c1', messageIndex: '' },
    }), 'body.messageIndex');
    const ok = await dispatch({ method: 'POST', url: '/sk1/examples/from-message', body: { conversationId: 'c1', messageIndex: 0 } });
    assert.strictEqual(ok.statusCode, 200);
});

test('the test run refuses a misspelled agentId before the stream opens; the Studio\'s null agent passes', async () => {
    refusedAt(await dispatch({ method: 'POST', url: '/sk1/test', body: { agentID: 'a1', question: 'q' } }), 'body');
    const ok = await dispatch({ method: 'POST', url: '/sk1/test', body: { agentId: null, question: 'q' } });
    assert.strictEqual(ok.statusCode, 200);
});

test('a draft sentence that is not text is refused; a blank one is still the handler\'s own answer', async () => {
    refusedAt(await dispatch({ method: 'POST', url: '/ai/draft', body: { sentence: 42 } }), 'body.sentence');
    const blank = await dispatch({ method: 'POST', url: '/ai/draft', body: { sentence: '' } });
    assert.strictEqual(blank.statusCode, 200, 'passes the schema; the (stubbed) handler answers no_sentence');
});

// ── reads and delete ────────────────────────────────────────────────

test('delete refuses a confirmBreaking query that is not true or false', async () => {
    refusedAt(await dispatch({ method: 'DELETE', url: '/sk1?confirmBreaking=1' }), 'query.confirmBreaking');
});

test('the reads take no query options', async () => {
    for (const url of ['/?orgId=x', '/usage-summary?kind=agent', '/sk1?full=1', '/sk1/usage?x=1', '/sk1/test-runs?limit=5', '/test-agents?all=1']) {
        const res = await dispatch({ method: 'GET', url });
        assert.strictEqual(res.statusCode, 400, url);
    }
    assert.deepStrictEqual(touched, []);
});
