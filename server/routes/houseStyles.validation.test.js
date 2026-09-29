/**
 * What the house-style routes accept, and what they say when they refuse
 * (routes/houseStyles.js).
 *
 * PATCH read four keys and dropped the rest, so a mistake was a 200 with the
 * style unchanged — or changed into something else: `isDefault: "false"` MADE
 * the style the organisation's default, `name: null` renamed it "null",
 * `reExtract: "true"` re-extracted nothing. The multipart upload read
 * `isDefault === 'true'`, so a checkbox's "on" meant no. What this file pins:
 *
 *   - the 400 names the field, in a sentence;
 *   - what the Android app sends (`{ isDefault: true }`) still works;
 *   - a refused request never reaches the store.
 *
 * Run: cd server && node --test routes/houseStyles.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every store write lands in `touched`. A refused request must leave it empty.
const touched = [];
const pass = (req, res, next) => next();

const MOCKS = {
    '../stores/houseStyleStore': {
        getById: async (id) => ({ id, name: 'Brand', docxBlob: Buffer.from('docx') }),
        update: async (id, orgId, updates) => { touched.push({ what: 'update', args: [id, orgId, updates] }); return { id, ...updates }; },
        create: async (row) => { touched.push({ what: 'create', args: [row] }); return { id: 'hs1', ...row }; },
        listForOrg: async () => [],
        getDefaultForOrg: async () => null,
        remove: async () => {},
    },
    '../core/text/houseStyleExtractor': { extract: async () => ({ fonts: [] }) },
    '../stores/userStore': {},
    '../auth': { resolveUserOrgIds: async () => new Set(['org1']) },
    '../auth/permissions': { requireAuth: pass, isOrgAdminForOrg: async () => true },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:house-styles-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /routes[\\/]houseStyles\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./houseStyles');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../core/http/terminalErrorHandler');

// `file` stands in for what multer leaves behind: the request carries no
// multipart content type, so multer passes it through untouched.
function dispatch({ method, url, body, file }) {
    return new Promise((resolve, reject) => {
        const req = {
            method, url, originalUrl: url, path: url, body, file, query: {}, headers: {},
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

const patch = (body) => dispatch({ method: 'PATCH', url: '/org1/hs1', body });
const DOCX = { originalname: 'Brand.docx', buffer: Buffer.from('docx') };

test.beforeEach(() => { touched.length = 0; });

// ── PATCH ───────────────────────────────────────────────────────────

test('isDefault "false" is refused, instead of making the style the default', async () => {
    const res = await patch({ isDefault: 'false' });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'isDefault is true or false.');
    assert.ok(res.body.details.some((d) => d.path === 'body.isDefault'));
    assert.deepStrictEqual(touched, [], 'the default did not move');
});

test('a null or blank name is refused, instead of renaming the style "null"', async () => {
    for (const name of [null, '   ']) {
        const res = await patch({ name });
        assert.strictEqual(res.statusCode, 400, JSON.stringify(name));
        assert.strictEqual(res.body.error, 'A house style needs a name.');
    }
    assert.deepStrictEqual(touched, []);
});

test('reExtract "true" is refused, instead of re-extracting nothing', async () => {
    const res = await patch({ reExtract: 'true' });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'reExtract is true or false.');
    assert.deepStrictEqual(touched, []);
});

test('a misspelled key is refused by name, instead of answering with the unchanged row', async () => {
    const res = await patch({ isdefault: true });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(/isdefault/.test(res.body.error), `the 400 names the key: ${res.body.error}`);
    assert.deepStrictEqual(touched, []);
});

test('what the Android app sends still makes a style the default', async () => {
    const res = await patch({ isDefault: true });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched, [{ what: 'update', args: ['hs1', 'org1', { isDefault: true }] }]);
});

test('a null description clears it, instead of saving the word "null"', async () => {
    const res = await patch({ description: null, name: '  Brand 2 ' });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched[0].args[2], { name: 'Brand 2', description: '' });
});

test('a PATCH without a body is a no-op, not a 500', async () => {
    const res = await patch(undefined);
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched, [{ what: 'update', args: ['hs1', 'org1', {}] }]);
});

// ── upload (multipart) ──────────────────────────────────────────────

test('a checkbox "on" for isDefault is refused, instead of meaning no', async () => {
    const res = await dispatch({ method: 'POST', url: '/org1', body: { isDefault: 'on' }, file: DOCX });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, "isDefault is 'true' or 'false'.");
    assert.deepStrictEqual(touched, []);
});

test('a misspelled upload field is refused by name', async () => {
    const res = await dispatch({ method: 'POST', url: '/org1', body: { nmae: 'Brand' }, file: DOCX });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(/nmae/.test(res.body.error), res.body.error);
    assert.deepStrictEqual(touched, []);
});

test('an upload still names itself after the file, and "true" still makes it the default', async () => {
    const res = await dispatch({ method: 'POST', url: '/org1', body: { isDefault: 'true' }, file: DOCX });
    assert.strictEqual(res.statusCode, 201);
    const row = touched.find((t) => t.what === 'create').args[0];
    assert.strictEqual(row.name, 'Brand');
    assert.strictEqual(row.makeDefault, true);
});
