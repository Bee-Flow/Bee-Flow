/**
 * What the reusable-Step routes accept, and what they say when they refuse
 * (routes/step.js).
 *
 * A Step is called by other people's automations and chats, so its sharing
 * flags are an audience, and the coercions around them ran the wrong way:
 * `{"isPublished": "false"}` published it (the text "false" is true), one
 * group sent as a string instead of a list shared it with the whole
 * organisation, and `{"exposeAsTool": "false"}` put it in everyone's chat. What
 * this file pins is the part a caller can act on:
 *
 *   - the 400 NAMES the field (`body.isPublished`), not just "invalid request";
 *   - the message is a sentence;
 *   - the store is never reached, so a refused request changes nothing.
 *
 * Run: cd server && node --test routes/step.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every store write lands in `touched`. A refused request must leave it empty.
const touched = [];
const pass = (req, res, next) => next();

const STEP = { id: 'blk1', userId: 'u1', kind: 'block', organizationId: 'org1', title: 'Normalise VAT', definition: { steps: [] } };

const MOCKS = {
    '../stores/automationStore': {
        getAutomation: async (id) => (id === STEP.id ? { ...STEP } : null),
        createStep: async (p) => { touched.push({ what: 'createStep', args: [p] }); return { id: 'new', ...p }; },
        updateAutomation: async (id, updates) => { touched.push({ what: 'updateAutomation', args: [id, updates] }); return { ...STEP, ...updates }; },
        setStepSharing: async (id, p) => { touched.push({ what: 'setStepSharing', args: [id, p] }); return { ...STEP }; },
        setStepExpose: async (id, on) => { touched.push({ what: 'setStepExpose', args: [id, on] }); return { ...STEP }; },
        getRunSteps: async () => [],
    },
    '../stores/userStore': { getUser: async () => ({ organizationId: 'org1' }) },
    '../automation/validate': { validateDefinition: () => ({ ok: true }) },
    '../automation/portability': { collectPinnedNodes: () => [] },
    '../automation/summarise': { summariseDefinition: () => ({ summary: '' }) },
    '../auth/audience': { resolveAudienceContext: async () => ({ userId: 'u1', orgIds: new Set(['org1']), userGroups: [] }) },
    '../automation/datatableUsageSync': { syncDatatableUsage: async () => {}, purgeDatatableUsage: async () => {} },
    '../core/kb/kbSourceSync': { syncKbSources: async () => {} },
    '../auth/permissions': { requireAuth: pass },
    '../core/entitlements/betaFeatures': { requireBetaFeature: () => pass },
    '../auth': { requireActiveOrgForMutations: () => pass },
    '../core/automationRunner': {
        executeAutomation: async (a, opts) => { touched.push({ what: 'executeAutomation', args: [opts] }); return { id: 'run1' }; },
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:step-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /routes[\\/]step\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./step');
test.after(() => { Module._resolveFilename = originalResolve; });

const { dispatcher } = require('../core/http/routeHarness');

const dispatch = dispatcher(router);

test.beforeEach(() => { touched.length = 0; });

async function refuses(request, field) {
    const res = await dispatch(request);
    assert.strictEqual(res.statusCode, 400, `${request.method} ${request.url} -> ${JSON.stringify(res.body)}`);
    assert.strictEqual(res.body.code, 'invalid_request');
    assert.ok(res.body.details.some((d) => d.path === field),
        `the 400 must name ${field}; it said ${JSON.stringify(res.body.details)}`);
    assert.deepStrictEqual(touched, [], 'a refused request must not reach the store');
    return res;
}

// ═══ PUT /:id/sharing ═══════════════════════════════════════════════

test('"false" as text is refused, not read as true and published', async () => {
    const res = await refuses({ method: 'PUT', url: '/blk1/sharing', body: { isPublished: 'false', sharedGroups: [] } }, 'body.isPublished');
    assert.strictEqual(res.body.error, 'isPublished is true or false.');
});

test('one group sent as a string is refused, not widened to the whole organisation', async () => {
    await refuses({ method: 'PUT', url: '/blk1/sharing', body: { isPublished: true, sharedGroups: 'grp-sales' } }, 'body.sharedGroups');
});

test('a misspelled audience is refused, not published to everyone', async () => {
    await refuses({ method: 'PUT', url: '/blk1/sharing', body: { isPublished: true, sharedGroup: ['grp-sales'] } }, 'body');
});

test('publishing without saying the audience is refused — [] has to be said', async () => {
    const res = await refuses({ method: 'PUT', url: '/blk1/sharing', body: { isPublished: true } }, 'body.sharedGroups');
    assert.match(res.body.error, /^Publishing needs an audience/);
});

test('the three choices the share menu offers still land as sent', async () => {
    for (const body of [
        { isPublished: true, sharedGroups: ['grp-sales'] },
        { isPublished: true, sharedGroups: [] },
        { isPublished: false, sharedGroups: [] },
    ]) {
        touched.length = 0;
        const res = await dispatch({ method: 'PUT', url: '/blk1/sharing', body });
        assert.strictEqual(res.statusCode, 200, JSON.stringify(body));
        assert.deepStrictEqual(touched, [{ what: 'setStepSharing', args: ['blk1', body] }]);
    }
});

// ═══ PUT /:id/expose ════════════════════════════════════════════════

test('"false" as text is refused, not read as "expose it in chat"', async () => {
    await refuses({ method: 'PUT', url: '/blk1/expose', body: { exposeAsTool: 'false' } }, 'body.exposeAsTool');
});

test('an empty body is refused, not read as "withdraw it from chat"', async () => {
    const res = await refuses({ method: 'PUT', url: '/blk1/expose', body: {} }, 'body.exposeAsTool');
    assert.strictEqual(res.body.error, 'exposeAsTool is true or false.');
});

test('the builder\'s toggle still switches it', async () => {
    const res = await dispatch({ method: 'PUT', url: '/blk1/expose', body: { exposeAsTool: false } });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched, [{ what: 'setStepExpose', args: ['blk1', false] }]);
});

// ═══ POST / and PUT /:id ════════════════════════════════════════════

test('a definition sent as text is refused, not swapped for the empty skeleton', async () => {
    const res = await refuses({ method: 'POST', url: '/', body: { title: 'Normalise VAT', definition: '{"steps":[]}' } }, 'body.definition');
    assert.match(res.body.error, /JSON object/);
});

test('a Step without a title is refused in words, not with "Required"', async () => {
    const res = await refuses({ method: 'POST', url: '/', body: {} }, 'body.title');
    assert.strictEqual(res.body.error, 'A Step needs a title.');
});

test('the builder\'s lazy create still starts from the definition it sends', async () => {
    const res = await dispatch({ method: 'POST', url: '/', body: { title: '  Untitled Step  ', definition: { steps: [] } } });
    assert.strictEqual(res.statusCode, 200);
    const args = touched.find((t) => t.what === 'createStep').args[0];
    assert.strictEqual(args.title, 'Untitled Step');
    assert.deepStrictEqual(args.definition, { steps: [] });
});

test('a null definition on update is refused instead of throwing a 500 in the store', async () => {
    await refuses({ method: 'PUT', url: '/blk1', body: { definition: null } }, 'body.definition');
});

test('an update that names nothing to change is refused, not answered with { step: false }', async () => {
    await refuses({ method: 'PUT', url: '/blk1', body: {} }, 'body');
});

test('a category that is too long is refused rather than cut at 60 characters', async () => {
    await refuses({ method: 'PUT', url: '/blk1', body: { category: 'x'.repeat(61) } }, 'body.category');
});

test('what the builder saves on update still arrives — an empty category clears it', async () => {
    const res = await dispatch({ method: 'PUT', url: '/blk1', body: { category: '' } });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched.find((t) => t.what === 'updateAutomation').args[1], { category: null });
    touched.length = 0;
    const icon = await dispatch({ method: 'PUT', url: '/blk1', body: { icon: null } });
    assert.strictEqual(icon.statusCode, 200);
    assert.deepStrictEqual(touched.find((t) => t.what === 'updateAutomation').args[1], { icon: null });
});

// ═══ POST /:id/test ═════════════════════════════════════════════════

test('misspelled sample inputs are refused, not dry-run with no inputs at all', async () => {
    await refuses({ method: 'POST', url: '/blk1/test', body: { input: { amount: 10 } } }, 'body');
});

test('sample inputs still reach the dry run', async () => {
    const res = await dispatch({ method: 'POST', url: '/blk1/test', body: { inputs: { amount: 10 } } });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched.find((t) => t.what === 'executeAutomation').args[0].triggerPayload, { amount: 10 });
});
