/**
 * What POST /api/dictate accepts, and what it says when it refuses
 * (routes/dictate.js).
 *
 * The upload is multipart, so its one text field is checked BEHIND multer —
 * that is the only place it exists. `languge=en` used to be dropped, and an
 * English sentence came back transcribed as Dutch; `language=portuguese` was
 * cut to 'portugue', a hint neither engine knows.
 *
 * What this file pins, through a real multipart request:
 *
 *   - a misspelled field is a 400 naming it, and nothing is transcribed;
 *   - the web composer's own upload (`audio` + `language=nl`) still works;
 *   - the language reaches the engine whole.
 *
 * Run: cd server && node --test routes/dictate.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const Module = require('module');

// Every transcription lands in `heard`. A refused upload must leave it empty.
const heard = [];

const MOCKS = {
    '../auth/permissions': {
        requireAuth: (req, res, next) => { req.session = { user: { id: 'u1' } }; next(); },
    },
    '../core/voice/localWhisper': {
        transcribeLocally: async (_path, opts) => { heard.push(opts); return { text: 'hallo', provider: 'cpu', durationSec: 1 }; },
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:dictate-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /routes[\\/]dictate\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const express = require('express');
const router = require('./dictate');
const { terminalErrorHandler } = require('../core/http/terminalErrorHandler');

let server;
let baseUrl;

test.before(async () => {
    const app = express();
    app.use('/api/dictate', router);
    app.use(terminalErrorHandler);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
    Module._resolveFilename = originalResolve;
    await new Promise((resolve) => server.close(resolve));
});

test.beforeEach(() => { heard.length = 0; });

/** A recording as the composer sends it: one audio blob plus text fields. */
async function upload(fields) {
    const form = new FormData();
    form.append('audio', new Blob([Buffer.alloc(2048, 1)], { type: 'audio/webm' }), 'dictation.webm');
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    const res = await fetch(`${baseUrl}/api/dictate`, { method: 'POST', body: form });
    return { status: res.status, body: await res.json() };
}

test('a misspelled language field is refused by name, instead of hearing English as Dutch', async () => {
    const res = await upload({ languge: 'en' });
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.details.some((d) => d.path === 'body'), JSON.stringify(res.body));
    assert.deepStrictEqual(heard, [], 'nothing was transcribed');
});

test('a language longer than any code is refused in words', async () => {
    const res = await upload({ language: 'the language my colleague speaks' });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error, 'language is a language code, like nl or en.');
    assert.deepStrictEqual(heard, []);
});

test('the composer\'s upload still transcribes, in the language it names', async () => {
    const res = await upload({ language: 'nl' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.text, 'hallo');
    assert.deepStrictEqual(heard, [{ language: 'nl' }]);
});

test('a language reaches the engine whole, not cut to eight characters', async () => {
    const res = await upload({ language: 'portuguese' });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(heard, [{ language: 'portuguese' }]);
});

test('a tag with a region is heard as its language, not refused by the engine as a 503', async () => {
    for (const [language, heardAs] of [['en-US', 'en'], ['pt_BR', 'pt'], ['zh-Hant-TW', 'zh'], ['NL', 'nl']]) {
        heard.length = 0;
        const res = await upload({ language });
        assert.strictEqual(res.status, 200, language);
        assert.deepStrictEqual(heard, [{ language: heardAs }], language);
    }
});

test('no language at all is still Dutch, the composer\'s default', async () => {
    const res = await upload({});
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(heard, [{ language: 'nl' }]);
});
