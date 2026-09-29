'use strict';

/**
 * What the routine CRUD routes accept, and what they say when they refuse
 * (routes/automation/crud.js).
 *
 * The checks these schemas replaced answered "Title is required" to a routine
 * titled `42` — the title was there, it just was not text — and let a key the
 * router does not read through with a 200, so a person watched a setting they
 * had typed fail to stick with nothing on screen to explain it. What this
 * file pins is the part a caller can act on:
 *
 *   - the 400 NAMES the field (`body.title`), not just "invalid request";
 *   - the message is a sentence, including for a field simply left out;
 *   - the store is never reached, so a refused request changes nothing.
 *
 * `definition` deliberately stays an open object: the flow graph has its own
 * validator, which reads every node and answers with findings.
 *
 * Route stack invoked directly — same technique as crud.triggerProvider.test.js.
 *
 * Run: cd server && node --test --test-force-exit routes/automation/crud.validation.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const Module = require('module');

const SERVER = path.resolve(__dirname, '..', '..');
function mock(absId, exports) {
    const p = require.resolve(absId);
    const m = new Module(p);
    m.exports = exports;
    m.loaded = true;
    require.cache[p] = m;
}

// Every store call lands in `touched`. A refused request must leave it empty.
const touched = [];
const note = (what) => (...args) => { touched.push({ what, args }); return null; };

const ROUTINE = { id: 'a1', userId: 'u1', organizationId: 'org1', title: 'Weekly', definition: { trigger: { id: 't', kind: 'manual' }, steps: [] } };

mock(path.join(SERVER, 'stores/automationStore'), {
    getAutomationsForUser: async () => [],
    getAutomation: async (id) => { touched.push({ what: 'getAutomation', args: [id] }); return { ...ROUTINE }; },
    createAutomation: async (p) => { touched.push({ what: 'createAutomation', args: [p] }); return { ...ROUTINE, ...p }; },
    updateAutomation: async (id, patch) => { touched.push({ what: 'updateAutomation', args: [id, patch] }); return { ...ROUTINE, ...patch }; },
    listFolders: async () => [],
    getFolder: note('getFolder'),
    ensureFormPage: async () => ({ id: 'page1' }),
    setFormPageAudience: async (...a) => { touched.push({ what: 'setFormPageAudience', args: a }); return { audience: 'org' }; },
});
mock(path.join(SERVER, 'automation/cron'), { nextRunAt: () => new Date(Date.now() + 3600e3).toISOString() });
mock(path.join(SERVER, 'automation/validate'), { validateDefinition: () => ({ ok: true, warnings: [] }) });
mock(path.join(SERVER, 'automation/summarise'), { summariseDefinition: () => ({ summary: '' }) });
mock(path.join(SERVER, 'automation/deliverableEvents'), { getDeliverableEvents: () => [] });
mock(path.join(SERVER, 'automation/toolRegistry'), { TOOL_REGISTRY: [], loadTools: () => [] });
mock(path.join(SERVER, 'automation/triggerBus'), { getPublicBaseUrl: () => null, dispatchEvent: async () => [] });
mock(path.join(SERVER, 'utils/perUserRateLimit'), { perUserRateLimit: () => (req, res, next) => next() });
mock(path.join(SERVER, 'auth/datatableAccess'), { resolveDatatablePrincipal: async () => ({ orgId: 'org1' }) });
// The post-save bookkeeping wants a database; nothing here is about it.
mock(path.join(SERVER, 'automation/datatableUsageSync'), { syncDatatableUsage: async () => {}, purgeDatatableUsage: async () => {} });
mock(path.join(SERVER, 'core/kb/kbSourceSync'), { syncKbSources: async () => {} });
mock(path.join(SERVER, 'automation/formAnswers'), { collectEnabled: () => false, ensureAnswersTable: async () => ({ answers: null, usage: [] }), releaseAnswersTables: async () => {} });

const router = require('./crud');
const { terminalErrorHandler } = require(path.join(SERVER, 'core/http/terminalErrorHandler'));

function dispatch({ method, url, body = {} }) {
    return new Promise((resolve, reject) => {
        const [pathname, search = ''] = String(url).split('?');
        const query = {};
        for (const [k, v] of new URLSearchParams(search)) query[k] = v;
        const req = {
            method, url, originalUrl: url, path: pathname, query, body, headers: {},
            session: { isAuthenticated: true, user: { id: 'u1' } },
            get() { return undefined; }, setTimeout() {},
        };
        const res = {
            statusCode: 200, body: undefined, headersSent: false,
            set() { return this; }, setHeader() {}, setTimeout() {},
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            send(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            end() { this.headersSent = true; resolve(this); return this; },
        };
        router(req, res, (err) => {
            if (!err) return reject(new Error(`fell through: ${method} ${url}`));
            // A schema refusal reaches the client as an error, so the harness
            // answers it the way index.js does.
            terminalErrorHandler(err, req, res, (e) => reject(e));
        });
    });
}

test.beforeEach(() => { touched.length = 0; });

/** Assert: refused with 400, the named field is in `details`, nothing touched. */
async function refuses(request, field) {
    const res = await dispatch(request);
    const what = `${request.method} ${request.url} ${JSON.stringify(request.body)}`;
    assert.strictEqual(res.statusCode, 400, what);
    assert.strictEqual(res.body.code, 'invalid_request', what);
    assert.ok(res.body.details.some((d) => d.path === field),
        `the 400 must name ${field}; it said ${JSON.stringify(res.body.details)}`);
    assert.deepStrictEqual(touched, [], 'a refused request must not reach the store');
}

// ═══ GET / ══════════════════════════════════════════════════════════

test('an event without a provider is refused, not answered with the whole list', async () => {
    // It narrows nothing on its own, and the answer to a narrowing parameter
    // that narrows nothing used to be every routine the caller owns — which
    // is the failure the provider check exists to prevent, arriving through
    // the other half of the filter.
    const res = await dispatch({ method: 'GET', url: '/?triggerEvent=meeting.processed' });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.details.some((d) => d.path === 'query.triggerEvent'));
    assert.strictEqual(res.body.error, 'triggerEvent only means something together with triggerProvider.');
});

test('a query key the route does not read is refused rather than silently ignored', async () => {
    await refuses({ method: 'GET', url: '/?triggerProvder=meeting-notes' }, 'query');
});

// ═══ POST / ═════════════════════════════════════════════════════════

test('a routine with no title is refused in words, not with "Required"', async () => {
    const res = await dispatch({ method: 'POST', url: '/', body: { definition: {} } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'A routine needs a title.', 'the caller reads this sentence');
    assert.ok(res.body.details.some((d) => d.path === 'body.title'));
    assert.deepStrictEqual(touched, []);
});

test('a numeric title is refused by name instead of reaching the store as a number', async () => {
    await refuses({ method: 'POST', url: '/', body: { title: 42, definition: {} } }, 'body.title');
});

test('a routine with no definition is refused in words', async () => {
    const res = await dispatch({ method: 'POST', url: '/', body: { title: 'Weekly' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'A routine needs a definition — the flow itself.');
    assert.ok(res.body.details.some((d) => d.path === 'body.definition'));
});

test('a key the route does not read is refused rather than answered with 200', async () => {
    await refuses({ method: 'POST', url: '/', body: { title: 'Weekly', definition: {}, isActive: true } }, 'body');
});

test('the create defaults live in the schema: manual, Amsterdam, no schedule', async () => {
    const res = await dispatch({ method: 'POST', url: '/', body: { title: '  Weekly  ', definition: { steps: [] } } });
    assert.strictEqual(res.statusCode, 200);
    const created = touched.find((t) => t.what === 'createAutomation').args[0];
    assert.strictEqual(created.title, 'Weekly', 'trimmed once, by the schema');
    assert.strictEqual(created.triggerType, 'manual');
    assert.strictEqual(created.scheduleTz, 'Europe/Amsterdam');
    assert.strictEqual(created.scheduleCron, null);
});

// ═══ PUT /:id ═══════════════════════════════════════════════════════

test('a misspelled key is refused rather than unsetting nothing with a 200', async () => {
    // `folderID` is not `folderId`: the routine stayed where it was and the
    // person was told the move had worked.
    await refuses({ method: 'PUT', url: '/a1', body: { folderID: 'f1' } }, 'body');
});

test('isDraft as the string "false" is refused, rather than read as true', async () => {
    await refuses({ method: 'PUT', url: '/a1', body: { isDraft: 'false' } }, 'body.isDraft');
});

test('a blank rename is refused rather than stored as an empty title', async () => {
    await refuses({ method: 'PUT', url: '/a1', body: { title: '   ' } }, 'body.title');
});

test('null unfiles a routine; the schema keeps that apart from leaving folderId out', async () => {
    const cleared = await dispatch({ method: 'PUT', url: '/a1', body: { folderId: null } });
    assert.strictEqual(cleared.statusCode, 200);
    assert.strictEqual(touched.find((t) => t.what === 'updateAutomation').args[1].folderId, null);

    touched.length = 0;
    const untouched = await dispatch({ method: 'PUT', url: '/a1', body: { title: 'Weekly' } });
    assert.strictEqual(untouched.statusCode, 200);
    assert.ok(!('folderId' in touched.find((t) => t.what === 'updateAutomation').args[1]),
        'a rename must not unfile the routine');
});

// ═══ PUT /forms/:automationId/audience ══════════════════════════════

test('an audience nobody implements is refused by name, before any page is touched', async () => {
    const res = await dispatch({ method: 'PUT', url: '/forms/a1/audience', body: { audience: 'everyone' } });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.details.some((d) => d.path === 'body.audience'));
    assert.deepStrictEqual(touched, []);
});

test('a group list that is not a list is refused by name', async () => {
    await refuses({ method: 'PUT', url: '/forms/a1/audience', body: { audience: 'restricted', sharedGroups: 'g-fin' } },
        'body.sharedGroups');
});

test('a blank entry in the people list is named by index', async () => {
    await refuses({ method: 'PUT', url: '/forms/a1/audience', body: { audience: 'restricted', sharedUserIds: ['pat', ''] } },
        'body.sharedUserIds.1');
});
