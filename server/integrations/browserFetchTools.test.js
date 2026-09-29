'use strict';

/**
 * Unit tests for the browse_web tool (interactive Playwright browser).
 *
 * Run: node --test integrations/browserFetchTools.test.js
 *
 * `runBrowseTask` is lazily required from `../services/browserAgentDriver`
 * inside executeBrowseWebTool, so we stub that module via require.cache (same
 * trick as afasTools.test.js) before requiring
 * the module under test — no real browser/LLM/network involved.
 */

const { test } = require('node:test');
const assert = require('assert');

// ── Stub ../services/browserAgentDriver ─────────────────────────────────────
// `runImpl` is reassigned per test case to script different behaviors
// (ok / empty / error / timeout / a manually-controlled deferred promise).
let runImpl = async () => ({ status: 'ok', answer: 'default stub answer that is long enough', visitedUrls: [], steps: 1 });
const driverPath = require.resolve('../services/browserAgentDriver');
require.cache[driverPath] = {
    id: driverPath,
    filename: driverPath,
    loaded: true,
    exports: {
        runBrowseTask: (...args) => runImpl(...args),
    },
};

const browseWebToolsPath = require.resolve('./browserFetchTools');
const { BROWSE_WEB_TOOLS, isBrowseWebTool, executeBrowseWebTool } = require('./browserFetchTools');

function makeSendRecorder() {
    const calls = [];
    const send = (type, data) => calls.push({ type, data });
    return { send, calls };
}

function makeDeferred() {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

// ── BROWSE_WEB_TOOLS shape ──────────────────────────────────────────────────

test('BROWSE_WEB_TOOLS: one OpenAI-function-calling tool named browse_web, requiring task', () => {
    assert.strictEqual(BROWSE_WEB_TOOLS.length, 1);
    const tool = BROWSE_WEB_TOOLS[0];
    assert.strictEqual(tool.type, 'function');
    assert.strictEqual(tool.function.name, 'browse_web');
    assert.ok(tool.function.parameters.properties.task, 'has a task parameter');
    assert.ok(tool.function.parameters.properties.url, 'has a url parameter');
    assert.ok(tool.function.parameters.required.includes('task'), 'task is required');
});

// ── isBrowseWebTool ─────────────────────────────────────────────────────────

test('isBrowseWebTool: true only for browse_web', () => {
    assert.strictEqual(isBrowseWebTool('browse_web'), true);
    assert.strictEqual(isBrowseWebTool('agent_search'), false);
    assert.strictEqual(isBrowseWebTool('browse_website'), false);
    assert.strictEqual(isBrowseWebTool(''), false);
    assert.strictEqual(isBrowseWebTool(undefined), false);
    assert.strictEqual(isBrowseWebTool(null), false);
});

// ── executeBrowseWebTool: validation ────────────────────────────────────────

test('executeBrowseWebTool: unknown tool name returns an error', async () => {
    const r = await executeBrowseWebTool('some_other_tool', { task: 'x' });
    assert.deepStrictEqual(r, { error: 'Unknown tool: some_other_tool' });
});

test('executeBrowseWebTool: missing task AND url returns an error, without calling the driver', async () => {
    let called = false;
    runImpl = async () => { called = true; return { status: 'ok', answer: 'x'.repeat(40), visitedUrls: [], steps: 1 }; };

    assert.deepStrictEqual(await executeBrowseWebTool('browse_web', {}), { error: 'task is required' });
    assert.deepStrictEqual(await executeBrowseWebTool('browse_web', { task: '', url: '' }), { error: 'task is required' });
    assert.deepStrictEqual(await executeBrowseWebTool('browse_web', undefined), { error: 'task is required' });
    assert.strictEqual(called, false, 'driver is never reached when both task and url are missing');
});

test('executeBrowseWebTool: a url with no task is allowed (reads the page)', async () => {
    let seenArgs;
    runImpl = async (args) => { seenArgs = args; return { status: 'ok', answer: 'Read the page content, plenty long.', visitedUrls: ['https://u.example.com/'], steps: 2 }; };
    const r = await executeBrowseWebTool('browse_web', { url: 'https://u.example.com' });
    assert.strictEqual(seenArgs.startUrl, 'https://u.example.com');
    assert.ok(r.includes('Read the page content'), r);
});

// ── executeBrowseWebTool: success path ──────────────────────────────────────

test('executeBrowseWebTool: success returns the answer plus a Pages-read source list', async () => {
    runImpl = async (args) => {
        assert.strictEqual(args.task, 'summarize this');
        assert.strictEqual(args.startUrl, 'https://ok.example.com');
        return {
            status: 'ok',
            answer: 'The page explains the topic in enough detail to exceed the threshold.',
            visitedUrls: ['https://ok.example.com/', 'https://ok.example.com/more'],
            steps: 4,
        };
    };
    const r = await executeBrowseWebTool('browse_web', { task: 'summarize this', url: 'https://ok.example.com' });
    assert.ok(r.includes('The page explains the topic'), r);
    assert.ok(r.includes('**Pages read:**'), r);
    assert.ok(r.includes('- https://ok.example.com/more'), r);
    assert.ok(r.includes('Read live via a headless browser'), r);
});

test('executeBrowseWebTool: timeout status appends a partial-result note', async () => {
    runImpl = async () => ({ status: 'timeout', answer: 'Partial content gathered before the time limit hit.', visitedUrls: ['https://slow.example.com/'], steps: 8 });
    const r = await executeBrowseWebTool('browse_web', { task: 't', url: 'https://slow.example.com' });
    assert.ok(r.includes('Partial content gathered'), r);
    assert.ok(r.includes('stopped at its time limit'), r);
});

// ── executeBrowseWebTool: empty-content path ────────────────────────────────

test('executeBrowseWebTool: empty status returns a plain "almost no readable content" string', async () => {
    runImpl = async () => ({ status: 'empty', answer: '', visitedUrls: ['https://empty.example.com/'], steps: 3 });
    const r = await executeBrowseWebTool('browse_web', { task: 't', url: 'https://empty.example.com' });
    assert.ok(r.includes('almost no readable content'), r);
    assert.ok(!r.includes('**Pages read:**'), 'not the success wrapper');
});

test('executeBrowseWebTool: ok status but sub-threshold answer is treated as empty', async () => {
    runImpl = async () => ({ status: 'ok', answer: 'too short', visitedUrls: [], steps: 1 });
    const r = await executeBrowseWebTool('browse_web', { task: 't', url: 'https://short.example.com' });
    assert.ok(r.includes('almost no readable content'), r);
});

// ── executeBrowseWebTool: error path ────────────────────────────────────────

test('executeBrowseWebTool: driver error status is surfaced as a failure string', async () => {
    runImpl = async () => ({ status: 'error', answer: '', visitedUrls: [], steps: 0, error: 'no_provider_for_model' });
    const r = await executeBrowseWebTool('browse_web', { task: 't', url: 'https://fails.example.com' });
    assert.ok(r.startsWith('Could not complete the browse task:'), r);
    assert.ok(r.includes('no_provider_for_model'), r);
});

test('executeBrowseWebTool: a thrown driver error is caught and surfaced', async () => {
    runImpl = async () => { throw new Error('boom in the driver'); };
    const r = await executeBrowseWebTool('browse_web', { task: 't', url: 'https://throw.example.com' });
    assert.ok(r.startsWith('Could not complete the browse task:'), r);
    assert.ok(r.includes('boom in the driver'), r);
});

// ── executeBrowseWebTool: context.send lifecycle + frame/action forwarding ──

test('send callback: session_start then session_end on success, same sessionId', async () => {
    runImpl = async () => ({ status: 'ok', answer: 'A perfectly normal successful browse with content.', visitedUrls: [], steps: 2 });
    const { send, calls } = makeSendRecorder();
    await executeBrowseWebTool('browse_web', { task: 't', url: 'https://ok2.example.com' }, { send });

    const types = calls.map(c => c.type);
    assert.strictEqual(types[0], 'browser_session_start');
    assert.strictEqual(types[types.length - 1], 'browser_session_end');
    assert.ok(calls[0].data.sessionId, 'start carries a sessionId');
    assert.strictEqual(calls[calls.length - 1].data.sessionId, calls[0].data.sessionId);
});

test('send callback: onFrame/onAction are forwarded as browser_frame/browser_action with the sessionId', async () => {
    runImpl = async (args) => {
        // Simulate the driver emitting a frame and an action mid-run.
        args.onAction({ tool: 'pw_navigate', summary: 'pw_navigate · https://x', step: 1 });
        args.onFrame('ZmFrZS1qcGVn');
        return { status: 'ok', answer: 'Content gathered after the simulated frame/action.', visitedUrls: [], steps: 1 };
    };
    const { send, calls } = makeSendRecorder();
    await executeBrowseWebTool('browse_web', { task: 't', url: 'https://frames.example.com' }, { send });

    const frame = calls.find(c => c.type === 'browser_frame');
    const action = calls.find(c => c.type === 'browser_action');
    const start = calls.find(c => c.type === 'browser_session_start');
    assert.ok(frame && frame.data.b64 === 'ZmFrZS1qcGVn', 'frame forwarded with b64');
    assert.ok(action && action.data.tool === 'pw_navigate', 'action forwarded with tool');
    assert.strictEqual(frame.data.sessionId, start.data.sessionId, 'frame carries the session id');
    assert.strictEqual(action.data.sessionId, start.data.sessionId, 'action carries the session id');
});

test('send callback: session_end still fires when the driver throws', async () => {
    runImpl = async () => { throw new Error('driver blew up'); };
    const { send, calls } = makeSendRecorder();
    await executeBrowseWebTool('browse_web', { task: 't', url: 'https://fails2.example.com' }, { send });
    assert.deepStrictEqual(calls.map(c => c.type), ['browser_session_start', 'browser_session_end']);
});

// ── Concurrency queue ───────────────────────────────────────────────────────
// These need a fresh module instance with a small MAX_CONCURRENT, since the
// module reads BROWSER_FETCH_MAX_CONCURRENT/BROWSER_FETCH_MAX_QUEUE_WAIT_MS into
// module-level constants at require time.

test('concurrency: calls beyond MAX_CONCURRENT are queued and resolved once a slot frees', async () => {
    delete require.cache[browseWebToolsPath];
    process.env.BROWSER_FETCH_MAX_CONCURRENT = '1';
    delete process.env.BROWSER_FETCH_MAX_QUEUE_WAIT_MS;
    const mod = require('./browserFetchTools');

    const deferred1 = makeDeferred();
    let runCount = 0;
    runImpl = async () => {
        runCount++;
        if (runCount === 1) return deferred1.promise;
        return { status: 'ok', answer: 'Second browse rendered content, comfortably long.', visitedUrls: [], steps: 1 };
    };

    const rec1 = makeSendRecorder();
    const rec2 = makeSendRecorder();

    const p1 = mod.executeBrowseWebTool('browse_web', { task: 'a', url: 'https://one.example.com' }, { send: rec1.send });
    const p2 = mod.executeBrowseWebTool('browse_web', { task: 'b', url: 'https://two.example.com' }, { send: rec2.send });

    const queuedEvent = rec2.calls.find(c => c.type === 'browser_session_queued');
    assert.ok(queuedEvent, 'second call emits browser_session_queued while a slot is unavailable');
    assert.ok(queuedEvent.data.queuePosition >= 1, 'queuePosition is >= 1');
    assert.ok(!rec2.calls.some(c => c.type === 'browser_session_start'), 'second call has not started yet');

    deferred1.resolve({ status: 'ok', answer: 'First browse rendered content, comfortably long.', visitedUrls: [], steps: 1 });

    const [r1, r2] = await Promise.all([p1, p2]);
    assert.ok(r1.includes('First browse rendered content'), r1);
    assert.ok(r2.includes('Second browse rendered content'), r2);
    assert.ok(rec2.calls.some(c => c.type === 'browser_session_start'), 'second call eventually starts');
    assert.ok(rec2.calls.some(c => c.type === 'browser_session_end'), 'second call eventually ends');

    delete require.cache[browseWebToolsPath];
    delete process.env.BROWSER_FETCH_MAX_CONCURRENT;
});

test('concurrency: exceeding the queue wait time returns a capacity message instead of hanging', async () => {
    delete require.cache[browseWebToolsPath];
    process.env.BROWSER_FETCH_MAX_CONCURRENT = '1';
    process.env.BROWSER_FETCH_MAX_QUEUE_WAIT_MS = '50';
    const mod = require('./browserFetchTools');

    runImpl = async () => new Promise(() => {}); // first call never resolves

    const p1 = mod.executeBrowseWebTool('browse_web', { task: 'a', url: 'https://stuck.example.com' });
    const p2 = mod.executeBrowseWebTool('browse_web', { task: 'b', url: 'https://queued-timeout.example.com' });

    const r2 = await p2;
    assert.ok(r2.includes('at capacity'), r2);
    void p1;

    delete require.cache[browseWebToolsPath];
    delete process.env.BROWSER_FETCH_MAX_CONCURRENT;
    delete process.env.BROWSER_FETCH_MAX_QUEUE_WAIT_MS;
});
