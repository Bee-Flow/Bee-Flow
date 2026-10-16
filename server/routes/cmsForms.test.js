'use strict';

/**
 * The public website-form endpoint and its admin allow-list, on a plain
 * express app with fake collaborators (no module mocking). Requests go over
 * real HTTP.
 *
 * Run: node --test routes/cmsForms.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const { createTerminalErrorHandler } = require('../core/http/terminalErrorHandler');
const { createPublicRouter } = require('./cmsForms');
const { createAdminRouter } = require('./cmsFormsAdmin');

const BLOCK = {
    id: 'blk_form1',
    type: 'form',
    enabled: true,
    content: {
        automationId: 'auto-1',
        fields: [
            { id: 'name', type: 'text', label: 'Name', required: true },
            { id: 'email', type: 'email', label: 'Email', required: true },
            { id: 'topic', type: 'select', label: 'Topic', options: [{ value: 'demo', label: 'Demo' }, { value: 'news', label: 'News' }] },
            { id: 'note', type: 'textarea', label: 'Note' },
            { id: 'upload', type: 'file', label: 'File' },
        ],
        consent: { enabled: true, text: 'I agree to be contacted.' },
    },
};

function makeAutomation(over = {}) {
    return {
        id: 'auto-1', isActive: true, isDraft: false, organizationId: 'org-1',
        definition: { trigger: { id: 'trg-1', kind: 'webhook' } },
        ...over,
    };
}

function setup(over = {}) {
    const runs = [];
    const state = {
        live: 'pj_abcd',
        snapshot: { pages: { pg1: { blocks: [BLOCK] } } },
        automation: makeAutomation(),
        allow: { 'auto-1': { organizationId: 'org-1', blockIds: ['blk_form1'] } },
        nonces: new Set(),
        drops: [],
        clock: 1_000_000,
        ...over,
    };
    const deps = {
        getLiveSiteId: async () => state.live,
        getPublishedSnapshot: async () => state.snapshot,
        getAutomation: async (id) => (state.automation && state.automation.id === id ? state.automation : null),
        organisationOf: async (a) => a.organizationId || null,
        getFormAutomation: async (id) => state.allow[id] || null,
        countDrop: async (blockId, kind) => { state.drops.push([blockId, kind]); },
        checkAndStoreNonce: async (n) => { if (state.nonces.has(n)) return false; state.nonces.add(n); return true; },
        runAutomation: async (automation, opts) => { runs.push({ automation, opts }); },
        now: () => state.clock,
        rpmTokenPerIp: 1000,
        rpmPerIp: 1000,
        rpmPerForm: 1000,
        ...(over.deps || {}),
    };
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    app.use('/forms', createPublicRouter(deps));
    app.use(createTerminalErrorHandler({ log: { warn() {}, error() {}, info() {}, debug() {} } }));
    return { app, state, runs };
}

function listen(app) {
    return new Promise((resolve) => {
        const server = app.listen(0, '127.0.0.1', () => resolve(server));
    });
}

function call(server, method, path, { body, headers = {}, raw } = {}) {
    return new Promise((resolve, reject) => {
        const data = raw !== undefined ? raw : (body === undefined ? null : JSON.stringify(body));
        const req = http.request({
            host: '127.0.0.1', port: server.address().port, method, path,
            headers: { ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers },
        }, (res) => {
            let text = '';
            res.on('data', (c) => { text += c; });
            res.on('end', () => {
                let json = null;
                try { json = JSON.parse(text); } catch { /* not JSON */ }
                resolve({ status: res.statusCode, json });
            });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

/** Fetch a token, move the clock past the minimum form age, and build a valid submission. */
async function validSubmission(server, state, over = {}) {
    const tok = await call(server, 'GET', '/forms/blk_form1');
    assert.strictEqual(tok.status, 200);
    state.clock += 5000;
    return {
        token: tok.json.token,
        issuedAt: tok.json.issuedAt,
        consent: true,
        answers: { name: 'Test Person', email: 'person@example.test', topic: 'demo', note: 'hello' },
        ...over,
    };
}

const post = (server, body, headers) => call(server, 'POST', '/forms/blk_form1', { body, headers });
const tick = () => new Promise((r) => setImmediate(r));

test('a valid submission starts the automation at its webhook trigger with only the declared answers', async () => {
    const { app, state, runs } = setup();
    const server = await listen(app);
    try {
        const body = await validSubmission(server, state);
        body.answers.__proto__ = { polluted: true };
        body.answers.upload = 'ignored';
        body.answers.extra = 'not declared';
        const res = await post(server, body);
        assert.strictEqual(res.status, 202);
        await tick(); await tick();
        assert.strictEqual(runs.length, 1);
        const { opts } = runs[0];
        assert.strictEqual(opts.triggerKind, 'webhook');
        assert.strictEqual(opts.rootStepId, 'trg-1');
        assert.deepStrictEqual({ ...opts.triggerPayload }, { name: 'Test Person', email: 'person@example.test', topic: 'demo', note: 'hello' });
        assert.strictEqual(opts.triggerHeaders.consent_given, 'true');
        assert.strictEqual(opts.triggerHeaders.consent_text, 'I agree to be contacted.');
        assert.strictEqual(opts.triggerHeaders.form_block_id, 'blk_form1');
        assert.deepStrictEqual(Object.keys(opts.triggerHeaders).sort(),
            ['consent_given', 'consent_locale', 'consent_text', 'form_block_id', 'page_id', 'source', 'submitted_at']);
    } finally { server.close(); }
});

test('an automation not on the allow-list is unavailable, even when the block names it', async () => {
    const { app, state, runs } = setup({ allow: {} });
    const server = await listen(app);
    try {
        assert.strictEqual((await call(server, 'GET', '/forms/blk_form1')).status, 404);
        const body = { token: 'x', issuedAt: state.clock - 9999, answers: {} };
        assert.strictEqual((await post(server, body)).status, 404);
        assert.strictEqual(runs.length, 0);
    } finally { server.close(); }
});

test('the organisation, the active state and the webhook trigger are re-checked on every request', async () => {
    for (const automation of [
        makeAutomation({ organizationId: 'org-other' }),
        makeAutomation({ isActive: false }),
        makeAutomation({ isDraft: true }),
        makeAutomation({ definition: { trigger: { id: 'trg-1', kind: 'manual' } } }),
        null,
    ]) {
        const { app } = setup({ automation });
        const server = await listen(app);
        try {
            assert.strictEqual((await call(server, 'GET', '/forms/blk_form1')).status, 404);
        } finally { server.close(); }
    }
});

test('a block that is not published, disabled, or not a form is unavailable', async () => {
    for (const snapshot of [
        null,
        { pages: {} },
        { pages: { pg1: { blocks: [{ ...BLOCK, enabled: false }] } } },
        { pages: { pg1: { blocks: [{ ...BLOCK, type: 'faq' }] } } },
    ]) {
        const { app } = setup({ snapshot });
        const server = await listen(app);
        try {
            assert.strictEqual((await call(server, 'GET', '/forms/blk_form1')).status, 404);
        } finally { server.close(); }
    }
    const { app } = setup({ live: null });
    const server = await listen(app);
    try {
        assert.strictEqual((await call(server, 'GET', '/forms/blk_form1')).status, 404);
    } finally { server.close(); }
});

test('server-side validation: required, email, closed select, consent', async () => {
    const { app, state, runs } = setup();
    const server = await listen(app);
    try {
        const bad = await validSubmission(server, state, {
            consent: false,
            answers: { name: '', email: 'nope', topic: 'other' },
        });
        const res = await post(server, bad);
        assert.strictEqual(res.status, 400);
        const fields = res.json.details.fields.map((f) => f.field).sort();
        assert.deepStrictEqual(fields, ['consent', 'email', 'name', 'topic']);
        assert.strictEqual(runs.length, 0);
    } finally { server.close(); }
});

test('the envelope is closed and bounded', async () => {
    const { app, state } = setup();
    const server = await listen(app);
    try {
        const body = await validSubmission(server, state);
        assert.strictEqual((await post(server, { ...body, automationId: 'auto-2' })).status, 400);
        const big = await call(server, 'POST', '/forms/blk_form1', {
            body: { ...body, answers: { note: 'x'.repeat(40 * 1024) } },
        });
        assert.strictEqual(big.status, 413);
    } finally { server.close(); }
});

test('a forged, foreign or tampered token is refused', async () => {
    const { app, state, runs } = setup();
    const server = await listen(app);
    try {
        const body = await validSubmission(server, state);
        assert.strictEqual((await post(server, { ...body, token: 'forged' })).status, 403);
        // The token binds the issue time: moving it makes the token invalid.
        assert.strictEqual((await post(server, { ...body, issuedAt: body.issuedAt - 1 })).status, 403);
        assert.strictEqual(runs.length, 0);
    } finally { server.close(); }
});

test('only an Origin from CORS_ORIGIN is accepted, and only JSON', async () => {
    const { app, state } = setup();
    const server = await listen(app);
    const saved = process.env.CORS_ORIGIN;
    try {
        process.env.CORS_ORIGIN = 'https://site.example.test, https://other.example.test/';
        const body = await validSubmission(server, state);
        assert.strictEqual((await post(server, body, { origin: 'https://evil.example.test' })).status, 403);
        // The page and the API may live on different hosts: what counts is the allow-list, not Host.
        assert.strictEqual((await post(server, body, { origin: 'https://other.example.test' })).status, 202);
        const text = await call(server, 'POST', '/forms/blk_form1', { raw: 'a=b', headers: { 'content-type': 'text/plain' } });
        assert.strictEqual(text.status, 415);
    } finally {
        if (saved === undefined) delete process.env.CORS_ORIGIN; else process.env.CORS_ORIGIN = saved;
        server.close();
    }
});

test('honeypot and too-fast submissions answer a silent 200 and run nothing', async () => {
    const { app, state, runs } = setup();
    const server = await listen(app);
    try {
        const trap = await validSubmission(server, state, { ref_code_2: 'http://spam.example.test' });
        const r1 = await post(server, trap);
        assert.deepStrictEqual([r1.status, r1.json.accepted], [200, true]);

        const tok = await call(server, 'GET', '/forms/blk_form1');
        const fast = { token: tok.json.token, issuedAt: tok.json.issuedAt, consent: true, answers: { name: 'A', email: 'a@example.test' } };
        const r2 = await post(server, fast);
        assert.deepStrictEqual([r2.status, r2.json.accepted], [200, true]);
        await tick(); await tick();
        assert.strictEqual(runs.length, 0);
    } finally { server.close(); }
});

test('a replayed nonce does not run twice', async () => {
    const { app, state, runs } = setup();
    const server = await listen(app);
    try {
        const body = await validSubmission(server, state, { nonce: 'abcdefgh1234' });
        assert.strictEqual((await post(server, body)).status, 202);
        const again = await post(server, body);
        assert.strictEqual(again.status, 200);
        assert.strictEqual(again.json.duplicate, true);
        await tick(); await tick();
        assert.strictEqual(runs.length, 1);
    } finally { server.close(); }
});

test('a rejected submission does not use up its nonce: the corrected resend runs', async () => {
    const { app, state, runs } = setup();
    const server = await listen(app);
    try {
        const bad = await validSubmission(server, state, { nonce: 'abcdefgh1234', answers: { name: '', email: 'x' } });
        assert.strictEqual((await post(server, bad)).status, 400);
        const fixed = { ...bad, answers: { name: 'Ada', email: 'ada@example.test' } };
        const res = await post(server, fixed);
        assert.strictEqual(res.status, 202);
        assert.strictEqual(res.json.duplicate, undefined);
        await tick(); await tick();
        assert.strictEqual(runs.length, 1);
    } finally { server.close(); }
});

test('silent drops are counted per form and reason', async () => {
    const { app, state } = setup();
    const server = await listen(app);
    try {
        await post(server, await validSubmission(server, state, { ref_code_2: 'bot' }));
        const tok = await call(server, 'GET', '/forms/blk_form1');
        await post(server, { token: tok.json.token, issuedAt: tok.json.issuedAt, answers: {} });
        assert.deepStrictEqual(state.drops, [['blk_form1', 'honeypot'], ['blk_form1', 'tooFast']]);
    } finally { server.close(); }
});

test('a block the admin has not approved for the automation is unavailable', async () => {
    const { app, state } = setup({ allow: { 'auto-1': { organizationId: 'org-1', blockIds: ['blk_other'] } } });
    const server = await listen(app);
    try {
        assert.strictEqual((await call(server, 'GET', '/forms/blk_form1')).status, 404);
        assert.strictEqual(state.drops.length, 0);
    } finally { server.close(); }
});

test('page views do not use up the budget of real submissions', async () => {
    const { app, state } = setup({ deps: { rpmTokenPerIp: 1000, rpmPerIp: 2 } });
    const server = await listen(app);
    try {
        for (let i = 0; i < 10; i++) assert.strictEqual((await call(server, 'GET', '/forms/blk_form1')).status, 200);
        const body = await validSubmission(server, state);
        assert.strictEqual((await post(server, body)).status, 202);
    } finally { server.close(); }
});

test('the size cap holds for the parsed body, also without a Content-Length', async () => {
    const { app, state } = setup();
    const server = await listen(app);
    try {
        const body = await validSubmission(server, state, { answers: { note: 'x'.repeat(40 * 1024) } });
        const res = await new Promise((resolve, reject) => {
            const req = http.request({ host: '127.0.0.1', port: server.address().port, method: 'POST', path: '/forms/blk_form1', headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' } },
                (r) => { r.resume(); r.on('end', () => resolve(r.statusCode)); });
            req.on('error', reject);
            req.end(JSON.stringify(body));
        });
        assert.strictEqual(res, 413);
    } finally { server.close(); }
});

test('the consent record carries the wording in the visitor\'s locale', async () => {
    const snapshot = {
        pages: { pg1: { blocks: [BLOCK] } },
        pageLocaleOverrides: { pg1: { nl: { blocks: { blk_form1: { content: { consent: { text: 'Ik ga akkoord.' } } } } } } },
    };
    const { app, state, runs } = setup({ snapshot });
    const server = await listen(app);
    try {
        assert.strictEqual((await post(server, await validSubmission(server, state, { locale: 'nl' }))).status, 202);
        assert.strictEqual((await post(server, await validSubmission(server, state, { locale: 'fr' }))).status, 202);
        await tick(); await tick();
        assert.deepStrictEqual(
            runs.map((r) => [r.opts.triggerHeaders.consent_text, r.opts.triggerHeaders.consent_locale]),
            [['Ik ga akkoord.', 'nl'], ['I agree to be contacted.', 'default']],
        );
    } finally { server.close(); }
});

test('a failed run logs the automation id, never the error text', async () => {
    const warnings = [];
    const log = require('../telemetry/log');
    const original = log.warn;
    log.warn = (...a) => { warnings.push(a.join(' ')); };
    const { app, state } = setup({ deps: { runAutomation: async () => { throw new Error('step failed for person@example.test'); } } });
    const server = await listen(app);
    try {
        await post(server, await validSubmission(server, state));
        await tick(); await tick(); await tick();
        assert.ok(warnings.some((w) => w.includes('auto-1')));
        assert.ok(!warnings.some((w) => w.includes('person@example.test')));
    } finally { log.warn = original; server.close(); }
});

test('rate limits answer 429 per IP', async () => {
    const { app } = setup({ deps: { rpmTokenPerIp: 3 } });
    const server = await listen(app);
    try {
        const statuses = [];
        for (let i = 0; i < 5; i++) statuses.push((await call(server, 'GET', '/forms/blk_form1')).status);
        assert.deepStrictEqual(statuses, [200, 200, 200, 429, 429]);
    } finally { server.close(); }
});

test('a form without consent asked for runs without it and says so', async () => {
    const noConsent = { ...BLOCK, content: { ...BLOCK.content, consent: { enabled: false, text: 'x' } } };
    const { app, state, runs } = setup({ snapshot: { pages: { pg1: { blocks: [noConsent] } } } });
    const server = await listen(app);
    try {
        const body = await validSubmission(server, state, { consent: undefined });
        assert.strictEqual((await post(server, body)).status, 202);
        await tick(); await tick();
        assert.strictEqual(runs[0].opts.triggerHeaders.consent_given, 'not_requested');
        assert.strictEqual('consent_text' in runs[0].opts.triggerHeaders, false);
    } finally { server.close(); }
});

// ── admin ─────────────────────────────────────────────────────────────

function adminSetup(over = {}) {
    const enabled = new Map();
    const audits = [];
    const automations = [
        makeAutomation({ id: 'a-web', kind: 'automation', title: 'Demo requests' }),
        makeAutomation({ id: 'a-man', kind: 'automation', title: 'Manual', definition: { trigger: { id: 't', kind: 'manual' } } }),
        makeAutomation({ id: 'a-blk', kind: 'block', title: 'A step' }),
    ];
    const deps = {
        userOrg: async () => over.myOrg === undefined ? 'org-1' : over.myOrg,
        listActiveAutomationsOfOrg: async (org) => (org === 'org-1' ? automations : []),
        getAutomation: async (id) => automations.find((a) => a.id === id) || null,
        organisationOf: async (a) => a.organizationId || null,
        canEdit: async () => over.canEdit !== false,
        listFormAutomations: async () => enabled,
        enableFormAutomation: async (id, meta) => { if (!enabled.has(id)) enabled.set(id, { ...meta, blockIds: [] }); },
        disableFormAutomation: async (id) => { enabled.delete(id); },
        setBlockApproved: async (id, blockId, on) => {
            const e = enabled.get(id);
            e.blockIds = on ? [...e.blockIds, blockId] : e.blockIds.filter((b) => b !== blockId);
        },
        listDraftFormBlocks: async () => [
            { blockId: 'blk_form1', pageId: 'p1', pageTitle: 'Contact', automationId: 'a-web' },
            { blockId: 'blk_form2', pageId: 'p2', pageTitle: 'Home', automationId: 'a-man' },
        ],
        getDrops: async () => ({ blk_form1: { honeypot: 2, tooFast: 1 } }),
        audit: async (...a) => { audits.push(a); },
    };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.session = { user: { id: 'u1', organizationId: 'stale-org' } }; next(); });
    app.use('/admin', createAdminRouter(deps));
    app.use(createTerminalErrorHandler({ log: { warn() {}, error() {}, info() {}, debug() {} } }));
    return { app, enabled, audits };
}

test('admin lists webhook-triggered automations they can edit, with the blocks that target them and their drop counts', async () => {
    const { app } = adminSetup();
    const server = await listen(app);
    try {
        const list = await call(server, 'GET', '/admin/form-automations');
        assert.deepStrictEqual(list.json.automations, [{
            id: 'a-web', title: 'Demo requests', enabled: false,
            blocks: [{ blockId: 'blk_form1', pageTitle: 'Contact', approved: false, drops: { honeypot: 2, tooFast: 1 } }],
        }]);
    } finally { server.close(); }
});

test('enabling and approving are audited, and the block must target the automation', async () => {
    const { app, enabled, audits } = adminSetup();
    const server = await listen(app);
    try {
        assert.strictEqual((await call(server, 'PUT', '/admin/form-automations/a-web/blocks/blk_form1', { body: { approved: true } })).status, 409);
        assert.strictEqual((await call(server, 'PUT', '/admin/form-automations/a-web', { body: { enabled: true } })).status, 200);
        assert.strictEqual((await call(server, 'PUT', '/admin/form-automations/a-web/blocks/blk_form2', { body: { approved: true } })).status, 404);
        assert.strictEqual((await call(server, 'PUT', '/admin/form-automations/a-web/blocks/blk_form1', { body: { approved: true } })).status, 200);
        assert.deepStrictEqual(enabled.get('a-web').blockIds, ['blk_form1']);
        assert.strictEqual((await call(server, 'GET', '/admin/form-automations')).json.automations[0].blocks[0].approved, true);
        assert.strictEqual((await call(server, 'PUT', '/admin/form-automations/a-web', { body: { enabled: false } })).status, 200);
        assert.strictEqual(enabled.size, 0);
        assert.deepStrictEqual(audits.map((a) => a[0]), ['cms.form_automation.enable', 'cms.form_block.approve', 'cms.form_automation.disable']);
        assert.strictEqual(audits[0][3], 'u1');
        assert.strictEqual(audits[0][6], 'org-1');
    } finally { server.close(); }
});

test('admin cannot touch an automation they cannot edit, a non-automation, one outside their organisation, or send a loose body', async () => {
    for (const over of [{ canEdit: false }, { myOrg: 'org-2' }, { myOrg: null }]) {
        const { app, enabled } = adminSetup(over);
        const server = await listen(app);
        try {
            assert.strictEqual((await call(server, 'PUT', '/admin/form-automations/a-web', { body: { enabled: true } })).status, 404);
            assert.strictEqual(enabled.size, 0);
        } finally { server.close(); }
    }
    const { app, enabled } = adminSetup();
    const server = await listen(app);
    try {
        assert.strictEqual((await call(server, 'PUT', '/admin/form-automations/a-blk', { body: { enabled: true } })).status, 404);
        assert.strictEqual((await call(server, 'PUT', '/admin/form-automations/a-man', { body: { enabled: true } })).status, 400);
        assert.strictEqual((await call(server, 'PUT', '/admin/form-automations/a-web', { body: { enabled: 'yes' } })).status, 400);
        assert.strictEqual((await call(server, 'PUT', '/admin/form-automations/a-web', { body: { enabled: true, extra: 1 } })).status, 400);
        assert.strictEqual(enabled.size, 0);
    } finally { server.close(); }
});
