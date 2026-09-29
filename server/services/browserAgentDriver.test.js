'use strict';

/**
 * Unit tests for the interactive browse driver (browserAgentDriver.runBrowseTask).
 *
 * Run: node --test services/browserAgentDriver.test.js
 *
 * The driver lazily requires its heavy deps inside runBrowseTask, so we stub
 * them via require.cache before requiring the module under test:
 *   - ../core/modelResolver  → resolveModelForTier (required at top level)
 *   - ../core/providers      → getAdapter (a scripted adapter.chat)
 *   - ../core/aiAgent        → getProviderForModel
 *   - ./browserProvider      → newSharedContext (a fake BrowserContext/Page)
 *   - playwright             → not reached (require('playwright') succeeds since
 *                              it's installed; the driver only uses chromium
 *                              via browserProvider in host mode)
 * No real browser, LLM, or network is involved.
 */

const { test } = require('node:test');
const assert = require('assert');

// ── Scriptable stubs ────────────────────────────────────────────────────────
let scriptedTurns = [];   // array of { toolCalls } the fake adapter returns in order
let turnIndex = 0;
let routeHandler = null;  // captured ctx.route callback
const navHistory = [];    // urls passed to page.goto
let getTextValue = 'Plenty of real page text that comfortably exceeds the twenty character minimum.';

function stub(relPath, exportsObj) {
    const p = require.resolve(relPath);
    require.cache[p] = { id: p, filename: p, loaded: true, exports: exportsObj };
}

stub('../core/llm/modelResolver', { resolveModelForTier: async () => 'claude-sonnet-5' });
stub('../core/providers', {
    getAdapter: () => ({
        chat: async () => {
            const turn = scriptedTurns[turnIndex] || { toolCalls: [{ id: `auto${turnIndex}`, function: { name: 'pw_done', arguments: '{"summary":"done"}' } }] };
            turnIndex += 1;
            return { content: '', toolCalls: turn.toolCalls, stopReason: 'tool_use' };
        },
    }),
});
stub('../core/aiAgent', { getProviderForModel: async () => ({ apiKey: 'k', url: 'https://api.example', providerType: 'anthropic', providerName: 'Test' }) });

// Secure-PDF path stubs. `safeFetchImpl` / `pdfTextImpl` are reassignable per
// test so we can script a good PDF, a non-PDF body, or a fetch failure.
let safeFetchImpl = async () => ({ ok: true, headers: { get: () => null }, arrayBuffer: async () => Buffer.from('%PDF-1.4 fake', 'latin1') });
let pdfTextImpl = async () => 'Extracted PDF body text long enough to be a real answer for the user.';
const safeFetchCalls = [];
stub('../utils/ssrfGuard', {
    // real private-host predicates are needed by the SSRF route handler test
    isPrivateHostname: require('../utils/ssrfGuard').isPrivateHostname,
    isPrivateIp: require('../utils/ssrfGuard').isPrivateIp,
    safeFetch: (...args) => { safeFetchCalls.push(args[0]); return safeFetchImpl(...args); },
});
stub('../core/documents/pdfExtractor', { extractTextFromPDF: (...args) => pdfTextImpl(...args) });

// Fake Playwright page + context. route() captures the SSRF handler so a test
// can invoke it directly; goto records nav; screenshot returns a tiny buffer.
function makeFakePage() {
    return {
        setDefaultTimeout() {},
        async goto(url) { navHistory.push(url); return null; },
        url() { return navHistory[navHistory.length - 1] || 'about:blank'; },
        async title() { return 'Fake Title'; },
        async waitForLoadState() {},
        async waitForTimeout() {},
        accessibility: { async snapshot() { return { role: 'WebArea', name: 'root', children: [] }; } },
        locator() { return { first() { return { async innerText() { return getTextValue; }, async click() {}, async fill() {}, async press() {}, async scrollIntoViewIfNeeded() {} }; } }; },
        getByRole() { return { first() { return { async click() {}, async fill() {}, async press() {} }; } }; },
        async evaluate() {},
        async screenshot() { return Buffer.from([0xff, 0xd8, 0xff]); },
        async close() {},
    };
}
stub('./browserProvider', {
    async newSharedContext() {
        return {
            async route(_pattern, handler) { routeHandler = handler; },
            async newPage() { return makeFakePage(); },
            async close() {},
        };
    },
});

const { runBrowseTask } = require('./browserAgentDriver');

function resetScript() {
    scriptedTurns = [];
    turnIndex = 0;
    navHistory.length = 0;
    routeHandler = null;
    getTextValue = 'Plenty of real page text that comfortably exceeds the twenty character minimum.';
    safeFetchCalls.length = 0;
    safeFetchImpl = async () => ({ ok: true, headers: { get: () => null }, arrayBuffer: async () => Buffer.from('%PDF-1.4 fake', 'latin1') });
    pdfTextImpl = async () => 'Extracted PDF body text long enough to be a real answer for the user.';
}

// ── Happy path: navigate (seed) → get_text + extract → done ──────────────────

test('runBrowseTask: seed nav + extract + done returns the extracted answer, fires onFrame/onAction', async () => {
    resetScript();
    scriptedTurns = [
        { toolCalls: [{ id: 't1', function: { name: 'pw_get_text', arguments: '{}' } }] },
        { toolCalls: [{ id: 't2', function: { name: 'pw_extract', arguments: JSON.stringify({ text: 'The key fact the user asked about, extracted from the page.' }) } }] },
        { toolCalls: [{ id: 't3', function: { name: 'pw_done', arguments: '{"summary":"found it"}' } }] },
    ];

    const frames = [];
    const actions = [];
    const res = await runBrowseTask({
        task: 'find the key fact',
        startUrl: 'https://example.com/article',
        onFrame: (b64) => frames.push(b64),
        onAction: (a) => actions.push(a),
    });

    assert.strictEqual(res.status, 'ok', JSON.stringify(res));
    assert.ok(res.answer.includes('The key fact the user asked about'), res.answer);
    assert.ok(res.visitedUrls.includes('https://example.com/article'), JSON.stringify(res.visitedUrls));
    assert.ok(frames.length >= 1, 'at least one frame emitted (after seed nav)');
    assert.ok(actions.some(a => a.tool === 'pw_get_text'), 'actions include pw_get_text');
    assert.ok(navHistory.includes('https://example.com/article'), 'seed navigation happened');
});

// ── Answer comes from pw_get_text via the model deciding to extract it ───────

test('runBrowseTask: no startUrl — model navigates itself, then extracts', async () => {
    resetScript();
    scriptedTurns = [
        { toolCalls: [{ id: 'n1', function: { name: 'pw_navigate', arguments: JSON.stringify({ url: 'https://public.example.org/' }) } }] },
        { toolCalls: [{ id: 'x1', function: { name: 'pw_extract', arguments: JSON.stringify({ text: 'Extracted content that is definitely long enough to be a real answer.' }) } }] },
        { toolCalls: [{ id: 'd1', function: { name: 'pw_done', arguments: '{}' } }] },
    ];
    const res = await runBrowseTask({ task: 'research X' });
    assert.strictEqual(res.status, 'ok');
    assert.ok(res.answer.includes('Extracted content'), res.answer);
    assert.ok(res.visitedUrls.includes('https://public.example.org/'), JSON.stringify(res.visitedUrls));
});

// ── Empty result when nothing was extracted ──────────────────────────────────

test('runBrowseTask: done with no extraction yields status "empty"', async () => {
    resetScript();
    scriptedTurns = [
        { toolCalls: [{ id: 'd1', function: { name: 'pw_done', arguments: '{"summary":"nothing useful"}' } }] },
    ];
    const res = await runBrowseTask({ task: 't', startUrl: 'https://example.com/' });
    assert.strictEqual(res.status, 'empty', JSON.stringify(res));
});

// ── SSRF: the captured route handler aborts private hosts, allows public ─────

test('runBrowseTask: ctx.route SSRF handler aborts private/loopback hosts and non-http', async () => {
    resetScript();
    scriptedTurns = [{ toolCalls: [{ id: 'd1', function: { name: 'pw_done', arguments: '{}' } }] }];
    await runBrowseTask({ task: 't', startUrl: 'https://example.com/' });
    assert.ok(typeof routeHandler === 'function', 'a route handler was registered');

    const results = [];
    const makeRoute = (url) => ({
        request: () => ({ url: () => url }),
        abort: (reason) => results.push({ url, action: 'abort', reason }),
        continue: () => results.push({ url, action: 'continue' }),
    });

    await routeHandler(makeRoute('https://public-site.com/page'));
    await routeHandler(makeRoute('http://169.254.169.254/latest/meta-data/'));
    await routeHandler(makeRoute('http://127.0.0.1:8000/'));
    await routeHandler(makeRoute('http://10.0.0.5/'));
    await routeHandler(makeRoute('file:///etc/passwd'));

    const byUrl = Object.fromEntries(results.map(r => [r.url, r.action]));
    assert.strictEqual(byUrl['https://public-site.com/page'], 'continue', 'public host allowed');
    assert.strictEqual(byUrl['http://169.254.169.254/latest/meta-data/'], 'abort', 'cloud metadata blocked');
    assert.strictEqual(byUrl['http://127.0.0.1:8000/'], 'abort', 'loopback blocked');
    assert.strictEqual(byUrl['http://10.0.0.5/'], 'abort', 'private range blocked');
    assert.strictEqual(byUrl['file:///etc/passwd'], 'abort', 'non-http scheme blocked');
});

// ── Cross-origin navigation is allowed (unlike the QA driver) ────────────────

test('runBrowseTask: navigating to a different public origin is allowed', async () => {
    resetScript();
    scriptedTurns = [
        { toolCalls: [{ id: 'n1', function: { name: 'pw_navigate', arguments: JSON.stringify({ url: 'https://another-domain.com/' }) } }] },
        { toolCalls: [{ id: 'x1', function: { name: 'pw_extract', arguments: JSON.stringify({ text: 'Content read from a different domain, long enough to be an answer.' }) } }] },
        { toolCalls: [{ id: 'd1', function: { name: 'pw_done', arguments: '{}' } }] },
    ];
    const res = await runBrowseTask({ task: 't', startUrl: 'https://start.example.com/' });
    assert.strictEqual(res.status, 'ok');
    assert.ok(res.visitedUrls.includes('https://another-domain.com/'), 'followed a cross-origin link');
});

// ── Secure PDF reading ───────────────────────────────────────────────────────

test('runBrowseTask: a .pdf start URL is read via safeFetch + pdfExtractor (no page.goto), text handed to the model', async () => {
    resetScript();
    pdfTextImpl = async () => 'The compilation standard requires the file to be assembled within 60 days of the report date.';
    scriptedTurns = [
        { toolCalls: [{ id: 'x1', function: { name: 'pw_extract', arguments: JSON.stringify({ text: 'Standard 4410 requires assembly within 60 days.' }) } }] },
        { toolCalls: [{ id: 'd1', function: { name: 'pw_done', arguments: '{"summary":"read the pdf"}' } }] },
    ];
    const res = await runBrowseTask({ task: 'what does this say', startUrl: 'https://example.com/docs/standaard-4410.pdf' });

    assert.strictEqual(res.status, 'ok', JSON.stringify(res));
    assert.ok(res.answer.includes('60 days'), res.answer);
    assert.ok(safeFetchCalls.includes('https://example.com/docs/standaard-4410.pdf'), 'safeFetch was used for the PDF');
    assert.ok(!navHistory.includes('https://example.com/docs/standaard-4410.pdf'), 'no browser navigation to the PDF (it is downloaded/parsed, not rendered)');
    assert.ok(res.visitedUrls.includes('https://example.com/docs/standaard-4410.pdf'), 'the PDF url is recorded as a source');
});

test('runBrowseTask: pw_navigate to a PDF mid-loop returns kind:pdf text the model can extract', async () => {
    resetScript();
    pdfTextImpl = async () => 'Body of a PDF discovered by following a link; plenty long for an answer.';
    scriptedTurns = [
        { toolCalls: [{ id: 'n1', function: { name: 'pw_navigate', arguments: JSON.stringify({ url: 'https://files.example.com/report' }) } }] }, // no .pdf suffix
        { toolCalls: [{ id: 'x1', function: { name: 'pw_extract', arguments: JSON.stringify({ text: 'Key figure from the linked PDF report.' }) } }] },
        { toolCalls: [{ id: 'd1', function: { name: 'pw_done', arguments: '{}' } }] },
    ];
    // No .pdf suffix, so goto is attempted first; simulate the download-start throw.
    const badGotoPage = () => {
        const p = makeFakePage();
        p.goto = async (url) => { navHistory.push(url); throw new Error('page.goto: Download is starting'); };
        return p;
    };
    // Swap the context to return a page whose goto throws the download error.
    require.cache[require.resolve('./browserProvider')].exports.newSharedContext = async () => ({
        async route(_p, h) { routeHandler = h; },
        async newPage() { return badGotoPage(); },
        async close() {},
    });

    const res = await runBrowseTask({ task: 'read the report', startUrl: null });
    assert.strictEqual(res.status, 'ok', JSON.stringify(res));
    assert.ok(res.answer.includes('Key figure'), res.answer);
    assert.ok(safeFetchCalls.includes('https://files.example.com/report'), 'download-start fell back to safeFetch PDF read');

    // Restore the normal fake context for later tests.
    require.cache[require.resolve('./browserProvider')].exports.newSharedContext = async () => ({
        async route(_p, h) { routeHandler = h; },
        async newPage() { return makeFakePage(); },
        async close() {},
    });
});

test('runBrowseTask: a non-PDF body at a .pdf URL surfaces an error, not fake content', async () => {
    resetScript();
    safeFetchImpl = async () => ({ ok: true, headers: { get: () => null }, arrayBuffer: async () => Buffer.from('<html>not a pdf</html>', 'latin1') });
    scriptedTurns = [
        { toolCalls: [{ id: 'd1', function: { name: 'pw_done', arguments: '{"summary":"could not read"}' } }] },
    ];
    const res = await runBrowseTask({ task: 't', startUrl: 'https://example.com/fake.pdf' });
    // Nothing extractable → empty; the seed note carried the read error, model gave up.
    assert.strictEqual(res.status, 'empty', JSON.stringify(res));
});
