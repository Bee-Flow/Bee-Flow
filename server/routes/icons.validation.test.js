/**
 * What the icon-pack routes accept, and what they say when they refuse
 * (routes/icons.js).
 *
 * `{ "overwrite": "false" }` regenerated every icon in a pack, `only: []`
 * generated the whole catalogue, a half-sent icon cleared the person's
 * override, and `{ "icons": null }` wiped a pack, each under a 200. What this
 * file pins is the part a caller can act on:
 *
 *   - the 400 NAMES the field (`body.overwrite`), not just "invalid request";
 *   - the message is a sentence, including for a field simply left out;
 *   - nothing is generated or stored, so a refused request costs nothing.
 *
 * /upload is multipart and is covered by icons.upload.test.js.
 *
 * Run: cd server && node --test routes/icons.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

const { ALL_EMOJI_IDS } = require('../core/cms/emojiCatalog');

// Every store write or generation lands in `touched`. A refused request must leave it empty.
const touched = [];
const pass = (req, res, next) => next();

// A pack with every catalogue icon set except the first two.
const FULL_BUT_TWO = Object.fromEntries(ALL_EMOJI_IDS.slice(2).map((id) => [id, { type: 'emoji', value: '⭐' }]));
const PACK = { id: 'p1', user_id: 'u1', name: 'Mine', icons: FULL_BUT_TWO };

const MOCKS = {
    '../telemetry/log': { info() {}, warn() {}, error() {}, debug() {} },
    '../auth/permissions': { requireAuth: pass },
    '../middleware/uploadGuard': { uploadGuard: () => pass },
    '../stores/iconStore': {
        getIconPack: async (id) => (id === PACK.id ? { ...PACK, icons: { ...PACK.icons } } : null),
        createIconPack: async (userId, name, icons) => { touched.push({ what: 'create', args: [name, icons] }); return { id: 'p2', name, icons }; },
        updateIconPack: async (id, userId, updates) => { touched.push({ what: 'update', args: [id, updates] }); return true; },
        setIcon: async (id, userId, key, data) => { touched.push({ what: 'setIcon', args: [key, data] }); return {}; },
    },
    '../stores/userStore': { getUser: async () => ({ id: 'u1' }), updateUser: async () => {} },
    '../stores/configStore': { getSecret: async () => 'google-key' },
    '../core/providers': {
        // No image comes back, so nothing is ever written to the icon folder.
        googleAdapter: { generateImage: async (key, prompt, opts) => { touched.push({ what: 'generate', args: [opts] }); return {}; } },
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:icons-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /routes[\\/]icons\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./icons');
test.after(() => { Module._resolveFilename = originalResolve; });

const { terminalErrorHandler } = require('../core/http/terminalErrorHandler');

function dispatch({ method, url, body, userId = 'u1' }) {
    return new Promise((resolve, reject) => {
        const req = {
            method, url, originalUrl: url, path: url, body, query: {}, headers: {},
            session: { user: { id: userId } }, get() { return undefined; },
        };
        const res = {
            statusCode: 200, headersSent: false,
            set() { return this; }, setHeader() {},
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

const refusedAt = (res, path) => res.statusCode === 400 && res.body.details.some((d) => d.path === path);
const calls = (what) => touched.filter((t) => t.what === what);

test.beforeEach(() => { touched.length = 0; });

// ── bulk-generate ───────────────────────────────────────────────────

test('overwrite "false" is refused instead of regenerating every icon in the pack', async () => {
    const res = await dispatch({ method: 'POST', url: '/p1/bulk-generate', body: { overwrite: 'false' } });
    assert.ok(refusedAt(res, 'body.overwrite'));
    assert.strictEqual(res.body.error, 'overwrite is true or false.');
    assert.deepStrictEqual(calls('generate'), []);
});

test('an empty or non-list `only` is refused instead of generating the whole catalogue', async () => {
    for (const only of [[], 'tools.search']) {
        const res = await dispatch({ method: 'POST', url: '/p1/bulk-generate', body: { only } });
        assert.ok(refusedAt(res, 'body.only'), JSON.stringify(only));
    }
    assert.deepStrictEqual(calls('generate'), []);
});

test('the editor\'s own request fills only the missing icons, and no body means the same', async () => {
    const res = await dispatch({
        method: 'POST', url: '/p1/bulk-generate',
        body: { style: '', model: 'gemini-3.1-flash-image-preview', overwrite: false },
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(calls('generate').length, 2, 'the two icons the pack does not have');

    touched.length = 0;
    await dispatch({ method: 'POST', url: '/p1/bulk-generate', body: undefined });
    assert.strictEqual(calls('generate').length, 2);
});

test('`only` with overwrite regenerates exactly what it names', async () => {
    const key = ALL_EMOJI_IDS[5];
    const res = await dispatch({ method: 'POST', url: '/p1/bulk-generate', body: { only: [key], overwrite: true } });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(calls('generate').length, 1);
});

test('`only` cannot ask for more generations than the catalogue has', async () => {
    const oversized = Array(200).fill(ALL_EMOJI_IDS[0]);
    const res = await dispatch({ method: 'POST', url: '/p1/bulk-generate', body: { overwrite: true, only: oversized } });
    assert.ok(refusedAt(res, 'body.only'), JSON.stringify({ status: res.statusCode, body: res.body }));
    assert.deepStrictEqual(calls('generate'), [], 'a refused request must not have generated anything');
});

test('`only` deduplicates repeated ids instead of generating the same icon repeatedly', async () => {
    const key = ALL_EMOJI_IDS[6];
    const res = await dispatch({ method: 'POST', url: '/p1/bulk-generate', body: { only: [key, key, key], overwrite: true } });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(calls('generate').length, 1, 'three copies of the same id must cost one generation, not three');
});

test('a model that is not a Gemini image model never reaches Google', async () => {
    const res = await dispatch({ method: 'POST', url: '/p1/bulk-generate', body: { model: 'gemini-3-pro-preview' } });
    assert.ok(refusedAt(res, 'body.model'));
    assert.deepStrictEqual(calls('generate'), []);
});

// ── generate ────────────────────────────────────────────────────────

test('the picker\'s generate request reaches the image model', async () => {
    const res = await dispatch({
        method: 'POST', url: '/generate',
        body: { prompt: 'a bee', model: 'gemini-3-pro-image-preview', aspectRatio: '1:1' },
    });
    assert.strictEqual(res.statusCode, 502, 'the stub returns no image');
    assert.deepStrictEqual(calls('generate')[0].args[0], { aspectRatio: '1:1', model: 'gemini-3-pro-image-preview' });
});

test('generate without a prompt is refused in words', async () => {
    const res = await dispatch({ method: 'POST', url: '/generate', body: { prompt: '  ' } });
    assert.ok(refusedAt(res, 'body.prompt'));
    assert.strictEqual(res.body.error, 'Describe the icon to generate.');
});

test('an aspect ratio that is not one is refused before Google answers 500', async () => {
    const res = await dispatch({ method: 'POST', url: '/generate', body: { prompt: 'a bee', aspectRatio: 'square' } });
    assert.ok(refusedAt(res, 'body.aspectRatio'));
    assert.deepStrictEqual(calls('generate'), []);
});

// ── rate limiting ────────────────────────────────────────────────────
//
// Own `userId` so this burst never shares a budget with the calls the tests
// above already spent from 'u1' — and never lends its own leftover budget to
// a test that runs after it.

test('generate is rate-limited per user, not left to run unbounded on the install\'s Google key', async () => {
    const userId = 'rate-limit-probe-generate';
    let limited = false;
    let seen = 0;
    for (let i = 0; i < 30 && !limited; i++) {
        const res = await dispatch({ method: 'POST', url: '/generate', body: { prompt: 'a bee' }, userId });
        seen++;
        if (res.statusCode === 429) limited = true;
    }
    assert.ok(limited, `expected a 429 within 30 requests from one user, never saw one (${seen} requests, all under the limit)`);
});

test('bulk-generate is rate-limited per user — a bulk run is one request against the budget', async () => {
    const userId = 'rate-limit-probe-bulk';
    let limited = false;
    let seen = 0;
    for (let i = 0; i < 30 && !limited; i++) {
        const res = await dispatch({ method: 'POST', url: '/p1/bulk-generate', body: {}, userId });
        seen++;
        if (res.statusCode === 429) limited = true;
    }
    assert.ok(limited, `expected a 429 within 30 requests from one user, never saw one (${seen} requests, all under the limit)`);
});

// ── PATCH one icon ──────────────────────────────────────────────────

test('a misspelled value key is refused, not taken as "clear this icon"', async () => {
    const res = await dispatch({ method: 'PATCH', url: '/p1/icons/tools.search', body: { type: 'emoji', valeu: '🌟' } });
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /valeu/);
    assert.deepStrictEqual(calls('setIcon'), []);
});

test('half an icon is refused in words', async () => {
    const res = await dispatch({ method: 'PATCH', url: '/p1/icons/tools.search', body: { type: 'emoji' } });
    assert.ok(refusedAt(res, 'body.value'));
    assert.strictEqual(res.body.error, 'Send both type and value to set an icon, or neither to clear it.');
    assert.deepStrictEqual(calls('setIcon'), []);
});

test('an empty body still clears the icon, as the editor sends it', async () => {
    const res = await dispatch({ method: 'PATCH', url: '/p1/icons/tools.search', body: {} });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(calls('setIcon')[0].args, ['tools.search', null]);
});

test('an emoji and an uploaded image are set as sent', async () => {
    await dispatch({ method: 'PATCH', url: '/p1/icons/tools.search', body: { type: 'emoji', value: '🐝' } });
    await dispatch({ method: 'PATCH', url: '/p1/icons/integration.google_drive', body: { type: 'image', value: '/api/icons/data/icon-1-ab.png' } });
    assert.deepStrictEqual(calls('setIcon').map((c) => c.args), [
        ['tools.search', { type: 'emoji', value: '🐝' }],
        ['integration.google_drive', { type: 'image', value: '/api/icons/data/icon-1-ab.png' }],
    ]);
});

test('an image that points elsewhere is refused', async () => {
    const res = await dispatch({ method: 'PATCH', url: '/p1/icons/tools.search', body: { type: 'image', value: 'https://tracker.example/p.png' } });
    assert.ok(refusedAt(res, 'body.value'));
    assert.deepStrictEqual(calls('setIcon'), []);
});

test('an unknown icon type is refused in words, not stored', async () => {
    const res = await dispatch({ method: 'PATCH', url: '/p1/icons/tools.search', body: { type: 'imgae', value: 'x' } });
    assert.ok(refusedAt(res, 'body.type'));
    assert.strictEqual(res.body.error, "An icon's type is 'emoji' or 'image'.");
});

test('an icon key that is not a key is refused by name', async () => {
    const res = await dispatch({ method: 'PATCH', url: '/p1/icons/tools%20search', body: {} });
    assert.ok(refusedAt(res, 'params.key'));
});

// ── Pack CRUD and import ────────────────────────────────────────────

test('icons: null is refused instead of wiping the pack', async () => {
    const res = await dispatch({ method: 'PUT', url: '/p1', body: { icons: null } });
    assert.ok(refusedAt(res, 'body.icons'));
    assert.deepStrictEqual(calls('update'), []);
});

test('"remove all" from the editor still empties the pack', async () => {
    const res = await dispatch({ method: 'PUT', url: '/p1', body: { icons: {} } });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(calls('update')[0].args, ['p1', { icons: {} }]);
});

test('a misspelled update key is refused rather than a 200 that changed nothing', async () => {
    const res = await dispatch({ method: 'PUT', url: '/p1', body: { nmae: 'Renamed' } });
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(calls('update'), []);
});

test('a new pack from the editor is created with a trimmed name', async () => {
    const res = await dispatch({ method: 'POST', url: '/', body: { name: '  Mine  ', icons: {} } });
    assert.strictEqual(res.statusCode, 201);
    assert.deepStrictEqual(calls('create')[0].args, ['Mine', {}]);
});

test('a pack with no name is refused in words, not with "Required"', async () => {
    const res = await dispatch({ method: 'POST', url: '/', body: {} });
    assert.ok(refusedAt(res, 'body.name'));
    assert.strictEqual(res.body.error, 'A pack needs a name.');
});

test('an exported pack imports as it was written', async () => {
    const res = await dispatch({
        method: 'POST', url: '/import',
        body: {
            kind: 'beeflow.iconpack', version: 1, name: 'Mine', exportedAt: '2026-09-23T08:00:00.000Z',
            icons: { 'tools.search': { type: 'emoji', value: '🔍' } },
        },
    });
    assert.strictEqual(res.statusCode, 201);
    assert.deepStrictEqual(calls('create')[0].args, ['Mine', { 'tools.search': { type: 'emoji', value: '🔍' } }]);
});

test('a file that is not an icon pack, or from a newer format, is refused', async () => {
    for (const extra of [{ kind: 'beeflow.app' }, { version: 2 }]) {
        const res = await dispatch({ method: 'POST', url: '/import', body: { ...extra, icons: {} } });
        assert.strictEqual(res.statusCode, 400, JSON.stringify(extra));
    }
    assert.deepStrictEqual(calls('create'), []);
});

test('an imported name is cut to size rather than refused, and a missing one is named', async () => {
    await dispatch({ method: 'POST', url: '/import', body: { name: 'x'.repeat(150), icons: {} } });
    await dispatch({ method: 'POST', url: '/import', body: { icons: {} } });
    assert.deepStrictEqual(calls('create').map((c) => c.args[0]), ['x'.repeat(100), 'Imported Pack']);
});

test('activate takes no body', async () => {
    const res = await dispatch({ method: 'POST', url: '/p1/activate', body: { packId: 'p2' } });
    assert.strictEqual(res.statusCode, 400);
});
