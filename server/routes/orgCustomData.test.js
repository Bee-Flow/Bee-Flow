'use strict';
/**
 * Route tests for the "Your own data" test bench (routes/orgCustomData.js).
 *
 * Every dependency is injected through createCustomDataRouter(deps): the
 * session gate, the admin check, the licence, the guard scan, the engine, the
 * model and the usage store. Requests go over real HTTP to the router mounted
 * where orgPrivacyShield.js mounts it, with the real terminal error handler
 * behind it, so the error ENVELOPE the SPA parses is what is asserted.
 *
 * Pinned:
 *   - the chain: 401 before anything, 400 on a bad body, 403 not_org_admin,
 *     403 feature_locked for an org without the feature;
 *   - /assist/preview makes no model call and shows only look-alikes;
 *   - /assist: 409 preview_stale, 422 assist_personal_data {findings},
 *     503 assist_check_unavailable, 503 no_assist_model, 502 assist_failed,
 *     422 assist_no_usable_output; the model sees no real example; the
 *     answer is cleaned and one usage row is written;
 *   - /test for words works without a guard; ai without a guard is 503;
 *   - /tune needs 5 marked sentences;
 *   - named rate limits, and the assist limit bites.
 *
 * Run: node --test routes/orgCustomData.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const { createCustomDataRouter } = require('./orgCustomData');
const { createTerminalErrorHandler } = require('../core/http/terminalErrorHandler');
const { perUserRateLimit } = require('../utils/perUserRateLimit');
const { ASSIST_TOOL } = require('../core/privacy/customData/assist');
const { createFakeEngine } = require('../core/privacy/customData/fakeEngine.testutil');

const KEY = Buffer.alloc(32, 9);
const TYPE = { id: 'cdt_0123456789', name: 'Customer numbers', description: 'Numbers like KL-12345 on invoices.', method: 'pattern' };
const EXAMPLES = ['KL-12345', 'KL-99812'];
const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function makeDeps(over = {}) {
    const calls = { chat: [], usage: [], pii: [], limiters: [], licence: [] };
    const deps = {
        _calls: calls,
        requireAuth: (req, res, next) => (req.session?.isAuthenticated ? next() : res.status(401).json({ error: 'Not authenticated' })),
        isOrgAdmin: async (req, orgId) => req.session.user.id === 'admin' && ['orgA', 'orgC', 'orgL'].includes(orgId),
        rateLimit: (opts) => { calls.limiters.push(opts); return perUserRateLimit({ ...opts, _redis: null }); },
        licence: { orgHasCustomDataTypes: async (scope) => { calls.licence.push(scope); return scope.organizationId !== 'orgC'; } },
        maskKey: () => KEY,
        detectPii: async (text, cats, thr, opts) => { calls.pii.push({ text, cats, opts }); return { hasPii: false, entities: [] }; },
        engine: createFakeEngine({ probe: () => { throw new Error('no guard'); } }),
        resolveModel: async () => 'fast-model',
        llm: {
            chatForcedTool: async (modelId, messages, toolDef, options) => {
                calls.chat.push({ modelId, messages, toolDef, options });
                const lines = messages[1].content.split('\n');
                const look = lines.slice(lines.indexOf('<example_values>') + 1, lines.indexOf('</example_values>'));
                return {
                    structured: {
                        suggested_method: 'pattern',
                        templates: [`Invoice ${look[0]} is overdue.`, `Credit ${look[1]} against ${look[0]}.`, 'No code here.'],
                        near_misses: ['Order 2024-118 shipped.'],
                        patterns: ['KL-\\d{5}', '(a+)+'],
                        ai_labels: ['customer number'],
                    },
                    usage: { prompt_tokens: 120, completion_tokens: 80 },
                };
            },
        },
        usage: { logUsage: async (row) => { calls.usage.push(row); } },
        configStore: {
            getConfig: async (key) => ({
                org_privacy_shield_orgA: { customDataTypes: [{ id: 'cdt_aaaaaaaaaa', method: 'words', words: { values: ['Falcon'], caseSensitive: false, wholeWord: true } }] },
                org_privacy_shield_orgL: { customSensitiveTerms: ['Heron'] },
            }[key] || null),
        },
        log: quiet,
    };
    return Object.assign(deps, over);
}

let server;
let baseUrl;
let deps;

async function start(nextDeps = makeDeps()) {
    deps = nextDeps;
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        const who = req.headers['x-test-user'];
        req.session = who ? { isAuthenticated: true, user: { id: who, organizationId: 'orgA' } } : {};
        next();
    });
    app.use('/api/org-privacy-shield/:orgId/custom-data', createCustomDataRouter(deps));
    app.use(createTerminalErrorHandler({ log: quiet }));
    if (server) await new Promise((resolve) => server.close(resolve));
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
}

test.after(async () => { if (server) await new Promise((resolve) => server.close(resolve)); });

async function post(path, body, { user = 'admin', org = 'orgA' } = {}) {
    const res = await fetch(`${baseUrl}/api/org-privacy-shield/${org}/custom-data${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user': user } : {}) },
        body: JSON.stringify(body),
    });
    return { status: res.status, headers: res.headers, body: await res.json() };
}

async function preview(type = TYPE, examples = EXAMPLES, extra = {}) {
    const r = await post('/assist/preview', { type, examples, ...extra });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
}

// ── The chain ───────────────────────────────────────────────────────────────

test('no session is 401 before anything else runs', async () => {
    await start();
    const r = await post('/assist/preview', { type: TYPE, examples: EXAMPLES }, { user: null });
    assert.equal(r.status, 401);
    assert.equal(deps._calls.licence.length, 0);
});

test('a bad body is 400 invalid_request with every issue under details', async () => {
    await start();
    const r = await post('/assist/preview', { type: { ...TYPE, id: 'nope', method: 'regex' }, examples: EXAMPLES });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'invalid_request');
    assert.ok(Array.isArray(r.body.details) && r.body.details.length === 2);
    assert.ok(r.body.details.every((d) => d.path.startsWith('body.type.')));
    assert.equal(typeof r.body.correlationId, 'string');
});

test('not an admin of the org in the URL is 403 not_org_admin', async () => {
    await start();
    const member = await post('/assist/preview', { type: TYPE, examples: EXAMPLES }, { user: 'member' });
    assert.equal(member.status, 403);
    assert.equal(member.body.code, 'not_org_admin');
    const otherOrg = await post('/assist/preview', { type: TYPE, examples: EXAMPLES }, { org: 'orgZ' });
    assert.equal(otherOrg.body.code, 'not_org_admin');
    assert.equal(deps._calls.licence.length, 0, 'the licence is only asked for an admin');
});

test('an org without custom_data_types is 403 feature_locked, resolved for the TARGET org', async () => {
    await start();
    for (const path of ['/assist/preview', '/assist', '/test', '/tune']) {
        const body = path.startsWith('/assist')
            ? { type: TYPE, examples: EXAMPLES, expectLookalikes: [] }
            : { type: { ...TYPE, tokenKey: 'n', pattern: { source: 'KL-\\d{5}' } }, sentences: [{ id: 'a', text: 'x' }] };
        const r = await post(path, body, { org: 'orgC' });
        assert.equal(r.status, 403, path);
        assert.equal(r.body.code, 'feature_locked', path);
    }
    assert.deepEqual(deps._calls.licence[0], { organizationId: 'orgC', userId: 'admin' });
    assert.equal(deps._calls.chat.length, 0);
});

test('every route has a named per-user limiter', async () => {
    await start();
    assert.deepEqual(deps._calls.limiters.map((l) => `${l.name}:${l.max}/${l.windowMs}`), [
        'shield-custom-data-preview:30/60000',
        'shield-custom-data-assist:6/60000',
        'shield-custom-data-assist-day:40/86400000',
        'shield-custom-data-test:30/60000',
        'shield-custom-data-tune:10/60000',
    ]);
});

// ── Preview ─────────────────────────────────────────────────────────────────

test('preview: exactly what the assistant would see, no model call', async () => {
    await start();
    const r = await post('/assist/preview', { type: TYPE, examples: EXAMPLES });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'private, no-store');
    const { outbound, keepFixedProposal } = r.body;
    assert.deepEqual(keepFixedProposal, ['KL-']);
    assert.equal(outbound.lookalikes.length, 2);
    for (const l of outbound.lookalikes) {
        assert.match(l, /^[A-Z]{2}-\d{5}$/);
        assert.ok(!EXAMPLES.includes(l));
    }
    assert.equal(outbound.name, 'Customer numbers');
    assert.equal(outbound.description, `Numbers like ${outbound.lookalikes[0]} on invoices.`);
    assert.equal(deps._calls.chat.length, 0);
    // Stable: the same input gives the same payload.
    assert.deepEqual((await preview()).outbound, outbound);
    // With the proposed fixed part accepted, the format prefix stays.
    const kept = await preview(TYPE, EXAMPLES, { keepFixed: keepFixedProposal });
    for (const l of kept.outbound.lookalikes) assert.match(l, /^KL-\d{5}$/);
});

// ── Assist ──────────────────────────────────────────────────────────────────

test('assist: a changed payload since the preview is 409 preview_stale', async () => {
    await start();
    const { outbound } = await preview();
    const r = await post('/assist', { type: TYPE, examples: [...EXAMPLES, 'KL-55555'], expectLookalikes: outbound.lookalikes });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'preview_stale');
    assert.equal(deps._calls.chat.length, 0);
});

test('assist: personal data or own values in the payload is 422 with findings under details', async () => {
    await start(makeDeps({
        detectPii: async (text) => {
            const at = text.indexOf('Jan Jansen');
            return { hasPii: at >= 0, entities: at >= 0 ? [{ offset: at, length: 10, category: 'PERSON', text: 'Jan Jansen' }] : [] };
        },
    }));
    const type = { ...TYPE, description: 'Ask Jan Jansen about Falcon numbers.' };
    const { outbound } = await preview(type);
    const r = await post('/assist', { type, examples: EXAMPLES, expectLookalikes: outbound.lookalikes });
    assert.equal(r.status, 422);
    assert.equal(r.body.code, 'assist_personal_data');
    assert.deepEqual(r.body.details, { findings: [
        { field: 'description', start: 4, end: 14, category: 'PERSON' },
        { field: 'description', start: 21, end: 27, category: 'cdt_aaaaaaaaaa' },
    ] });
    assert.ok(!JSON.stringify(r.body).includes('Jan Jansen'), 'the finding carries offsets, not the text');
    assert.equal(deps._calls.chat.length, 0);
});

test('assist: an org still on the old terms is checked against them too', async () => {
    await start();
    const type = { ...TYPE, description: 'Codes for the Heron account.' };
    const pre = await post('/assist/preview', { type, examples: EXAMPLES }, { org: 'orgL' });
    // Look-alikes are keyed per org: orgA's preview would be stale here.
    assert.notDeepEqual(pre.body.outbound.lookalikes, (await preview(type)).outbound.lookalikes);
    const r = await post('/assist', { type, examples: EXAMPLES, expectLookalikes: pre.body.outbound.lookalikes }, { org: 'orgL' });
    assert.equal(r.status, 422);
    assert.equal(r.body.details.findings[0].category, 'cdt_0000000000');
});

test('assist: the check that cannot run is 503 assist_check_unavailable', async () => {
    for (const detectPii of [async () => null, async () => ({ hasPii: false, entities: [], degraded: true })]) {
        await start(makeDeps({ detectPii }));
        const { outbound } = await preview();
        const r = await post('/assist', { type: TYPE, examples: EXAMPLES, expectLookalikes: outbound.lookalikes });
        assert.equal(r.status, 503);
        assert.equal(r.body.code, 'assist_check_unavailable');
        assert.equal(r.body.error.length > 0, true, 'a 503 HttpError keeps its message');
        assert.equal(deps._calls.chat.length, 0);
    }
});

test('assist: no fast model is 503 no_assist_model, also when the resolver throws', async () => {
    for (const resolveModel of [async () => null, async () => { throw new Error('x'); }]) {
        await start(makeDeps({ resolveModel }));
        const { outbound } = await preview();
        const r = await post('/assist', { type: TYPE, examples: EXAMPLES, expectLookalikes: outbound.lookalikes });
        assert.equal(r.status, 503);
        assert.equal(r.body.code, 'no_assist_model');
    }
});

test('assist: a provider error is 502 assist_failed, and nothing is logged as usage', async () => {
    await start(makeDeps({ llm: { chatForcedTool: async () => { throw Object.assign(new Error('upstream said KL-12345'), { status: 500 }); } } }));
    const { outbound } = await preview();
    const r = await post('/assist', { type: TYPE, examples: EXAMPLES, expectLookalikes: outbound.lookalikes });
    assert.equal(r.status, 502);
    assert.equal(r.body.code, 'assist_failed');
    assert.ok(!JSON.stringify(r.body).includes('KL-12345'));
    assert.equal(deps._calls.usage.length, 0);
});

test('assist: an answer with nothing usable is 422 assist_no_usable_output (usage still logged)', async () => {
    await start(makeDeps({ llm: { chatForcedTool: async () => ({ structured: { templates: ['no code'], ai_labels: ['<x>'] }, usage: {} }) } }));
    const { outbound } = await preview();
    const r = await post('/assist', { type: TYPE, examples: EXAMPLES, expectLookalikes: outbound.lookalikes });
    assert.equal(r.status, 422);
    assert.equal(r.body.code, 'assist_no_usable_output');
    assert.equal(deps._calls.usage.length, 1);
});

test('assist: the model sees only look-alikes; the answer is cleaned; one usage row', async () => {
    await start();
    const { outbound } = await preview();
    const r = await post('/assist', { type: TYPE, examples: EXAMPLES, expectLookalikes: outbound.lookalikes });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.headers.get('cache-control'), 'private, no-store');

    const call = deps._calls.chat[0];
    assert.equal(call.modelId, 'fast-model');
    assert.equal(call.toolDef, ASSIST_TOOL);
    assert.deepEqual(call.options, { maxTokens: 2500, temperature: 0.3, reasoningEffort: 'none', budgetTokens: 0 });
    const sent = JSON.stringify(call.messages);
    for (const ex of EXAMPLES) assert.ok(!sent.includes(ex), `${ex} reached the model`);
    for (const l of outbound.lookalikes) assert.ok(sent.includes(l));

    const body = r.body;
    assert.deepEqual(body.outbound, outbound);
    assert.equal(body.suggestedMethod, 'pattern');
    assert.equal(body.sentences.length, 2);
    for (const s of body.sentences) {
        for (const g of s.gold) assert.ok(EXAMPLES.includes(s.text.slice(g.start, g.end)));
        for (const l of outbound.lookalikes) assert.ok(!s.text.includes(l));
    }
    assert.deepEqual(body.nearMisses.map((s) => [s.text, s.gold, s.origin]), [['Order 2024-118 shipped.', [], 'nearmiss']]);
    assert.deepEqual(body.candidates, { patterns: [{ source: 'KL-\\d{5}', describe: 'KL- followed by 5 digits' }], aiLabels: ['customer number'] });
    assert.deepEqual(body.dropped, { sentences: 1, patterns: 1, labels: 0 });

    assert.equal(deps._calls.usage.length, 1);
    const row = deps._calls.usage[0];
    assert.equal(row.source, 'shield_custom_data_assist');
    assert.equal(row.organization_id, 'orgA');
    assert.equal(row.agent_type, 'system');
    assert.equal(row.user_id, 'admin');
    assert.equal(row.model, 'fast-model');
    assert.equal(row.total_tokens, 200);
    // The guard scan ran on the outbound payload, as a bulk scan over all categories.
    assert.ok(deps._calls.pii.every((p) => p.cats === null && p.opts.priority === 'bulk'));
    assert.ok(deps._calls.pii.every((p) => !EXAMPLES.some((ex) => p.text.includes(ex))));
});

test('assist: the per-minute limit bites at the seventh call', async () => {
    await start();
    const { outbound } = await preview();
    const statuses = [];
    for (let i = 0; i < 7; i += 1) {
        statuses.push((await post('/assist', { type: TYPE, examples: EXAMPLES, expectLookalikes: outbound.lookalikes })).status);
    }
    assert.deepEqual(statuses, [200, 200, 200, 200, 200, 200, 429]);
});

// ── Test and tune ───────────────────────────────────────────────────────────

const WORDS_TYPE = {
    id: 'cdt_0123456789', name: 'Projects', method: 'words', tokenKey: 'project',
    words: { values: ['Falcon'], caseSensitive: false, wholeWord: true }, quality: { found: 1 }, status: 'invalid',
};

test('test: a words type is scored locally, without a guard', async () => {
    await start();
    const r = await post('/test', { type: WORDS_TYPE, sentences: [{ id: 'a', text: 'Falcon is late.', gold: [{ start: 0, end: 6 }] }] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.engine, 'local');
    assert.deepEqual(r.body.results, [{ id: 'a', marks: [{ start: 0, end: 6, kind: 'hit' }], verdict: 'correct' }]);
    assert.deepEqual(r.body.summary, { found: 1, total: 1, falseAlarms: 0, sentences: 1 });
    assert.equal(r.body.preview, '[project_1] is late.');
});

test('test: an ai type without a guard is 503 guard_unavailable', async () => {
    await start();
    const r = await post('/test', {
        type: { id: 'cdt_0123456789', name: 'P', method: 'ai', tokenKey: 'p', ai: { prompt: 'project name', floor: 0.5 } },
        sentences: [{ id: 'a', text: 'Falcon' }],
    });
    assert.equal(r.status, 503);
    assert.equal(r.body.code, 'guard_unavailable');
});

test('test: an unsafe pattern is 422 pattern_unsafe with its reason; bad gold is 400', async () => {
    await start();
    const unsafe = await post('/test', {
        type: { id: 'cdt_0123456789', name: 'N', method: 'pattern', tokenKey: 'n', pattern: { source: 'KL(?=-)' } },
        sentences: [{ id: 'a', text: 'KL-1' }],
    });
    assert.equal(unsafe.status, 422);
    assert.equal(unsafe.body.code, 'pattern_unsafe');
    assert.deepEqual(unsafe.body.details, { reason: 're2_unsupported' });
    const badGold = await post('/test', { type: WORDS_TYPE, sentences: [{ id: 'a', text: 'abc', gold: [{ start: 0, end: 9 }] }] });
    assert.equal(badGold.status, 400);
    assert.equal(badGold.body.code, 'invalid_request');
});

test('tune: fewer than 5 marked sentences is 400 tune_needs_gold; with enough it tunes', async () => {
    await start();
    const few = await post('/tune', { type: WORDS_TYPE, sentences: [{ id: 'a', text: 'Falcon', gold: [{ start: 0, end: 6 }] }], examples: [] });
    assert.equal(few.status, 400);
    assert.equal(few.body.code, 'tune_needs_gold');
    assert.deepEqual(few.body.details, { needed: 5, have: 1 });

    const words = ['Falcon', 'FALCON', 'falcon', 'Falcon', 'falcon'];
    const sentences = words.map((w, i) => ({ id: `s${i}`, text: `See ${w} now`, gold: [{ start: 4, end: 4 + w.length }] }));
    const r = await post('/tune', { type: { ...WORDS_TYPE, words: { ...WORDS_TYPE.words, caseSensitive: true } }, sentences, examples: [] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.improved, true);
    assert.equal(r.body.tried, 4);
    assert.equal(r.body.best.config.words.caseSensitive, false);
    assert.deepEqual(r.body.before.summary, { found: 2, total: 5, falseAlarms: 0, sentences: 5 });
});
