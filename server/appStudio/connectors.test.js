/**
 * App Studio connectors — acts-as-owner model, ownership gate, REST SSRF/cap.
 *
 * Pure-module tests: connectors.js takes an injectable `_deps` seam so we can
 * stub executeTool / executeAutomation / getAutomation / safeFetch / the owner
 * session without touching the require cache. The REST SSRF + https + allowlist
 * screens run BEFORE any fetch, so those use the REAL utils/isPrivateTarget.
 *
 * Run: cd server && node --test appStudio/connectors.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

// Short REST timeout so the body-read timeout test is fast (read at load).
process.env.STUDIO_APP_CONNECTOR_TIMEOUT_MS = '150';

const connectors = require('./connectors');

const OWNER = 'owner-1';
const ORG = 'org-1';
const app = { id: 'app-1', userId: OWNER, organizationId: ORG };
const OWNER_SESSION = { user: { id: OWNER, organizationId: ORG }, isAdmin: false, automationProviders: {} };

function fakeResp(body, { ok = true, status = 200 } = {}) {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return { ok, status, text: async () => text, json: async () => JSON.parse(text) };
}

// A response whose body arrives as a web stream (what undici really hands back).
// text() throws: reaching for it would mean the whole body was buffered first.
function streamResp(chunks, { ok = true, status = 200 } = {}) {
    const state = { bytesRead: 0, chunksRead: 0, cancelled: false };
    let i = 0;
    return {
        ok, status, state,
        text: async () => { throw new Error('must not buffer the whole body'); },
        body: {
            getReader: () => ({
                read: async () => {
                    if (i >= chunks.length) return { done: true, value: undefined };
                    const value = Buffer.from(chunks[i++]);
                    state.bytesRead += value.length;
                    state.chunksRead++;
                    return { done: false, value };
                },
                cancel: async () => { state.cancelled = true; },
            }),
        },
    };
}

// ── listConnectors / findConnector ──────────────────────────────────

test('listConnectors returns a safe projection and never leaks fixedArgs/url/creds', () => {
    const model = {
        connectors: [
            { id: 'c1', kind: 'integration_tool', name: 'Emails', tool: 'gmail_list', fixedArgs: { labelIds: ['INBOX'] }, params: [{ key: 'q', required: true }] },
            { id: 'c2', kind: 'rest', name: 'API', url: 'https://api.example.com/x', auth: { credentialProvider: 'ex' } },
            { id: 'bad', kind: 'nope' },                 // invalid kind → filtered
            { kind: 'rest', url: 'https://x' },            // no id → filtered
        ],
    };
    const list = connectors.listConnectors(model);
    assert.strictEqual(list.length, 2);
    assert.deepStrictEqual(list[0], { id: 'c1', kind: 'integration_tool', name: 'Emails', params: [{ key: 'q', type: 'text', required: true }] });
    assert.ok(!('fixedArgs' in list[0]));
    assert.ok(!('tool' in list[0]));
    assert.ok(!('url' in list[1]));
    assert.ok(!('auth' in list[1]));
});

test('listConnectors on a model without connectors is []', () => {
    assert.deepStrictEqual(connectors.listConnectors({}), []);
    assert.deepStrictEqual(connectors.listConnectors(null), []);
});

test('findConnector resolves by id and ignores invalid entries', () => {
    const model = { connectors: [{ id: 'c1', kind: 'rest', url: 'https://a' }] };
    assert.strictEqual(connectors.findConnector(model, 'c1').id, 'c1');
    assert.strictEqual(connectors.findConnector(model, 'nope'), null);
});

// ── integration_tool: fixedArgs win + acts-as-owner ─────────────────

test('integration_tool: fixedArgs override viewer params, dispatched acts-as-owner', async () => {
    const calls = [];
    const connector = {
        id: 'c1', kind: 'integration_tool', tool: 'sheets_read',
        params: [{ key: 'sheetId' }, { key: 'query' }, { key: 'evil' }, { key: 'arr' }],
        fixedArgs: { sheetId: 'PINNED', range: 'A1:Z' },
    };
    const result = await connectors.runConnector(connector, {
        app, viewerId: 'viewer-9',
        params: { sheetId: 'ATTACKER', query: 'hi', evil: { obj: 1 }, arr: [1] },
        _deps: {
            buildOwnerSession: async (a) => { assert.strictEqual(a.userId, OWNER); return OWNER_SESSION; },
            executeTool: async (tool, args, ctx) => { calls.push({ tool, args, ctx }); return { rows: [{ a: 1 }, { a: 2 }] }; },
        },
    });
    assert.strictEqual(calls.length, 1);
    const { tool, args, ctx } = calls[0];
    assert.strictEqual(tool, 'sheets_read');
    // Pinned fields win; non-primitive viewer params dropped; primitives kept.
    assert.strictEqual(args.sheetId, 'PINNED');
    assert.strictEqual(args.range, 'A1:Z');
    assert.strictEqual(args.query, 'hi');
    assert.ok(!('evil' in args) && !('arr' in args));
    // Acts-as-owner: owner id + owner session, never the viewer.
    assert.strictEqual(ctx.userId, OWNER);
    assert.strictEqual(ctx.session, OWNER_SESSION);
    assert.strictEqual(ctx.orgId, ORG);
    assert.deepStrictEqual(result.rows, [{ a: 1 }, { a: 2 }]);
});

test('integration_tool: undeclared viewer keys never reach the owner-authenticated tool call', async () => {
    let seenArgs = null;
    const connector = {
        id: 'c1', kind: 'integration_tool', tool: 'gmail_list_messages',
        params: [{ key: 'q' }],
        fixedArgs: { labelIds: ['INBOX'] },
    };
    await connectors.runConnector(connector, {
        app, viewerId: 'viewer-9',
        params: { q: 'invoice', to: 'attacker@example.com', includeSpamTrash: true, maxResults: 500 },
        _deps: {
            buildOwnerSession: async () => OWNER_SESSION,
            executeTool: async (_tool, args) => { seenArgs = args; return []; },
        },
    });
    assert.deepStrictEqual(seenArgs, { q: 'invoice', labelIds: ['INBOX'] });
});

test('integration_tool: a connector declaring no params accepts no viewer input at all', async () => {
    let seenArgs = null;
    await connectors.runConnector(
        { id: 'c1', kind: 'integration_tool', tool: 'gmail_list_messages', fixedArgs: { labelIds: ['INBOX'] } },
        {
            app, params: { to: 'attacker@example.com' },
            _deps: {
                buildOwnerSession: async () => OWNER_SESSION,
                executeTool: async (_tool, args) => { seenArgs = args; return []; },
            },
        },
    );
    assert.deepStrictEqual(seenArgs, { labelIds: ['INBOX'] });
});

test('filterDeclaredParams drops undeclared keys for tools and passes other kinds through', () => {
    const tool = { id: 'c1', kind: 'integration_tool', tool: 't', params: [{ key: 'q' }, { key: 'bad' }, {}, { key: 123 }] };
    assert.deepStrictEqual(connectors.filterDeclaredParams(tool, { q: 'x', to: 'evil', bad: 1 }), { q: 'x', bad: 1 });
    assert.deepStrictEqual(connectors.filterDeclaredParams({ id: 'c1', kind: 'integration_tool', tool: 't' }, { q: 'x' }), {});
    // REST bounds itself to the template's {placeholders}; automation forwards a bag.
    const rest = { id: 'c2', kind: 'rest', url: 'https://a/{q}' };
    assert.deepStrictEqual(connectors.filterDeclaredParams(rest, { q: 'x' }), { q: 'x' });
    assert.deepStrictEqual(connectors.filterDeclaredParams(tool, null), {});
});

test('integration_tool: a tool error surfaces as a 502', async () => {
    // A genuine upstream fault. A "not connected" message is classified
    // separately as 409 connection_required — see connectors.chain.test.js.
    const connector = { id: 'c1', kind: 'integration_tool', tool: 'x' };
    await assert.rejects(
        () => connectors.runConnector(connector, {
            app, params: {},
            _deps: { buildOwnerSession: async () => OWNER_SESSION, executeTool: async () => ({ error: 'upstream returned 503' }) },
        }),
        (err) => err.status === 502,
    );
});

// ── automation: owner-ownership gate ────────────────────────────────

test('automation: automation owned by someone else → 403 (no run)', async () => {
    let ran = false;
    const connector = { id: 'c1', kind: 'automation', automationId: 'auto-1' };
    await assert.rejects(
        () => connectors.runConnector(connector, {
            app, params: {},
            _deps: {
                getAutomation: async () => ({ id: 'auto-1', userId: 'someone-else' }),
                executeAutomation: async () => { ran = true; return { status: 'success' }; },
            },
        }),
        (err) => err.status === 403,
    );
    assert.strictEqual(ran, false);
});

test('automation: missing automation → 404', async () => {
    const connector = { id: 'c1', kind: 'automation', automationId: 'gone' };
    await assert.rejects(
        () => connectors.runConnector(connector, {
            app, params: {},
            _deps: { getAutomation: async () => null },
        }),
        (err) => err.status === 404,
    );
});

test('automation: owner automation runs acts-as-owner with viewer id in the trigger payload', async () => {
    const calls = [];
    const connector = { id: 'c1', kind: 'automation', automationId: 'auto-1' };
    const result = await connectors.runConnector(connector, {
        app, viewerId: 'viewer-9', params: { term: 'x', bad: { o: 1 } },
        _deps: {
            getAutomation: async () => ({ id: 'auto-1', userId: OWNER }),
            executeAutomation: async (automation, opts) => { calls.push({ automation, opts }); return { id: 'run-1', status: 'success', output: [{ n: 1 }] }; },
        },
    });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].opts.triggerKind, 'studio_app');
    assert.deepStrictEqual(calls[0].opts.triggerPayload.params, { term: 'x' });
    assert.strictEqual(calls[0].opts.triggerPayload._viewerUserId, 'viewer-9');
    assert.strictEqual(calls[0].opts.triggerPayload._studioAppId, 'app-1');
    assert.deepStrictEqual(result.rows, [{ n: 1 }]);
});

test('automation: a failed run returns empty rows', async () => {
    const connector = { id: 'c1', kind: 'automation', automationId: 'auto-1' };
    const result = await connectors.runConnector(connector, {
        app, params: {},
        _deps: {
            getAutomation: async () => ({ id: 'auto-1', userId: OWNER }),
            executeAutomation: async () => ({ id: 'r', status: 'error', error: 'boom' }),
        },
    });
    assert.deepStrictEqual(result.rows, []);
});

test('automation: rows come from the shared final-output derivation, not run.output', async () => {
    // executeAutomation resolves with the persisted run ROW, which has no
    // `output` column — reading run.output directly always yielded zero rows.
    const runRow = { id: 'run-7', status: 'success' };
    const seen = [];
    const result = await connectors.runConnector(
        { id: 'c1', kind: 'automation', automationId: 'auto-1' },
        {
            app, params: {},
            _deps: {
                getAutomation: async () => ({ id: 'auto-1', userId: OWNER }),
                executeAutomation: async () => runRow,
                deriveFinalOutput: async (run) => { seen.push(run); return [{ n: 1 }, { n: 2 }]; },
            },
        },
    );
    assert.deepStrictEqual(seen, [runRow]);
    assert.deepStrictEqual(result.rows, [{ n: 1 }, { n: 2 }]);
});

test('automation: the default derivation is actionExecutor.deriveFinalOutput (shared, not re-implemented)', async () => {
    const actionExecutor = require('./actionExecutor');
    const real = actionExecutor.deriveFinalOutput;
    const seen = [];
    actionExecutor.deriveFinalOutput = async (run) => { seen.push(run.id); return [{ derived: true }]; };
    try {
        const result = await connectors.runConnector(
            { id: 'c1', kind: 'automation', automationId: 'auto-1' },
            {
                app, params: {},
                _deps: {
                    getAutomation: async () => ({ id: 'auto-1', userId: OWNER }),
                    executeAutomation: async () => ({ id: 'run-8', status: 'success' }),
                },
            },
        );
        assert.deepStrictEqual(seen, ['run-8']);
        assert.deepStrictEqual(result.rows, [{ derived: true }]);
    } finally {
        actionExecutor.deriveFinalOutput = real;
    }
});

// ── rest: https + host allowlist + SSRF + cap/paging ────────────────

test('rest: refuses a non-https template', async () => {
    const connector = { id: 'c1', kind: 'rest', url: 'http://api.example.com/items' };
    await assert.rejects(
        () => connectors.runConnector(connector, { app, params: {}, _deps: { safeFetch: async () => { throw new Error('should not fetch'); } } }),
        (err) => err.status === 400 && /https/.test(err.message),
    );
});

test('rest: refuses an internal/private host (SSRF) using the real screen', async () => {
    for (const url of [
        'https://localhost/items',
        'https://127.0.0.1/items',
        'https://169.254.169.254/latest/meta-data',
        'https://10.0.0.5/x',
        'https://metadata.google.internal/x',
    ]) {
        const connector = { id: 'c1', kind: 'rest', url };
        await assert.rejects(
            () => connectors.runConnector(connector, { app, params: {}, _deps: { safeFetch: async () => { throw new Error('should not fetch'); } } }),
            (err) => err.status === 403,
            `expected 403 for ${url}`,
        );
    }
});

test('rest: refuses a template that templates its own host', async () => {
    const connector = { id: 'c1', kind: 'rest', url: 'https://{host}.example.com/x' };
    await assert.rejects(
        () => connectors.runConnector(connector, { app, params: { host: 'evil' }, _deps: { safeFetch: async () => { throw new Error('nope'); } } }),
        (err) => err.status === 400,
    );
});

test('rest: viewer params fill placeholders (URL-encoded); host stays fixed', async () => {
    let fetchedUrl = null;
    const connector = {
        id: 'c1', kind: 'rest',
        url: 'https://api.example.com/search?q={q}&page={page}',
        rowsPath: 'data.items',
    };
    await connectors.runConnector(connector, {
        app, params: { q: 'a b/@c', page: 2, ignored: 'x' },
        _deps: { safeFetch: async (u) => { fetchedUrl = u; return fakeResp({ data: { items: [] } }); } },
    });
    const parsed = new URL(fetchedUrl);
    assert.strictEqual(parsed.host, 'api.example.com');
    assert.strictEqual(parsed.searchParams.get('q'), 'a b/@c'); // decoded round-trips → was encoded
    assert.strictEqual(parsed.searchParams.get('page'), '2');
});

test('rest: rows are extracted via rowsPath, capped, and nextPage surfaced', async () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ i }));
    const connector = {
        id: 'c1', kind: 'rest',
        url: 'https://api.example.com/items',
        rowsPath: 'data.items',
        nextPagePath: 'data.next',
        maxRows: 3,
    };
    const result = await connectors.runConnector(connector, {
        app, params: {},
        _deps: { safeFetch: async () => fakeResp({ data: { items: many, next: 'cursor-2' } }) },
    });
    assert.strictEqual(result.rows.length, 3);
    assert.deepStrictEqual(result.rows, [{ i: 0 }, { i: 1 }, { i: 2 }]);
    assert.strictEqual(result.nextPage, 'cursor-2');
});

test('rest: maxRows is itself capped at the hard ceiling', async () => {
    const huge = Array.from({ length: connectors._MAX_CONNECTOR_ROWS + 50 }, (_, i) => i);
    const connector = { id: 'c1', kind: 'rest', url: 'https://api.example.com/items', maxRows: 999999 };
    const result = await connectors.runConnector(connector, {
        app, params: {},
        _deps: { safeFetch: async () => fakeResp(huge) },
    });
    assert.strictEqual(result.rows.length, connectors._MAX_CONNECTOR_ROWS);
    assert.ok(!('nextPage' in result));
});

test('rest: injects the owner bearer credential and never a viewer one', async () => {
    let seenHeaders = null;
    const connector = {
        id: 'c1', kind: 'rest', url: 'https://api.example.com/items',
        auth: { type: 'bearer', credentialProvider: 'example' },
    };
    await connectors.runConnector(connector, {
        app, params: {},
        _deps: {
            getProviderAuth: async (userId, provider) => { assert.strictEqual(userId, OWNER); assert.strictEqual(provider, 'example'); return { accessToken: 'OWNER-TOKEN' }; },
            safeFetch: async (_u, opts) => { seenHeaders = opts.headers; return fakeResp([]); },
        },
    });
    assert.strictEqual(seenHeaders.Authorization, 'Bearer OWNER-TOKEN');
});

// The credential hop goes through automationAuth.getProviderAuth, which refreshes
// a token that is about to expire and returns null for a revoked / needs-reauth
// credential. A raw store read did neither, so a connector on a short-lived
// provider (Withings: 3 h) failed silently once its first token aged out.
test('rest: a refused credential sends no Authorization header at all', async () => {
    let seenHeaders = null;
    const connector = {
        id: 'c1', kind: 'rest', url: 'https://api.example.com/items',
        auth: { type: 'bearer', credentialProvider: 'withings' },
    };
    await connectors.runConnector(connector, {
        app, params: {},
        _deps: {
            getProviderAuth: async () => null, // revoked / needs_reauth / refresh failed
            safeFetch: async (_u, opts) => { seenHeaders = opts.headers; return fakeResp([]); },
        },
    });
    assert.strictEqual(seenHeaders.Authorization, undefined);
});

test('rest: a non-2xx response is a 502', async () => {
    const connector = { id: 'c1', kind: 'rest', url: 'https://api.example.com/items' };
    await assert.rejects(
        () => connectors.runConnector(connector, { app, params: {}, _deps: { safeFetch: async () => fakeResp('', { ok: false, status: 500 }) } }),
        (err) => err.status === 502,
    );
});

test('rest: a streamed body is read through the reader and parsed', async () => {
    let resp = null;
    const connector = { id: 'c1', kind: 'rest', url: 'https://api.example.com/items', rowsPath: 'items' };
    const result = await connectors.runConnector(connector, {
        app, params: {},
        _deps: { safeFetch: async () => { resp = streamResp(['{"items":[{"a"', ':1},{"a":2}]}']); return resp; } },
    });
    assert.deepStrictEqual(result.rows, [{ a: 1 }, { a: 2 }]);
    assert.strictEqual(resp.state.chunksRead, 2);
});

test('rest: an oversized body is cut off MID-STREAM and the request aborted', async () => {
    const meg = Buffer.alloc(1024 * 1024, 0x61);
    let resp = null;
    let signal = null;
    const connector = { id: 'c1', kind: 'rest', url: 'https://api.example.com/items' };
    await assert.rejects(
        () => connectors.runConnector(connector, {
            app, params: {},
            _deps: {
                safeFetch: async (_u, opts) => {
                    signal = opts.signal;
                    resp = streamResp(Array.from({ length: 20 }, () => meg));
                    return resp;
                },
            },
        }),
        (err) => err.status === 502 && /too large/.test(err.message),
    );
    // 4MB cap → the 5th megabyte trips it; the remaining 15 are never read.
    assert.strictEqual(resp.state.chunksRead, 5);
    assert.ok(signal.aborted, 'the in-flight request is aborted, not drained');
    assert.ok(resp.state.cancelled, 'the reader is released');
});

test('rest: the timeout covers the BODY read, not just the headers', async () => {
    let signal = null;
    const connector = { id: 'c1', kind: 'rest', url: 'https://api.example.com/items' };
    await assert.rejects(
        () => connectors.runConnector(connector, {
            app, params: {},
            _deps: {
                safeFetch: async (_u, opts) => {
                    signal = opts.signal;
                    return {
                        ok: true, status: 200,
                        text: async () => { throw new Error('must not buffer the whole body'); },
                        body: {
                            getReader: () => ({
                                // A drip that never completes — only the timeout ends it.
                                read: () => new Promise((_res, rej) => {
                                    opts.signal.addEventListener('abort', () => {
                                        const e = new Error('aborted'); e.name = 'AbortError'; rej(e);
                                    }, { once: true });
                                }),
                                cancel: async () => {},
                            }),
                        },
                    };
                },
            },
        }),
        (err) => err.status === 502 && /timeout/.test(err.message),
    );
    assert.ok(signal.aborted, 'the connector timeout fired while the body was still dripping');
});

// ── integration_tool runAs:'viewer' ─────────────────────────────────

const VIEWER = 'viewer-9';
const VIEWER_SESSION = { user: { id: VIEWER, organizationId: ORG, groups: ['g1'] }, isAdmin: false, automationProviders: {} };
const viewerConnector = {
    id: 'c1', kind: 'integration_tool', tool: 'gmail_list_messages',
    integrationId: 'gmail', runAs: 'viewer',
};
const toolSet = (...names) => ({ tools: names.map((n) => ({ function: { name: n } })) });

test('viewer mode: runs as the VIEWER when their resolved tool set has the tool', async () => {
    const calls = [];
    await connectors.runConnector(viewerConnector, {
        app, viewerId: VIEWER, params: {},
        _deps: {
            buildUserSession: async (userId) => { assert.strictEqual(userId, VIEWER); return VIEWER_SESSION; },
            getIntegrationTools: async ({ userId }) => { assert.strictEqual(userId, VIEWER); return toolSet('gmail_list_messages'); },
            resolveConnectionForRun: async () => { throw new Error('must not be consulted when the viewer has the tool'); },
            executeTool: async (tool, args, ctx) => { calls.push(ctx); return []; },
        },
    });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].userId, VIEWER);
    assert.strictEqual(calls[0].session, VIEWER_SESSION);
    assert.strictEqual(calls[0].orgId, ORG);
});

test('viewer mode: falls back to a delegated lend grant and runs as the grantor', async () => {
    const sessions = [];
    const calls = [];
    await connectors.runConnector(viewerConnector, {
        app, viewerId: VIEWER, params: {},
        _deps: {
            buildUserSession: async (userId) => {
                sessions.push(userId);
                return userId === VIEWER ? VIEWER_SESSION : { user: { id: userId, organizationId: ORG }, automationProviders: {} };
            },
            getIntegrationTools: async () => toolSet('some_other_tool'),
            resolveConnectionForRun: async (q) => {
                assert.strictEqual(q.runningUserId, VIEWER);
                assert.strictEqual(q.provider, 'gmail');
                assert.strictEqual(q.resourceType, 'studio_app');
                assert.strictEqual(q.resourceId, app.id);
                assert.deepStrictEqual(q.runningUserGroups, ['g1']);
                return { mode: 'delegated', available: true, effectiveUserId: 'lender-1' };
            },
            executeTool: async (tool, args, ctx) => { calls.push(ctx); return []; },
        },
    });
    assert.deepStrictEqual(sessions, [VIEWER, 'lender-1']);
    assert.strictEqual(calls[0].userId, 'lender-1');
});

test('viewer mode: no tool + no grant → 409 connection_required naming the provider', async () => {
    await assert.rejects(
        () => connectors.runConnector(viewerConnector, {
            app, viewerId: VIEWER, params: {},
            _deps: {
                buildUserSession: async () => VIEWER_SESSION,
                getIntegrationTools: async () => toolSet(),
                resolveConnectionForRun: async () => ({ mode: 'byo_required', available: false }),
                executeTool: async () => { throw new Error('must not dispatch'); },
            },
        }),
        (err) => err.status === 409 && err.code === 'connection_required' && err.provider === 'gmail',
    );
});

test('viewer mode: an anonymous run (no viewerId) is refused with 401 connection_required', async () => {
    await assert.rejects(
        () => connectors.runConnector(viewerConnector, {
            app, params: {},
            _deps: { executeTool: async () => { throw new Error('must not dispatch'); } },
        }),
        (err) => err.status === 401 && err.code === 'connection_required',
    );
});

test('runAs omitted stays acts-as-owner (back-compat: never touches viewer machinery)', async () => {
    const calls = [];
    await connectors.runConnector(
        { id: 'c1', kind: 'integration_tool', tool: 'gmail_list_messages', integrationId: 'gmail' },
        {
            app, viewerId: VIEWER, params: {},
            _deps: {
                buildOwnerSession: async () => OWNER_SESSION,
                getIntegrationTools: async () => { throw new Error('owner path must not gate on the viewer'); },
                resolveConnectionForRun: async () => { throw new Error('owner path must not resolve grants'); },
                executeTool: async (tool, args, ctx) => { calls.push(ctx); return []; },
            },
        },
    );
    assert.strictEqual(calls[0].userId, OWNER);
});

test('publicConnector exposes integrationId/runAs metadata but still no secrets', () => {
    const list = connectors.listConnectors({
        connectors: [
            { id: 'c1', kind: 'integration_tool', name: 'Mail', tool: 'gmail_list', integrationId: 'gmail', runAs: 'viewer', fixedArgs: { q: 'x' } },
            { id: 'c2', kind: 'integration_tool', name: 'Owner mail', tool: 'gmail_list' },
        ],
    });
    assert.strictEqual(list[0].integrationId, 'gmail');
    assert.strictEqual(list[0].runAs, 'viewer');
    assert.ok(!('fixedArgs' in list[0]) && !('tool' in list[0]));
    // Owner-mode connectors don't advertise runAs at all (default semantics).
    assert.ok(!('runAs' in list[1]) && !('integrationId' in list[1]));
});

// ── guards ──────────────────────────────────────────────────────────

test('an invalid connector or unowned app is rejected before any dispatch', async () => {
    await assert.rejects(() => connectors.runConnector({ id: 'x', kind: 'nope' }, { app, params: {} }), (e) => e.status === 400);
    await assert.rejects(() => connectors.runConnector({ id: 'c1', kind: 'rest', url: 'https://a' }, { app: {}, params: {} }), (e) => e.status === 400);
});
