/**
 * What a KB source route accepts, and what it says when it refuses
 * (routes/knowledgeBases/sources.js).
 *
 * The routes used to normalise a malformed body instead of refusing it:
 * `typeof cfg.url === 'string' ? … : ''` turned a numeric address into a
 * blank one, a config key nobody reads was answered with 201, and a meeting
 * field the source cannot answer was dropped in silence — so a person watched
 * a setting they had typed fail to stick with nothing on screen to explain
 * it. The schemas state the contract now, and what this file pins is the part
 * a caller can act on:
 *
 *   - the 400 NAMES the field (`body.config.url`), not just "invalid request";
 *   - the message is a sentence, including for a field simply left out;
 *   - the store is never reached, so a refused request changes nothing.
 *
 * Run: cd server && node --test --test-force-exit routes/knowledgeBases/sources.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// ── Fixtures ────────────────────────────────────────────────────────
// Every store call lands in `touched`. A refused request must leave it empty.
const touched = [];

const KB = { id: 'kb1', tenant_id: 'owner1', organization_id: 'org1' };
const SOURCE = { id: 's1', knowledgeBaseId: 'kb1', kind: 'webpage', name: 'Docs', config: { url: 'https://example.com' }, refreshMode: 'manual', createdBy: 'u1' };

const pass = (req, res, next) => next();

const MOCKS = {
    '../../stores/knowledgeBases': {
        // Real vocabularies — a schema that validated against an empty
        // fallback here would refuse every status, which is not what the
        // store actually accepts.
        DOC_STATUSES: ['processed', 'redacted', 'skipped', 'error', 'duplicate'],
        PII_STATUSES: ['none', 'found', 'redacted', 'unscanned'],
        getKB: async (id) => { touched.push({ what: 'getKB', args: [id] }); return { ...KB }; },
        countsBySource: async () => ({}),
        listDocuments: async (...a) => { touched.push({ what: 'listDocuments', args: a }); return []; },
        countDocuments: async () => 0,
    },
    '../../stores/kbSources': {
        SOURCE_KINDS: ['upload', 'text', 'webpage', 'nextcloud_folder', 'datatable', 'meeting_tag', 'automation', 'legacy'],
        get: async (id) => { touched.push({ what: 'getSource', args: [id] }); return { ...SOURCE }; },
        listByKb: async () => [],
        create: async (p) => { touched.push({ what: 'create', args: [p] }); return { ...SOURCE, ...p, id: 's9' }; },
        update: async (id, patch) => { touched.push({ what: 'update', args: [id, patch] }); return { ...SOURCE, ...patch }; },
    },
    '../../stores/userStore': { getUser: async (id) => ({ id, name: 'Tom' }) },
    '../../auth': { requireAuth: pass, requirePermission: () => pass },
    './shared': {
        getUserId: (req) => req.session?.user?.id || null,
        canAccessKB: async () => true,
        canManageKB: async () => true,
        blockIfSystemKB: () => false,
        guardedFetch: async () => { throw new Error('the network is not part of this test'); },
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:kb-sources-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /knowledgeBases[\\/]sources\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./sources');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../../core/http/terminalErrorHandler');

function dispatch({ method, url, body = {}, session = { user: { id: 'u1' } } }) {
    const [pathname, search = ''] = String(url).split('?');
    const query = {};
    for (const [k, v] of new URLSearchParams(search)) query[k] = v;
    return new Promise((resolve, reject) => {
        const req = { method, url, originalUrl: url, path: pathname, body, query, headers: {}, session, get() { return undefined; } };
        const res = {
            statusCode: 200,
            headersSent: false,
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

// ═══ POST /:id/sources ══════════════════════════════════════════════

test('a source with no kind is refused in words, not with "Required"', async () => {
    const res = await dispatch({ method: 'POST', url: '/kb1/sources', body: {} });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'A source needs a kind — one of: text, upload, webpage, meeting_tag, datatable.',
        'the caller reads this sentence');
    assert.ok(res.body.details.some((d) => d.path === 'body.kind'));
    assert.deepStrictEqual(touched, []);
});

test('a key the route does not read is refused rather than answered with 201', async () => {
    // Silently ignoring it is how a source created without the schedule
    // somebody typed looks like a success to the person who typed it.
    await refuses({ method: 'POST', url: '/kb1/sources', body: { kind: 'upload', refreshMode: 'schedule' } }, 'body');
});

test('a config key the kind does not have is refused, and named under config', async () => {
    await refuses({ method: 'POST', url: '/kb1/sources', body: { kind: 'webpage', config: { url: 'https://x.test', crawlPages: 9 } } },
        'body.config');
});

test('a numeric web address is refused by name instead of becoming a blank one', async () => {
    // `typeof cfg.url === 'string' ? … : ''` made this a 400 saying the url
    // was missing — for a request that had one.
    await refuses({ method: 'POST', url: '/kb1/sources', body: { kind: 'webpage', config: { url: 42 } } }, 'body.config.url');
});

test('a text source needs text, and the same sentence answers absent and blank', async () => {
    const missing = await dispatch({ method: 'POST', url: '/kb1/sources', body: { kind: 'text', config: {} } });
    const blank = await dispatch({ method: 'POST', url: '/kb1/sources', body: { kind: 'text', config: { text: ' ' } } });
    for (const res of [missing, blank]) {
        assert.strictEqual(res.statusCode, 400);
        assert.strictEqual(res.body.error, 'A text source needs at least three characters of text.');
        assert.ok(res.body.details.some((d) => d.path === 'body.config.text'));
    }
    assert.deepStrictEqual(touched, []);
});

test('a meeting field this source cannot answer is refused, and the entry is named by index', async () => {
    await refuses({ method: 'POST', url: '/kb1/sources', body: { kind: 'meeting_tag', config: { tag: 'sales', fields: ['summary', 'transcript'] } } },
        'body.config.fields.1');
});

test('a refresh rule that is not an object is refused by name', async () => {
    await refuses({ method: 'POST', url: '/kb1/sources', body: { kind: 'upload', refresh: 'daily' } }, 'body.refresh');
});

test('a cron that is not a cron is refused before anything is created', async () => {
    const res = await dispatch({ method: 'POST', url: '/kb1/sources', body: { kind: 'webpage', config: { url: 'https://x.test' }, refresh: { cron: 'daily' } } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'A refresh schedule is a cron expression of 5 or 6 fields, like "0 7 * * *".');
    assert.ok(res.body.details.some((d) => d.path === 'body.refresh.cron'));
    assert.deepStrictEqual(touched, []);
});

test('an unknown time zone is named in the refusal', async () => {
    const res = await dispatch({ method: 'POST', url: '/kb1/sources', body: { kind: 'upload', refresh: { tz: 'Mars/Olympus' } } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'Unknown time zone: Mars/Olympus');
    assert.deepStrictEqual(touched, []);
});

test('a kind the product cannot create yet keeps its own answer, with the list a client may offer', async () => {
    // Not a malformed request: the Studio draws every kind and reads this
    // code to disable the button it cannot use yet.
    const res = await dispatch({ method: 'POST', url: '/kb1/sources', body: { kind: 'telepathy' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'kind_not_available');
    assert.deepStrictEqual(res.body.availableKinds, ['text', 'upload', 'webpage', 'meeting_tag', 'datatable']);
});

test('a name the schema accepts reaches the store trimmed, and the source is created', async () => {
    const res = await dispatch({ method: 'POST', url: '/kb1/sources', body: { kind: 'upload', name: '  Files  ' } });
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(touched.find((t) => t.what === 'create').args[0].name, 'Files');
});

// ═══ PATCH /:id/sources/:sid ════════════════════════════════════════

test('a blank rename is refused rather than stored as an empty name', async () => {
    await refuses({ method: 'PATCH', url: '/kb1/sources/s1', body: { name: '   ' } }, 'body.name');
});

test('a numeric title is refused instead of reaching the store as a number', async () => {
    await refuses({ method: 'PATCH', url: '/kb1/sources/s1', body: { name: 42 } }, 'body.name');
});

test('a patch key the route does not read is refused rather than answered with 200', async () => {
    await refuses({ method: 'PATCH', url: '/kb1/sources/s1', body: { kind: 'text' } }, 'body');
});

test('a rename is trimmed by the schema, and only the name is patched', async () => {
    const res = await dispatch({ method: 'PATCH', url: '/kb1/sources/s1', body: { name: '  Contracts  ' } });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched.find((t) => t.what === 'update').args[1], { name: 'Contracts' });
});

// ═══ GET /:id/sources/:sid/documents ════════════════════════════════

test('a page size out of range is clamped, because a bad page is still a page', async () => {
    const res = await dispatch({ method: 'GET', url: '/kb1/sources/s1/documents?limit=9999&offset=-4' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.limit, 200);
    assert.strictEqual(res.body.offset, 0);
});

test('a query key the route does not read is refused rather than silently ignored', async () => {
    await refuses({ method: 'GET', url: '/kb1/sources/s1/documents?sort=name' }, 'query');
});

test('an unknown status is refused instead of silently matching every document', async () => {
    // The store drops any status it does not recognise from its filter list;
    // with none left, it adds no status clause at all, so `?status=eror`
    // used to come back with the WHOLE source's documents under a 200.
    await refuses({ method: 'GET', url: '/kb1/sources/s1/documents?status=eror' }, 'query.status');
});

test('a real, comma-separated status list is accepted', async () => {
    const res = await dispatch({ method: 'GET', url: '/kb1/sources/s1/documents?status=error,duplicate' });
    assert.strictEqual(res.statusCode, 200);
});

test('an unknown pii value is refused the same way', async () => {
    await refuses({ method: 'GET', url: '/kb1/sources/s1/documents?pii=nope' }, 'query.pii');
});
