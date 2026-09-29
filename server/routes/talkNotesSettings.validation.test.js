/**
 * What the Talk → Meeting Notes settings routes accept, and what they say when
 * they refuse (routes/talkNotesSettings.js).
 *
 * These are the switches that start RECORDING people's calls, and the save
 * functions coerce every field: `{"autoRecord": "false"}` switched
 * auto-recording ON (the text "false" is true), `{"insightsPerPersonStats":
 * "false"}` left per-person talk-time statistics on for the whole org, and
 * `"All"` / `"Video"` were quietly read as "calendar" / "audio". What this file
 * pins is the part a caller can act on:
 *
 *   - the 400 NAMES the field (`body.autoRecord`), not just "invalid request";
 *   - the message is a sentence;
 *   - nothing is saved, so a refused request changes no setting;
 *   - the round trip the two settings screens make (GET, edit, PUT it all
 *     back, echoes included) still saves.
 *
 * Run: cd server && node --test routes/talkNotesSettings.validation.test.js
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
    '../stores/userStore': {},
    '../auth': { resolveUserOrgIds: async () => new Set(['org1']) },
    '../core/meetingNotes/talkNotesSettings': {
        saveUserSettings: async (userId, patch) => { touched.push({ what: 'saveUserSettings', args: [userId, patch] }); return { ...patch }; },
        saveOrgSettings: async (orgId, patch) => { touched.push({ what: 'saveOrgSettings', args: [orgId, patch] }); return { ...patch }; },
        getUserSettings: async () => ({}),
        getOrgSettings: async () => ({}),
    },
    '../auth/permissions': { requireAuth: pass, isOrgAdminForOrg: async () => true },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:talk-notes-settings-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /routes[\\/]talkNotesSettings\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./talkNotesSettings');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../core/http/terminalErrorHandler');

function dispatch({ url, body }) {
    return new Promise((resolve, reject) => {
        const req = {
            method: 'PUT', url, originalUrl: url, path: url, body, query: {}, headers: {},
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
            if (!err) return reject(new Error(`fell through: PUT ${url}`));
            terminalErrorHandler(err, req, res, (e) => reject(e));
        });
    });
}

test.beforeEach(() => { touched.length = 0; });

async function refuses(request, field) {
    const res = await dispatch(request);
    assert.strictEqual(res.statusCode, 400, `${request.url} -> ${JSON.stringify(res.body)}`);
    assert.strictEqual(res.body.code, 'invalid_request');
    assert.ok(res.body.details.some((d) => d.path === field),
        `the 400 must name ${field}; it said ${JSON.stringify(res.body.details)}`);
    assert.deepStrictEqual(touched, [], 'a refused request must not save a setting');
    return res;
}

// ═══ The coercions that ran the wrong way ═══════════════════════════

test('"false" as text is refused, not read as "record my calls"', async () => {
    const res = await refuses({ url: '/user/me', body: { autoRecord: 'false' } }, 'body.autoRecord');
    assert.strictEqual(res.body.error, 'autoRecord is true or false.');
});

test('the same on the organisation — auto-recording for every member', async () => {
    await refuses({ url: '/org1', body: { autoRecord: 'false' } }, 'body.autoRecord');
});

test('"false" as text on per-person insights is refused, not left on for everyone', async () => {
    await refuses({ url: '/org1', body: { insightsPerPersonStats: 'false' } }, 'body.insightsPerPersonStats');
    await refuses({ url: '/org1', body: { insightsPerPersonStats: 0 } }, 'body.insightsPerPersonStats');
});

test('a scope the recorder does not know is refused, not read as "calendar"', async () => {
    const res = await refuses({ url: '/org1', body: { autoRecordScope: 'All' } }, 'body.autoRecordScope');
    assert.strictEqual(res.body.error, 'autoRecordScope is "calendar" (scheduled meetings) or "all" (any moderated call).');
});

test('a recording mode the recorder does not know is refused, not read as "audio"', async () => {
    const res = await refuses({ url: '/user/me', body: { recordingMode: 'Video' } }, 'body.recordingMode');
    assert.strictEqual(res.body.error, 'recordingMode is "audio" or "video".');
});

test('a language that is not a language code is refused rather than sent to the transcriber', async () => {
    await refuses({ url: '/user/me', body: { language: 'english' } }, 'body.language');
});

test('a misspelled switch is refused, not dropped', async () => {
    await refuses({ url: '/user/me', body: { autoRecrod: true } }, 'body');
});

test('a personal setting cannot be "inherit" — there is nothing above it to inherit from', async () => {
    await refuses({ url: '/user/me', body: { autoRecord: null } }, 'body.autoRecord');
});

// ═══ The round trips the two screens make ═══════════════════════════

test('the personal screen PUTs back what it got — echoes included — and it saves', async () => {
    const body = {
        autoTranscribe: true, postSummaryBack: false, recordingFolder: '/Talk/Recording', language: 'nl',
        autoRecord: false, autoRecordScope: 'calendar', recordingMode: 'audio',
        excludedEventUids: [], excludedRoomTokens: ['abc'],
        updatedAt: '2026-09-22T10:00:00.000Z', updatedBy: 'u1',
        nextcloudConnected: true, recordingEnabled: false,
    };
    const res = await dispatch({ url: '/user/me', body });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    const [userId, patch] = touched.find((t) => t.what === 'saveUserSettings').args;
    assert.strictEqual(userId, 'u1');
    assert.strictEqual(patch.autoTranscribe, true);
    assert.deepStrictEqual(patch.excludedRoomTokens, ['abc']);
});

test('the org screen PUTs back nulls ("inherit") and the org-only fields, and it saves', async () => {
    const body = {
        autoTranscribe: null, postSummaryBack: null, recordingFolder: null, language: null,
        autoRecord: true, autoRecordScope: 'all', recordingMode: 'video',
        excludedEventUids: [], excludedRoomTokens: [],
        defaultOwnerUserId: null, insightsPerPersonStats: false,
        updatedAt: '2026-09-22T10:00:00.000Z', updatedBy: 'admin',
    };
    const res = await dispatch({ url: '/org1', body });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    const [orgId, patch] = touched.find((t) => t.what === 'saveOrgSettings').args;
    assert.strictEqual(orgId, 'org1');
    assert.strictEqual(patch.autoTranscribe, null, 'null stays "inherit"');
    assert.strictEqual(patch.insightsPerPersonStats, false);
    assert.strictEqual(patch.autoRecordScope, 'all');
});

test('the org-only fields are not accepted on the personal route', async () => {
    await refuses({ url: '/user/me', body: { insightsPerPersonStats: false } }, 'body');
});
