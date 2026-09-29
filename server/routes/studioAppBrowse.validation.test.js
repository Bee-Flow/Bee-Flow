/**
 * What the streaming AI-browse step accepts, and what it says when it refuses
 * (routes/studioAppBrowse.js).
 *
 * The body is the one useActionRunner builds — `{ stepIndex, formValues, vars,
 * item?, index?, value? }` — and writing it down showed that `item`, `index`
 * and `value` were sent and DROPPED: an ai_browse step inside a loop resolved
 * `item.website` against undefined, on the owner's browser slot and model
 * quota. And `?draft=yes` ran the published app while its owner tested the
 * draft. What this file pins:
 *
 *   - the 400 NAMES the field (`query.draft`), not just "invalid request";
 *   - the message is a sentence;
 *   - the executor is never reached, so a refused request browses nothing;
 *   - the loop's scope roots now reach the executor.
 *
 * Run: cd server && node --test routes/studioAppBrowse.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every executor call lands in `touched`. A refused request must leave it empty.
const touched = [];
const pass = (req, res, next) => next();

const browse = (task) => ({ kind: 'ai_browse', task: { kind: 'static', value: task } });
const APP = {
    id: 'app1', userId: 'owner', organizationId: 'org1', isPublished: true,
    definition: { actions: { act1: { kind: 'sequence', steps: [browse('draft task')] } } },
    publishedDefinition: { actions: { act1: { kind: 'sequence', steps: [browse('published task')] } } },
};

const MOCKS = {
    '../stores/studioAppDataStore': { getDataModel: async () => ({ model: { tables: [] } }) },
    '../appStudio/rlsGateway': { resolveViewerRole: async () => 'owner' },
    '../appStudio/actionExecutor': {
        executeDataStep: async (app, model, step, ctx) => {
            touched.push({ what: 'executeDataStep', step, ctx });
            return { ok: true, result: { answer: 'done' } };
        },
    },
    './studioAppRunGate': {
        loadVisibleApp: async () => ({ ...APP }),
        assertActionRoleAccess: () => true,
    },
    '../auth/audience': { resolveAudienceContext: async () => ({ orgIds: new Set(['org1']), userGroups: [] }) },
    '../auth/permissions': { requireAuth: pass },
    './studioAppRateLimits': { browseStepLimiter: pass, aiStepLimiter: pass },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:studio-app-browse-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /routes[\\/]studioAppBrowse\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./studioAppBrowse');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error — through this router's own error
// handler — to the terminal handler, so the harness answers it the way
// index.js does.
const { terminalErrorHandler } = require('../core/http/terminalErrorHandler');

function dispatch({ url, body }) {
    return new Promise((resolve, reject) => {
        const [pathname, search = ''] = String(url).split('?');
        const query = {};
        for (const [k, v] of new URLSearchParams(search)) query[k] = v;
        const req = {
            method: 'POST', url, originalUrl: url, path: pathname, body, query,
            // No content-length: express.json() leaves the pre-set body alone.
            headers: { 'content-type': 'application/json' },
            session: { user: { id: 'owner', name: 'Owner' } }, get() { return undefined; },
            on() { return this; }, off() { return this; },
        };
        const res = {
            statusCode: 200, headersSent: false, frames: [], headers: {},
            status(c) { this.statusCode = c; return this; },
            setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
            flushHeaders() { this.headersSent = true; },
            write(chunk) {
                const line = String(chunk).split('\n').find((l) => l.startsWith('data:'));
                if (line) this.frames.push(JSON.parse(line.slice(5)));
                return true;
            },
            json(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            send(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            end() { this.headersSent = true; resolve(this); return this; },
        };
        router(req, res, (err) => {
            if (!err) return reject(new Error(`fell through: POST ${url}`));
            terminalErrorHandler(err, req, res, (e) => reject(e));
        });
    });
}

test.beforeEach(() => { touched.length = 0; });

const URL_ = '/app1/actions/act1/step/stream';

async function refuses(request, field) {
    const res = await dispatch(request);
    assert.strictEqual(res.statusCode, 400, `${request.url} -> ${JSON.stringify(res.body)}`);
    assert.strictEqual(res.body.code, 'invalid_request');
    assert.ok(res.body.details.some((d) => d.path === field),
        `the 400 must name ${field}; it said ${JSON.stringify(res.body.details)}`);
    assert.deepStrictEqual(touched, [], 'a refused request must not start a browse');
    assert.strictEqual(res.headers['content-type'], undefined, 'a refusal is JSON, never an opened stream');
    return res;
}

test('an unknown draft flag is refused, not answered by running the published app', async () => {
    const res = await refuses({ url: `${URL_}?draft=yes`, body: { stepIndex: 0 } }, 'query.draft');
    assert.match(res.body.error, /^draft is "1" or "true"/);
});

test('a step index parseInt would have "repaired" is refused, in the same sentence every time', async () => {
    for (const stepIndex of ['1abc', 1.5, -1]) {
        const res = await refuses({ url: URL_, body: { stepIndex } }, 'body.stepIndex');
        assert.strictEqual(res.body.error, 'stepIndex is the position of the step in the action (0, 1, 2, …).', String(stepIndex));
    }
});

test('a missing step index is refused in words, not with "Required"', async () => {
    const res = await refuses({ url: URL_, body: {} }, 'body.stepIndex');
    assert.strictEqual(res.body.error, 'stepIndex is the position of the step in the action (0, 1, 2, …).');
});

test('misspelled form values are refused, not browsed with an empty form', async () => {
    await refuses({ url: URL_, body: { stepIndex: 0, formvalues: { q: 'x' } } }, 'body');
});

test('a browse inside a loop now gets its row, its position and the trigger value', async () => {
    const res = await dispatch({
        url: URL_,
        body: { stepIndex: 0, formValues: {}, vars: {}, item: { website: 'https://supplier.example' }, index: 2, value: 'v' },
    });
    assert.strictEqual(res.statusCode, 200);
    const { ctx } = touched.find((t) => t.what === 'executeDataStep');
    assert.deepStrictEqual(ctx.item, { website: 'https://supplier.example' });
    assert.strictEqual(ctx.index, 2);
    assert.strictEqual(ctx.value, 'v');
    assert.deepStrictEqual(res.frames.map((f) => f.type), ['result', 'done']);
});

test('?draft=1 from the owner still runs the draft, and the index may arrive as digits', async () => {
    const res = await dispatch({ url: `${URL_}?draft=1`, body: { stepIndex: '0', formValues: {}, vars: {} } });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(touched.find((t) => t.what === 'executeDataStep').step.task.value, 'draft task');
});

test('without the flag the published app runs, as before', async () => {
    const res = await dispatch({ url: URL_, body: { stepIndex: 0 } });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(touched.find((t) => t.what === 'executeDataStep').step.task.value, 'published task');
});
