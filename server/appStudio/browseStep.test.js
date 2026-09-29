/**
 * ai_browse step — the gate chain and the allowlist intersection.
 * executeBrowseWebTool + the integration-permission lookup are stubbed; this
 * test is about WHICH requests reach the browser and with what confinement.
 *
 * Run: cd server && node --test appStudio/browseStep.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

function stub(path, exports) {
    const filename = require.resolve(path);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

// `permitted` is the answer to "may THIS ONE app run", not a palette set.
// It used to stub getUserPermittedApps with `new Set(['browser-fetch'])` — a
// value that function is structurally incapable of returning, because it only
// ever returns apps present in TOOL_REGISTRY and browse_web is registered
// inline. The stub was therefore green while the real gate refused every user
// on every deployment. Stub the single-app check the step actually calls.
const env = { permitted: true, backend: true, browseCalls: [], gateCalls: [] };

stub('../core/integrations/integrationTools', {
    isIntegrationPermittedForUser: async ({ userId, appId }) => {
        env.gateCalls.push({ userId, appId });
        return env.permitted;
    },
});
stub('../services/pwtRunner', { dockerAvailable: async () => env.backend });
stub('../integrations/browserFetchTools', {
    executeBrowseWebTool: async (name, args, ctx) => {
        env.browseCalls.push({ args, allowedHosts: ctx.allowedHosts, maxSteps: ctx.maxSteps });
        // The real tool returns a markdown string with a Pages read: block.
        return `Found it.\n\n---\n**Pages read:**\n- https://example.com/a\n- https://example.com/b`;
    },
});
stub('../stores/usageStore', { logUsage: async () => {} });
stub('../stores/integrationActivityStore', { logIntegrationActivity: async () => {} });

const { executeBrowseStep, effectiveAllowlist } = require('./browseStep');

const HELPERS = {
    resolveBinding: (b) => (b && typeof b === 'object' && 'value' in b ? b.value : b),
    buildServerScope: () => ({}),
};
const APP = { id: 'app-1', userId: 'owner-1', organizationId: 'org-1' };
const S = (value) => ({ kind: 'static', value });

function ctx(extra = {}) {
    return { viewerId: 'viewer-1', actionId: 'act-1', browse: { send: () => {}, isCancelled: () => false }, ...extra };
}

test.beforeEach(() => {
    env.permitted = true;
    env.backend = true;
    env.browseCalls.length = 0;
    env.gateCalls.length = 0;
});

test('effectiveAllowlist: app ∩ step, subdomain-aware, empty app = unconfined', () => {
    assert.strictEqual(effectiveAllowlist(null, null), null, 'nothing set = org-open');
    assert.deepStrictEqual(effectiveAllowlist(['example.com'], null), ['example.com']);
    assert.deepStrictEqual(effectiveAllowlist(null, ['a.com']), ['a.com']);
    // step narrows within app scope
    assert.deepStrictEqual(effectiveAllowlist(['example.com'], ['docs.example.com']), ['docs.example.com']);
    // step tries to escape app scope → dropped (empty result = confined out)
    assert.deepStrictEqual(effectiveAllowlist(['example.com'], ['evil.com']), []);
});

test('happy path: enabled app reaches the browser with the effective allowlist', async () => {
    const def = { aiBrowsing: { enabled: true, allowedDomains: ['example.com'] } };
    const step = { kind: 'ai_browse', task: S('find the price'), url: S('https://example.com'), allowedDomains: ['docs.example.com'], maxSteps: 6, resultVar: 'r' };
    const r = await executeBrowseStep(APP, def, step, ctx(), HELPERS);
    assert.strictEqual(r.ok, true);
    assert.match(r.result.answer, /Found it/);
    assert.deepStrictEqual(r.result.visitedUrls, ['https://example.com/a', 'https://example.com/b']);
    assert.strictEqual(env.browseCalls.length, 1);
    assert.deepStrictEqual(env.browseCalls[0].allowedHosts, ['docs.example.com']);
    assert.strictEqual(env.browseCalls[0].maxSteps, 6);
    assert.strictEqual(env.browseCalls[0].args.task, 'find the price');
});

test('gate 1: a disabled app never reaches the browser', async () => {
    const r = await executeBrowseStep(APP, { aiBrowsing: { enabled: false } }, { kind: 'ai_browse', task: S('x'), resultVar: 'r' }, ctx(), HELPERS);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'browse_not_enabled');
    assert.strictEqual(env.browseCalls.length, 0);
    // Absent aiBrowsing entirely = also refused.
    const r2 = await executeBrowseStep(APP, {}, { kind: 'ai_browse', task: S('x'), resultVar: 'r' }, ctx(), HELPERS);
    assert.strictEqual(r2.code, 'browse_not_enabled');
});

test('gate 2: the org kill switch (owner lacks browser-fetch) refuses', async () => {
    env.permitted = false; // browser-fetch turned off for the workspace
    const def = { aiBrowsing: { enabled: true } };
    const r = await executeBrowseStep(APP, def, { kind: 'ai_browse', task: S('x'), resultVar: 'r' }, ctx(), HELPERS);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'browse_disabled');
    assert.strictEqual(env.browseCalls.length, 0);
});

test('gate 2 asks about browser-fetch for the OWNER, not the viewer', async () => {
    const def = { aiBrowsing: { enabled: true } };
    await executeBrowseStep(APP, def, { kind: 'ai_browse', task: S('x'), resultVar: 'r' }, ctx(), HELPERS);
    // App Studio AI acts as the owner; a viewer who cannot browse must not be
    // the one asked, and the owner who can must not be bypassed.
    assert.deepStrictEqual(env.gateCalls, [{ userId: APP.userId, appId: 'browser-fetch' }]);
});

test('gate 3: no browser backend refuses cleanly', async () => {
    env.backend = false;
    const def = { aiBrowsing: { enabled: true } };
    const r = await executeBrowseStep(APP, def, { kind: 'ai_browse', task: S('x'), resultVar: 'r' }, ctx(), HELPERS);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'browse_no_backend');
});

test('a step that confines itself outside the app scope is refused before launch', async () => {
    const def = { aiBrowsing: { enabled: true, allowedDomains: ['example.com'] } };
    const step = { kind: 'ai_browse', task: S('x'), allowedDomains: ['evil.com'], resultVar: 'r' };
    const r = await executeBrowseStep(APP, def, step, ctx(), HELPERS);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'browse_domains_empty');
    assert.strictEqual(env.browseCalls.length, 0);
});

test('empty task and url is refused', async () => {
    const def = { aiBrowsing: { enabled: true } };
    const r = await executeBrowseStep(APP, def, { kind: 'ai_browse', task: S('  '), resultVar: 'r' }, ctx(), HELPERS);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'browse_no_task');
});
