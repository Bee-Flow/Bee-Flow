/**
 * What the conversation-memory save accepts, and what it says when it refuses
 * (routes/orgAiContext.js).
 *
 * The handler wrote `!!compactionEnabled`. So the STRING "false" switched lossy
 * compaction ON for every member of the organisation, and a body that left the
 * switch out — or misspelled it — wrote an explicit OFF under a 200, over
 * whatever the org had before. What this file pins:
 *
 *   - the switch travels with every save, as a real boolean;
 *   - a tunable that is not a number is refused by name instead of becoming
 *     the default (an out-of-range NUMBER is still clamped: orgAiContext.test.js);
 *   - the 400 is a sentence, and a refused request writes nothing.
 *
 * Run: cd server && node --test routes/orgAiContext.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every config write lands in `touched`. A refused request must leave it empty.
const touched = [];
const pass = (req, res, next) => next();

const MOCKS = {
    '../stores/configStore': {
        getConfig: async () => null,
        setConfig: async (key, value) => { touched.push({ what: 'setConfig', args: [key, value] }); return true; },
    },
    '../auth': { resolveUserOrgIds: async () => new Set(['org1']) },
    '../auth/permissions': { requireAuth: pass, isOrgAdminForOrg: async () => true },
    '../core/llm/contextPolicy': {
        // The real normalizePolicy is exercised by orgAiContext.test.js; here
        // it only has to show what reached it.
        normalizePolicy: (p) => ({
            compactionEnabled: p.compactionEnabled,
            compactionThreshold: p.compactionThreshold ?? 16,
            recentWindow: p.recentWindow ?? 8,
            contextBudgetPercent: p.contextBudgetPercent ?? 75,
        }),
        invalidateContextPolicy: () => {},
        contextWindowExamples: () => [],
        CONFIG_KEY_PREFIX: 'org_ai_context_',
        MIN_CONTEXT_BUDGET_PERCENT: 25,
        MAX_CONTEXT_BUDGET_PERCENT: 95,
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:org-ai-context-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /routes[\\/]orgAiContext\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./orgAiContext');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../core/http/terminalErrorHandler');

function dispatch({ method, url, body }) {
    return new Promise((resolve, reject) => {
        const req = {
            method, url, originalUrl: url, path: url, body, query: {}, headers: {},
            session: { user: { id: 'admin1' } }, get() { return undefined; },
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

const SWITCH_TEXT = 'Say whether compaction is on: compactionEnabled is true or false.';

test.beforeEach(() => { touched.length = 0; });

test('a save without the switch is refused in words, instead of writing OFF', async () => {
    const res = await dispatch({ method: 'PUT', url: '/org1', body: { contextBudgetPercent: 60 } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, SWITCH_TEXT, 'the caller reads this sentence, not "Required"');
    assert.ok(res.body.details.some((d) => d.path === 'body.compactionEnabled'));
    assert.deepStrictEqual(touched, [], 'nothing was written');
});

test('no body at all gets the same sentence', async () => {
    const res = await dispatch({ method: 'PUT', url: '/org1', body: undefined });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, SWITCH_TEXT);
    assert.deepStrictEqual(touched, []);
});

test('the string "false" is refused, instead of switching compaction ON', async () => {
    const res = await dispatch({ method: 'PUT', url: '/org1', body: { compactionEnabled: 'false' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, SWITCH_TEXT);
    assert.deepStrictEqual(touched, []);
});

test('a misspelled switch is refused by name, instead of saving an OFF', async () => {
    const res = await dispatch({ method: 'PUT', url: '/org1', body: { compactionEnabled: true, compactionEnabeld: true } });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(/compactionEnabeld/.test(res.body.error), `the 400 names the key: ${res.body.error}`);
    assert.deepStrictEqual(touched, []);
});

test('a tunable that is not a number is refused by name, not replaced by the default', async () => {
    const res = await dispatch({
        method: 'PUT', url: '/org1',
        body: { compactionEnabled: true, contextBudgetPercent: 'high' },
    });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'contextBudgetPercent is a number.');
    assert.ok(res.body.details.some((d) => d.path === 'body.contextBudgetPercent'));
    assert.deepStrictEqual(touched, []);
});

test('the body the settings screen sends is saved as sent', async () => {
    const res = await dispatch({
        method: 'PUT', url: '/org1',
        body: { compactionEnabled: true, compactionThreshold: 20, recentWindow: 6, contextBudgetPercent: 80 },
    });
    assert.strictEqual(res.statusCode, 200);
    const saved = touched.find((t) => t.what === 'setConfig');
    assert.strictEqual(saved.args[0], 'org_ai_context_org1');
    assert.strictEqual(saved.args[1].compactionEnabled, true);
    assert.strictEqual(saved.args[1].compactionThreshold, 20);
    assert.strictEqual(saved.args[1].recentWindow, 6);
    assert.strictEqual(saved.args[1].contextBudgetPercent, 80);
});
