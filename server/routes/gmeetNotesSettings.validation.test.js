/**
 * What the Google Meet → Meeting Notes settings saves accept, and what they
 * say when they refuse (routes/gmeetNotesSettings.js).
 *
 * Every field on this document decides whether somebody's meetings are
 * imported or RECORDED, and the core's coercion turned each wrong value into a
 * different setting under "Saved": `autoRecordConfig: "false"` is a truthy
 * string, so it pre-enabled auto-recording; a misspelled key was dropped and
 * the real field written as its default; `importScope: "calender"` quietly
 * became 'organizer'. What this file pins:
 *
 *   - the 400 names the field, in a sentence — the enum one included;
 *   - the document the settings screens send back (their own GET) still saves;
 *   - `null` is still "no opinion" on the org document;
 *   - a refused request never reaches the store.
 *
 * Run: cd server && node --test routes/gmeetNotesSettings.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every save lands in `touched`. A refused request must leave it empty.
const touched = [];
const pass = (req, res, next) => next();

const MOCKS = {
    '../auth': { resolveUserOrgIds: async () => new Set(['org1']) },
    '../auth/permissions': { requireAuth: pass, isOrgAdminForOrg: async () => true },
    '../core/meetingNotes/gmeetNotesSettings': {
        getUserSettings: async () => ({}),
        getOrgSettings: async () => ({}),
        deriveConnectionStatus: () => ({}),
        saveUserSettings: async (userId, patch) => { touched.push({ what: 'saveUserSettings', args: [userId, patch] }); return patch; },
        saveOrgSettings: async (orgId, patch, by) => { touched.push({ what: 'saveOrgSettings', args: [orgId, patch, by] }); return patch; },
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:gmeet-notes-settings-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /routes[\\/]gmeetNotesSettings\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./gmeetNotesSettings');
test.after(() => { Module._resolveFilename = originalResolve; });

const { dispatcher } = require('../core/http/routeHarness');

const dispatch = dispatcher(router);

test.beforeEach(() => { touched.length = 0; });

test('"false" as a string is refused, instead of switching auto-recording ON', async () => {
    const res = await dispatch({ method: 'PUT', url: '/user/me', body: { autoRecordConfig: 'false' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'autoRecordConfig is true, false, or null for no opinion.');
    assert.ok(res.body.details.some((d) => d.path === 'body.autoRecordConfig'));
    assert.deepStrictEqual(touched, [], 'nothing was saved');
});

test('the same refusal holds on the organisation document', async () => {
    const res = await dispatch({ method: 'PUT', url: '/org1', body: { autoImport: 'false' } });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.details.some((d) => d.path === 'body.autoImport'));
    assert.deepStrictEqual(touched, []);
});

test('a misspelled key is refused by name, instead of resetting the real field', async () => {
    const res = await dispatch({ method: 'PUT', url: '/user/me', body: { autoimport: true } });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(/autoimport/.test(res.body.error), `the 400 names the key: ${res.body.error}`);
    assert.deepStrictEqual(touched, []);
});

test('a misspelled import scope is refused in one sentence, not quietly "organizer"', async () => {
    const res = await dispatch({ method: 'PUT', url: '/user/me', body: { importScope: 'calender' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, "importScope is 'organizer' or 'calendar', or null for no opinion.");
    assert.deepStrictEqual(touched, []);
});

test('a lookback that is not a number is refused by name', async () => {
    const res = await dispatch({ method: 'PUT', url: '/user/me', body: { lookbackHours: 'a day' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'lookbackHours is a number of hours.');
    assert.deepStrictEqual(touched, []);
});

test('the document the settings screen sends back — its own GET — still saves', async () => {
    const echoed = {
        autoImport: true, autoRecordConfig: false, importScope: 'calendar', language: 'en',
        lookbackHours: 24, excludedEventIds: ['e1'], excludedMeetingCodes: [],
        updatedAt: '2026-09-01T10:00:00.000Z', updatedBy: 'u1',
    };
    const res = await dispatch({ method: 'PUT', url: '/user/me', body: echoed });
    assert.strictEqual(res.statusCode, 200);
    const [userId, patch] = touched.find((t) => t.what === 'saveUserSettings').args;
    assert.strictEqual(userId, 'u1');
    assert.strictEqual(patch.autoImport, true);
    assert.strictEqual(patch.importScope, 'calendar');
    assert.deepStrictEqual(patch.excludedEventIds, ['e1'], 'the legacy list still round-trips');
});

test('null is still "no opinion" on the org document', async () => {
    const res = await dispatch({ method: 'PUT', url: '/org1', body: { autoImport: null, importScope: null, language: null } });
    assert.strictEqual(res.statusCode, 200);
    const [orgId, patch, by] = touched.find((t) => t.what === 'saveOrgSettings').args;
    assert.strictEqual(orgId, 'org1');
    assert.strictEqual(by, 'u1');
    assert.deepStrictEqual(patch, { autoImport: null, importScope: null, language: null });
});
