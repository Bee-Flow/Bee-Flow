/**
 * What the branding routes accept, and what they say when they refuse
 * (routes/branding.js).
 *
 * brandingStore.sanitize keeps what it recognises and drops the rest, and
 * both PUTs answered 200 — "Theme saved as organisation default" — anyway:
 *
 *   - `allowUserOverride: "false"` (a string) was dropped, so members kept
 *     their own themes after the admin locked them;
 *   - `radiusScale: 'large'` was clamped from NaN to the MINIMUM;
 *   - `accent: '#FFF'` and `preset: 'drak'` were dropped under the same 200.
 *
 * And the member's "back to the organisation theme" never worked: a literal
 * `null` body is refused by the JSON parser, and no body at all cleared
 * nothing. `DELETE /user` clears now — it needs no body — and a PUT with no
 * body clears too, for the phone.
 *
 * What this file pins:
 *
 *   - the 400 NAMES the field (`body.allowUserOverride`);
 *   - the message is a sentence, with the range or the words it accepts;
 *   - the store is never reached, so a refused request changes nothing;
 *   - an auth lookup that throws answers the generic 500, never its own text.
 *
 * Run: cd server && node --test routes/branding.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every store write lands in `touched`. A refused request must leave it empty.
const touched = [];
const fx = { allowUserOverride: true, authThrows: false };
const pass = (req, res, next) => next();

const MOCKS = {
    '../auth/permissions': {
        requireAuth: pass,
        requireAdmin: async (req, res, next) => {
            if (fx.authThrows) throw new Error('password authentication failed for user "beeflow"');
            next();
        },
    },
    '../stores/brandingStore': {
        getOrgDefault: async () => ({ preset: 'light', allowUserOverride: fx.allowUserOverride }),
        setOrgDefault: async (patch) => { touched.push({ what: 'setOrgDefault', args: [patch] }); return { ...patch }; },
        setUserOverride: async (userId, patch) => { touched.push({ what: 'setUserOverride', args: [userId, patch] }); return patch; },
        getEffective: async () => ({ preset: 'light' }),
        getWallpaperFilename: async () => null,
        getPublic: async () => ({}),
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:branding-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /routes[\\/]branding\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./branding');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../core/http/terminalErrorHandler');

function dispatch({ method, url, body }) {
    return new Promise((resolve, reject) => {
        const req = {
            method, url, originalUrl: url, path: url, body, query: {}, headers: {},
            session: { isAuthenticated: true, user: { id: 'u1' } }, get() { return undefined; },
        };
        const res = {
            statusCode: 200, headersSent: false,
            set() { return this; },
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

test.beforeEach(() => { touched.length = 0; fx.allowUserOverride = true; fx.authThrows = false; });

test('"false" as text is refused, instead of leaving members their own themes after the lock', async () => {
    const res = await dispatch({ method: 'PUT', url: '/admin', body: { allowUserOverride: 'false' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'allowUserOverride is true or false.');
    assert.ok(res.body.details.some((d) => d.path === 'body.allowUserOverride'));
    assert.deepStrictEqual(touched, []);
});

test('a number knob given text is refused, instead of landing on its minimum', async () => {
    const res = await dispatch({ method: 'PUT', url: '/admin', body: { radiusScale: 'large' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'radiusScale is a number from 0.5 to 1.5.');
    assert.deepStrictEqual(touched, []);
});

test('a three-digit accent and a misspelled preset are refused, not dropped under "saved"', async () => {
    let res = await dispatch({ method: 'PUT', url: '/admin', body: { accent: '#FFF' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'accent is a colour like #3b82f6 (six hex digits).');

    res = await dispatch({ method: 'PUT', url: '/admin', body: { preset: 'drak' } });
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /^preset is one of: light, dark/);

    res = await dispatch({ method: 'PUT', url: '/admin', body: { glassTierSubtle: { blurr: 20 } } });
    assert.strictEqual(res.statusCode, 400, 'a misspelled tier knob is not the defaults');
    assert.deepStrictEqual(touched, []);
});

test('the Look editor\'s whole form still saves, as sent', async () => {
    const form = {
        preset: 'glass', accent: '#3b82f6', radiusScale: 1.05, font: 'inter',
        glassIntensity: 2, wallpaperPreset: 'sand', glassTint: 'warm', glassLens: 'off',
        glassAnimation: 'subtle', glassGrain: 'frosted', glassBorder: 'iridescent',
        glassTierSubtle: { blur: 10, saturate: 170, brightness: 1.05 }, glassTierDefault: null, glassTierOpaque: null,
        allowUserOverride: false, wallpaperOverlay: 0.1,
    };
    const res = await dispatch({ method: 'PUT', url: '/admin', body: form });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched, [{ what: 'setOrgDefault', args: [form] }]);
});

test('a member\'s PUT with no body clears the override — the one "nothing" both clients can send', async () => {
    const res = await dispatch({ method: 'PUT', url: '/user', body: undefined });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched, [{ what: 'setUserOverride', args: ['u1', null] }]);
});

test('DELETE /user clears the member\'s override and answers the organisation theme', async () => {
    const res = await dispatch({ method: 'DELETE', url: '/user', body: undefined });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { override: null, effective: { preset: 'light' } });
    assert.deepStrictEqual(touched, [{ what: 'setUserOverride', args: ['u1', null] }]);
});

test('DELETE /user is refused like the PUT when the organisation has locked the look', async () => {
    fx.allowUserOverride = false;
    const res = await dispatch({ method: 'DELETE', url: '/user', body: undefined });
    assert.strictEqual(res.statusCode, 403);
    assert.deepStrictEqual(res.body, { error: 'User theme override is disabled by the administrator' });
    assert.deepStrictEqual(touched, []);
});

test('through the app\'s own JSON parser: the web\'s old `null` PUT never arrived, the DELETE does', async () => {
    const express = require('express');
    const http = require('node:http');
    const app = express();
    // index.js: bodyParser.json({ limit: '20mb' }) — strict, so a bare `null` is a parse error.
    app.use(express.json({ limit: '20mb' }));
    app.use((req, _res, next) => { req.session = { isAuthenticated: true, user: { id: 'u1' } }; next(); });
    app.use('/api/branding', router);
    app.use(terminalErrorHandler);
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}/api/branding/user`;
    try {
        const old = await fetch(base, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: 'null' });
        assert.strictEqual(old.status, 400, 'the request clearUserOverride() used to send');
        assert.deepStrictEqual(touched, [], 'and it cleared nothing');

        const cleared = await fetch(base, { method: 'DELETE' });
        assert.strictEqual(cleared.status, 200);
        assert.deepStrictEqual((await cleared.json()).override, null);
        assert.deepStrictEqual(touched, [{ what: 'setUserOverride', args: ['u1', null] }]);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

test('a member\'s own knobs merge; an admin-only knob is refused by name', async () => {
    let res = await dispatch({ method: 'PUT', url: '/user', body: { preset: 'dark' } });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched, [{ what: 'setUserOverride', args: ['u1', { preset: 'dark' }] }]);

    touched.length = 0;
    res = await dispatch({ method: 'PUT', url: '/user', body: { glassTint: 'warm' } });
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(touched, []);
});

test('a locked organisation still answers 403 to a well-formed member body', async () => {
    fx.allowUserOverride = false;
    const res = await dispatch({ method: 'PUT', url: '/user', body: { wallpaperPreset: 'sage' } });
    assert.strictEqual(res.statusCode, 403);
    assert.deepStrictEqual(touched, []);
});

test('an auth lookup that throws is the generic 500, not its own message', async () => {
    fx.authThrows = true;
    const res = await dispatch({ method: 'PUT', url: '/admin', body: { preset: 'dark' } });
    assert.strictEqual(res.statusCode, 500);
    assert.strictEqual(res.body.error, 'Internal server error');
    assert.ok(!JSON.stringify(res.body).includes('password authentication'), 'the database error stays in the log');
    assert.deepStrictEqual(touched, []);
});
