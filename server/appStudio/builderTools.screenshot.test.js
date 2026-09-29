/**
 * Unit tests for the app_screenshot builder tool (appStudio/builderTools.js).
 *
 * The render service (services/appStudioRender) and studioAppStore are mocked
 * via the Module._resolveFilename harness (same pattern as builderTools.test.js)
 * — no browser and no DB pool. What's under test is the tool's CONTRACT with
 * the route: string `content` for the model, the `_screenshotDataUrl` side
 * channel for the image, the per-turn cap, and every unavailable path
 * degrading to a readable sentence instead of an error/throw.
 *
 * Run: node --test appStudio/builderTools.screenshot.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// ── Mock render service (swappable per test) ────────────────────────

const renderState = {
    calls: [],
    result: null,       // what renderAppScreenshot resolves to
    throwWith: null,    // when set, renderAppScreenshot throws this message
};
const mockRenderService = {
    renderAppScreenshot: async (input) => {
        renderState.calls.push(input);
        if (renderState.throwWith) throw new Error(renderState.throwWith);
        return renderState.result;
    },
};

// ── Mock studio app store — only the owner lookup the tool uses ─────

const APP_ROW = { id: 'app-1', userId: 'u1', organizationId: null, name: 'Test app', definitionVersion: 3 };
const storeState = { failGet: false };
const mockStudioAppStore = {
    async getStudioApp(id) {
        if (storeState.failGet) throw new Error('store down');
        return id === APP_ROW.id ? { ...APP_ROW } : null;
    },
};

// ── Require-cache injection (before builderTools loads) ─────────────

const MOCKS = {
    '../../services/appStudioRender': mockRenderService,
    '../../stores/studioAppStore': mockStudioAppStore,
};
const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) return MOCK_IDS[request];
    return originalResolve.call(this, request, parent, ...rest);
};

const { applyToolCall, TOOL_SCHEMAS, MUTATING_TOOLS, _test } = require('./builderTools');
const { emptyDefinition } = require('./componentSpecs');

// Derived, never transcribed: the cap moved 3 → 8 once and these tests were
// the only thing pinning the old number in three places.
const CAP = _test.MAX_SCREENSHOTS_PER_TURN;

const PNG_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';

function okShot(extra = {}) {
    return {
        ok: true,
        png: Buffer.from('fake'),
        dataUrl: PNG_URL,
        width: 1280,
        height: 800,
        mountError: null,
        consoleErrors: [],
        pageErrors: [],
        ...extra,
    };
}

function savedWrap({ vision = true } = {}) {
    return {
        userId: 'u1', orgId: null, appId: 'app-1', version: 3,
        builderSessionId: 'bs_test', def: emptyDefinition('Test app'),
        dataModel: { tables: [], roles: [] }, dataModelVersion: 1,
        rowCounts: {}, datasetIds: [],
        modelSupportsVision: vision,
    };
}

test.beforeEach(() => {
    renderState.calls = [];
    renderState.result = okShot();
    renderState.throwWith = null;
    storeState.failGet = false;
    // A deleted export simulates "service not shipped" — restore it here.
    mockRenderService.renderAppScreenshot = mockRenderService.renderAppScreenshot
        || (async (input) => {
            renderState.calls.push(input);
            if (renderState.throwWith) throw new Error(renderState.throwWith);
            return renderState.result;
        });
});

// ── Schema surface ──────────────────────────────────────────────────

test('app_screenshot is declared in TOOL_SCHEMAS with screenId/asRole/viewport, all optional', () => {
    const schema = TOOL_SCHEMAS.find((t) => t.function.name === 'app_screenshot');
    assert.ok(schema, 'schema present');
    assert.deepStrictEqual(Object.keys(schema.function.parameters.properties).sort(), ['asRole', 'screenId', 'viewport']);
    // The renderer's three presets, and only those: a free-form {width,height}
    // would let a builder shoot a 1×20000 strip and call it a screen.
    assert.deepStrictEqual(schema.function.parameters.properties.viewport.enum, ['desktop', 'tablet', 'mobile']);
    assert.ok(!schema.function.parameters.required, 'no required params — bare calls render the home screen');
    // Read tool — never persists, never emits a draft.
    assert.ok(!MUTATING_TOOLS.has('app_screenshot'));
});

test('viewport reaches the renderer, and an unknown one falls back to desktop', async () => {
    const wrap = savedWrap();
    await applyToolCall('app_screenshot', { viewport: 'mobile' }, wrap);
    assert.strictEqual(renderState.calls.at(-1).viewport, 'mobile');

    await applyToolCall('app_screenshot', { viewport: 'watch' }, wrap);
    assert.strictEqual(renderState.calls.at(-1).viewport, 'desktop', 'a bogus preset must not reach the browser');

    const bare = await applyToolCall('app_screenshot', {}, wrap);
    assert.strictEqual(renderState.calls.at(-1).viewport, 'desktop');
    // The width is stated back to the model: a screenshot it cannot place is
    // one it will misread.
    assert.match(bare.content, /desktop width/);
});

// ── Success path ────────────────────────────────────────────────────

test('success: string content for the model + the image on the side channel', async () => {
    const wrap = savedWrap();
    const r = await applyToolCall('app_screenshot', {}, wrap);

    assert.ok(!r.error, JSON.stringify(r).slice(0, 300));
    assert.strictEqual(typeof r.content, 'string', 'model-facing content is a plain string');
    assert.match(r.content, /1280×800/);
    assert.match(r.content, /LOOK at it/, 'vision model is told to inspect the attached image');
    assert.match(r.content, /No render errors detected/);
    assert.strictEqual(r._screenshotDataUrl, PNG_URL, 'image travels on the side channel, not in content');
    assert.ok(!r.content.includes('base64'), 'no base64 leaks into the model text');
    assert.match(r._screenshotCaption, /^Screenshot · /);

    // The render got the live draft, the persisted app row and the data model.
    assert.strictEqual(renderState.calls.length, 1);
    const call = renderState.calls[0];
    assert.strictEqual(call.definition, wrap.def);
    assert.strictEqual(call.model, wrap.dataModel);
    assert.strictEqual(call.app.id, 'app-1');
    assert.strictEqual(call.screenId, null);
    assert.strictEqual(call.asRole, null);
});

test('screenId + asRole pass through and show up in content and caption', async () => {
    const wrap = savedWrap();
    const scr = wrap.def.screens[0];
    const r = await applyToolCall('app_screenshot', { screenId: scr.id, asRole: 'member' }, wrap);

    assert.ok(r._screenshotDataUrl);
    assert.strictEqual(renderState.calls[0].screenId, scr.id);
    assert.strictEqual(renderState.calls[0].asRole, 'member');
    assert.match(r.content, new RegExp(`"${scr.name || scr.id}"`));
    assert.match(r.content, /as role "member"/);
    assert.match(r._screenshotCaption, /· as member$/);
});

test('a blind model is told the user saw the screenshot instead', async () => {
    const r = await applyToolCall('app_screenshot', {}, savedWrap({ vision: false }));
    assert.match(r.content, /cannot see images/);
    assert.match(r.content, /shown to the user/);
    assert.ok(r._screenshotDataUrl, 'the image still ships — the USER sees it regardless');
});

test('render diagnostics (mount/page/console errors) are relayed in the content', async () => {
    renderState.result = okShot({
        mountError: 'mount() rejected: boom',
        pageErrors: ['ReferenceError: x is not defined'],
        consoleErrors: ['Failed to render chart'],
    });
    const r = await applyToolCall('app_screenshot', {}, savedWrap());
    assert.match(r.content, /Mount error: mount\(\) rejected: boom/);
    assert.match(r.content, /Runtime errors \(1\)/);
    assert.match(r.content, /Console errors \(1\)/);
    assert.ok(!/No render errors detected/.test(r.content));
});

// ── Unavailable paths — always a readable sentence, never error/throw ──

test('an unavailable render collapses to a plain sentence with the reason', async () => {
    renderState.result = { ok: false, unavailable: true, reason: 'the app runtime bundle is not in this build' };
    const r = await applyToolCall('app_screenshot', {}, savedWrap());
    assert.ok(!r.error, 'unavailability is not a tool ERROR — it must not trigger fix-loops');
    assert.match(r.content, /No screenshot: the app runtime bundle is not in this build/);
    assert.ok(!r._screenshotDataUrl);
});

test('a throwing render service degrades the same way (belt-and-braces)', async () => {
    renderState.throwWith = 'browser exploded';
    const r = await applyToolCall('app_screenshot', {}, savedWrap());
    assert.ok(!r.error);
    assert.match(r.content, /No screenshot: browser exploded/);
});

test('a missing render service module reads as "not available in this deployment"', async () => {
    delete mockRenderService.renderAppScreenshot;
    const r = await applyToolCall('app_screenshot', {}, savedWrap());
    assert.ok(!r.error);
    assert.match(r.content, /not available in this deployment/);
    assert.strictEqual(renderState.calls.length, 0);
});

test('a never-saved draft is refused readably without touching the browser edge', async () => {
    const wrap = savedWrap();
    wrap.appId = null;
    const r = await applyToolCall('app_screenshot', {}, wrap);
    assert.ok(!r.error);
    assert.match(r.content, /has not been saved/);
    assert.strictEqual(renderState.calls.length, 0, 'no render attempted');
});

test('a failing app-store lookup still renders (app degrades to null)', async () => {
    storeState.failGet = true;
    const r = await applyToolCall('app_screenshot', {}, savedWrap());
    assert.ok(r._screenshotDataUrl, JSON.stringify(r).slice(0, 300));
    assert.strictEqual(renderState.calls[0].app, null);
});

// ── Per-turn cap ────────────────────────────────────────────────────

test('the cap is 8 — four before/after pairs, not a diagnosis-killing 3', () => {
    // The number itself is the contract here. Three renders bought ONE
    // confirmed fix (look → change → look) and half of a second; a real
    // session ran out mid-diagnosis and concluded, from the half it never
    // rechecked, that the platform could not do live form binding.
    assert.strictEqual(CAP, 8);
});

test('the per-turn cap stops the call after the budget without touching the renderer', async () => {
    const wrap = savedWrap();
    for (let i = 0; i < CAP; i++) {
        const r = await applyToolCall('app_screenshot', {}, wrap);
        assert.ok(r._screenshotDataUrl, `screenshot ${i + 1} renders`);
    }
    const capped = await applyToolCall('app_screenshot', {}, wrap);
    assert.ok(!capped.error);
    assert.match(capped.content, new RegExp(`all ${CAP} screenshots for this turn`));
    assert.ok(!capped._screenshotDataUrl);
    assert.strictEqual(renderState.calls.length, CAP, 'the capped call never reached the renderer');
});

/**
 * The cap message is a HANDOVER, not a reprimand. The model reads it mid-build
 * and the wording decides what it does next: "limit reached" reads as a wall
 * and invites either a retry or an abandoned verification, while a stated
 * refill plus a concrete next move keeps the loop going. It must therefore say
 * the budget comes back, and must not scold.
 */
test('the cap message hands over to the next turn instead of scolding', async () => {
    const wrap = savedWrap();
    for (let i = 0; i < CAP; i++) await applyToolCall('app_screenshot', {}, wrap);
    const { content } = await applyToolCall('app_screenshot', {}, wrap);
    assert.match(content, /refills on the next one/, 'the budget is stated as renewable');
    assert.match(content, /nothing is lost/, 'the model is told this is not a failure');
    assert.match(content, /Keep building/, 'it names the next move');
    assert.ok(!/limit reached|too many|you have used/i.test(content), 'no cutoff/scolding framing');
});

test('a failed render still consumes the cap (retry storms stay bounded)', async () => {
    const wrap = savedWrap();
    renderState.result = { ok: false, unavailable: true, reason: 'no browser' };
    for (let i = 0; i < CAP; i++) await applyToolCall('app_screenshot', {}, wrap);
    const capped = await applyToolCall('app_screenshot', {}, wrap);
    assert.match(capped.content, new RegExp(`all ${CAP} screenshots`));
    assert.strictEqual(renderState.calls.length, CAP);
});
