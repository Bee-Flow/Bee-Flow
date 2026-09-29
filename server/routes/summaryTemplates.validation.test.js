/**
 * What the summary-template routes accept, and what they say when they refuse
 * (routes/summaryTemplates.js).
 *
 * The bodies were read field by field with a default for whatever was missing,
 * and the defaults decided who sees a template: `{"scop": "org"}` made a
 * personal one under a 201, a `groupId` next to `scope: "org"` was ignored and
 * the template went org-wide, and `{"isDefault": "false"}` made it everyone's
 * default. Over-long names and prompts were cut to fit, silently. What this
 * file pins is the part a caller can act on:
 *
 *   - the 400 NAMES the field (`body.groupId`), not just "invalid request";
 *   - the message is a sentence the template editor can show;
 *   - the store is never reached, so a refused request changes nothing.
 *
 * Run: cd server && node --test routes/summaryTemplates.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every store write lands in `touched`. A refused request must leave it empty.
const touched = [];
const pass = (req, res, next) => next();

const OWN = { id: 'own', scope: 'user', userId: 'u1', name: 'Mine', prompt: 'p', isDefault: false };

const MOCKS = {
    '../stores/summaryTemplateStore': {
        getById: async (id) => (id === OWN.id ? { ...OWN } : null),
        listVisible: async () => [],
        listForOrg: async () => [],
        create: async (data) => { touched.push({ what: 'create', args: [data] }); return { id: 'tpl-1', ...data }; },
        update: async (id, updates) => { touched.push({ what: 'update', args: [id, updates] }); return { ...OWN, ...updates }; },
        remove: async () => true,
    },
    '../stores/userStore': {
        getUser: async (id) => ({ id, organizationId: 'org-1', groups: ['g1'] }),
        getAllGroups: async () => [],
    },
    '../auth/permissions': {
        requireAuth: pass,
        resolveUserOrgIds: async () => new Set(['org-1']),
        isOrgAdminForOrg: async () => true,
        validateSharedGroupsForOrg: async (orgId, ids) => ids,
    },
    '../core/meetingNotes/summaryTemplates': { BUILTIN_TEMPLATES: [], pickDefaultTemplate: () => null },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:summary-templates-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /routes[\\/]summaryTemplates\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./summaryTemplates');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../core/http/terminalErrorHandler');

function dispatch({ method, url, body }) {
    return new Promise((resolve, reject) => {
        const req = {
            method, url, originalUrl: url, path: url, body, query: {}, headers: {},
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

test.beforeEach(() => { touched.length = 0; });

async function refuses(request, field) {
    const res = await dispatch(request);
    assert.strictEqual(res.statusCode, 400, `${request.method} ${request.url} -> ${JSON.stringify(res.body)}`);
    assert.strictEqual(res.body.code, 'invalid_request');
    assert.ok(res.body.details.some((d) => d.path === field),
        `the 400 must name ${field}; it said ${JSON.stringify(res.body.details)}`);
    assert.deepStrictEqual(touched, [], 'a refused request must not reach the store');
    return res;
}

// ═══ POST / — who will see it ════════════════════════════════════════

test('a misspelled scope is refused, not filed as a personal template', async () => {
    await refuses({ method: 'POST', url: '/', body: { scop: 'org', name: 'Board minutes', prompt: 'Summarise.' } }, 'body');
});

test('a group next to scope "org" is refused, not ignored while the template goes org-wide', async () => {
    const res = await refuses({
        method: 'POST', url: '/', body: { scope: 'org', groupId: 'g1', name: 'Board minutes', prompt: 'Summarise.' },
    }, 'body.groupId');
    assert.match(res.body.error, /^groupId only goes with scope "group"/);
});

test('"false" as text is refused, not made everyone\'s default', async () => {
    const res = await refuses({
        method: 'POST', url: '/', body: { scope: 'user', name: 'Mine', prompt: 'p', isDefault: 'false' },
    }, 'body.isDefault');
    assert.strictEqual(res.body.error, 'isDefault is true or false.');
});

test('a scope nobody offers is refused in one sentence, no zod internals', async () => {
    const res = await refuses({ method: 'POST', url: '/', body: { scope: 'team', name: 'x', prompt: 'p' } }, 'body.scope');
    assert.strictEqual(res.body.error, 'scope is "user" (just me), "org" (the whole organisation) or "group".');
});

test('a prompt over the cap is refused rather than cut off mid-sentence', async () => {
    const res = await refuses({ method: 'POST', url: '/', body: { name: 'Long', prompt: 'x'.repeat(20001) } }, 'body.prompt');
    assert.strictEqual(res.body.error, 'A template prompt is at most 20000 characters.');
});

test('a template with no name is refused in words, not with "Required"', async () => {
    const res = await refuses({ method: 'POST', url: '/', body: { prompt: 'p' } }, 'body.name');
    assert.strictEqual(res.body.error, 'A template needs a name.');
});

test('what the template editor sends for a group template still arrives, trimmed', async () => {
    const res = await dispatch({
        method: 'POST', url: '/', body: { scope: 'group', name: '  Sales  ', prompt: ' Summarise. ', groupId: 'g1', isDefault: false },
    });
    assert.strictEqual(res.statusCode, 201);
    const data = touched.find((t) => t.what === 'create').args[0];
    assert.strictEqual(data.scope, 'group');
    assert.strictEqual(data.groupId, 'g1');
    assert.strictEqual(data.name, 'Sales');
    assert.strictEqual(data.prompt, 'Summarise.');
    assert.strictEqual(data.isDefault, false);
});

test('scope may still be left out — that is a personal template, as the API always said', async () => {
    const res = await dispatch({ method: 'POST', url: '/', body: { name: 'Mine', prompt: 'p' } });
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(touched.find((t) => t.what === 'create').args[0].scope, 'user');
});

// ═══ PATCH /:id ══════════════════════════════════════════════════════

test('a misspelled field is refused, not answered 200 with the unchanged row', async () => {
    await refuses({ method: 'PATCH', url: '/own', body: { nmae: 'Renamed' } }, 'body');
});

test('an empty edit is refused', async () => {
    const res = await refuses({ method: 'PATCH', url: '/own', body: {} }, 'body');
    assert.strictEqual(res.body.error, 'Say what to change: name, prompt or isDefault.');
});

test('"false" as text on PATCH is refused too', async () => {
    await refuses({ method: 'PATCH', url: '/own', body: { isDefault: 'false' } }, 'body.isDefault');
});

test('the editor\'s save still updates what it sends', async () => {
    const res = await dispatch({ method: 'PATCH', url: '/own', body: { name: 'Renamed', prompt: 'New', isDefault: true } });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched.find((t) => t.what === 'update').args, ['own', { name: 'Renamed', prompt: 'New', isDefault: true }]);
});
