/**
 * The App Studio builder's request contract (routes/ai/appStudioBuilder/turnSetup.js).
 *
 * readTurnRequest is what POST /builder/stream answers with before the stream
 * opens, so its refusals are the route's 400s. Two values had a silent default
 * behind them: a `planMode` outside auto/always/never became 'auto', and a
 * `plan` whose action was not exactly 'approve' was no approval — with a
 * message, the turn ran as an ordinary one and dropped the plan the person had
 * just approved.
 *
 * Run: cd server && node --test routes/ai/appStudioBuilder/turnSetup.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Only readTurnRequest runs here; the stores behind the other helpers are inert.
const MOCKS = {
    '../../../stores/studioAppStore': {},
    '../../../stores/studioAppDataStore': {},
    '../../../appStudio/canonicalize': { canonicalizeAppDefinition: (d) => ({ def: d }) },
    '../../../appStudio/componentSpecs': { emptyDefinition: () => ({}) },
    '../../../appStudio/builderTools/appNaming': { briefForNaming: () => '' },
    '../../../appStudio/linkedTables': { describeLinkedTables: async () => new Map(), overlayLinkedRowCounts: (c) => c },
    '../../../core/llm/planChecklist': { normalizePlanTodos: (t) => t },
    '../../../core/llm/screenConstraints': { deriveScreenConstraints: () => null },
    './dataModelEvent': { normalizeRowCounts: () => ({}) },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:turn-setup-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /appStudioBuilder[\\/]turnSetup\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const { readTurnRequest } = require('./turnSetup');
test.after(() => { Module._resolveFilename = originalResolve; });

const turn = (body) => readTurnRequest({ body });
const PNG = 'data:image/png;base64,iVBORw0KGgo=';

test('a planMode outside the three is refused — it used to become "auto"', () => {
    const r = turn({ message: 'Build a CRM', planMode: 'Never' });
    assert.strictEqual(r.failed.status, 400);
    assert.strictEqual(r.failed.body.code, 'invalid_request');
    assert.strictEqual(r.failed.body.error, "planMode is 'auto', 'always' or 'never'.");
    assert.deepStrictEqual(r.failed.body.details.map((d) => d.path), ['body.planMode']);
});

test('an approval with a misspelled action is refused instead of dropped', () => {
    const r = turn({ message: 'go', plan: { planId: 'plan_1', action: 'approved', plan: { title: 'CRM' } } });
    assert.strictEqual(r.failed.status, 400);
    assert.ok(r.failed.body.details.some((d) => d.path === 'body.plan.action'));
});

test('a key the contract does not know is refused rather than ignored', () => {
    const r = turn({ message: 'Build a CRM', tier: 'thinking' });
    assert.strictEqual(r.failed.status, 400);
    assert.strictEqual(r.failed.body.code, 'invalid_request');
});

test('a message that is not text is refused by name', () => {
    const r = turn({ message: { text: 'Build a CRM' } });
    assert.strictEqual(r.failed.status, 400);
    assert.deepStrictEqual(r.failed.body.details.map((d) => d.path), ['body.message']);
});

test('the image gate keeps its own sentence and code', () => {
    const r = turn({ message: 'like this', images: ['not a data url'] });
    assert.deepStrictEqual(r.failed, { status: 400, body: { error: 'That attachment is not a readable image — please attach a PNG, JPEG, WebP or GIF.', code: 'invalid_image' } });
});

test('no message and nothing else is still "Message required"', () => {
    assert.deepStrictEqual(turn({}).failed, { status: 400, body: { error: 'Message required' } });
    assert.deepStrictEqual(turn(undefined).failed, { status: 400, body: { error: 'Message required' } });
});

test('the page\'s ordinary turn reads as before', () => {
    const r = turn({
        message: 'Build a CRM', appId: 'app_1', builderSessionId: 'as_1', modelTier: 'fast',
        context: { screenId: 'scr_1', selectedNodeIds: ['cmp_1'], somethingNew: true },
        planMode: 'never', timezone: 'Europe/Amsterdam',
    });
    assert.strictEqual(r.failed, undefined);
    assert.strictEqual(r.effectiveMessage, 'Build a CRM');
    assert.strictEqual(r.planMode, 'never');
    assert.strictEqual(r.modelTier, 'fast');
    assert.deepStrictEqual(r.editorContext, { screenId: 'scr_1', selectedNodeIds: ['cmp_1'] }, 'context stays whitelisted, not refused');
});

test('a textless approval is still an approval', () => {
    const r = turn({ appId: 'app_1', modelTier: 'fast', plan: { planId: 'plan_1', action: 'approve', plan: { title: 'CRM' } } });
    assert.strictEqual(r.isApproval, true);
    assert.strictEqual(r.effectiveMessage, 'Build the approved plan.');
    assert.deepStrictEqual(r.planApproval.plan, { title: 'CRM' });
});

test('a continuation and an image-only turn still need no text', () => {
    assert.strictEqual(turn({ appId: 'app_1', continueToken: 'cont_1' }).effectiveMessage, 'Continue with the next phase of the approved plan.');
    const img = turn({ images: [PNG] });
    assert.strictEqual(img.effectiveMessage, 'Look at the image(s) I attached.');
    assert.strictEqual(img.inboundImages.length, 1);
    assert.strictEqual(turn({ message: 'x' }).planMode, 'auto', 'absent is still auto');
});
