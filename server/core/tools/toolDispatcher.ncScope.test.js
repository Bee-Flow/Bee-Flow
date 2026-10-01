/**
 * toolDispatcher × ncScopeGuard — the wiring that makes the scope real.
 *
 * End-to-end through the REAL dispatcher, REAL guard and REAL family
 * executor (Deck), with only nextcloudClient.resolveAuth stubbed to a
 * canned HTTP layer and configStore faked in require.cache. Pins:
 *
 *   1. a denial happens BEFORE the family executor runs (no NC traffic)
 *   2. an in-scope call flows through and 'filter' tools come back trimmed
 *   3. mode off denies even though isAppOn would have offered the tool
 *   4. executeNextcloudFamilyTool ignores non-NC names (fall-through safe)
 *
 * Plain-script style with an explicit exit (same as
 * core/integrations/integrationTools.*.test.js): requiring the dispatcher
 * pulls modules that keep the event loop alive, so a node:test runner
 * would hang after the last assertion.
 *
 * Run: SESSION_SECRET=test-session-secret-at-least-32-chars-long node core/tools/toolDispatcher.ncScope.test.js
 */

const assert = require('node:assert/strict');
const path = require('path');

const store = new Map();
function inject(rel, exports) {
    const resolved = require.resolve(path.join(__dirname, rel));
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}
inject('../../stores/configStore.js', {
    getConfig: async (k) => store.get(k) ?? null,
    setConfig: async (k, v) => { store.set(k, v); },
    deleteConfig: async (k) => { store.delete(k); },
    getSecret: async () => null,
    getConfigsByKeys: async () => ({}),
});
inject('../../stores/guardrailEventStore.js', { logGuardrailEvent: async () => {} });

const ncClient = require('../../integrations/nextcloudClient');
const guard = require('../integrations/ncScopeGuard');
const { executeTool, executeNextcloudFamilyTool } = require('./toolDispatcher');

const USER = 'u-1';
// Connector-shaped session: Deck (like Notes) branches on isConnectorSession —
// a bare session would route to the Basic-auth path and the real userStore.
const CONNECTOR_SESSION = {
    user: { id: USER, provider: 'nextcloud_connector' },
    connectorOrgId: 'org-1',
    connectorNcUid: 'tom',
};
let upstreamCalls = [];

function reset() {
    store.clear();
    upstreamCalls = [];
    guard.invalidateScopeCache();
    ncClient.resolveAuth = async () => ({
        mode: 'connector',
        baseUrl: 'https://nc.example.com',
        uid: 'tom',
        fetch: async (url) => {
            upstreamCalls.push(url);
            const boards = [{ id: 7, title: 'Roadmap' }, { id: 8, title: 'Secrets' }];
            return {
                ok: true, status: 200,
                text: async () => JSON.stringify(boards),
                json: async () => boards,
                headers: { get: () => null },
            };
        },
        authError: 'auth failed',
    });
}

function setUserScope(integrations) {
    store.set(`user_nc_scope_${USER}`, { v: 1, integrations });
    guard.invalidateScopeCache();
}

const run = async () => {
    // 1. out-of-scope call is denied BEFORE any Nextcloud traffic
    reset();
    setUserScope({ 'nextcloud-deck': { mode: 'selected', selected: ['7'] } });
    let result = await executeTool('nextcloud_deck_list_cards', { boardId: 8 }, { userId: USER, session: CONNECTOR_SESSION });
    assert.ok(result?.error, 'must deny');
    assert.equal(result.nc_scope_denied, true);
    assert.equal(upstreamCalls.length, 0, 'the family executor must never have run');
    console.log('✓ out-of-scope call denied before any Nextcloud traffic');

    // 2. in-scope call flows through the real executor
    reset();
    setUserScope({ 'nextcloud-deck': { mode: 'selected', selected: ['7'] } });
    result = await executeTool('nextcloud_deck_get_board', { boardId: 7 }, { userId: USER, session: CONNECTOR_SESSION });
    assert.ok(!result?.nc_scope_denied, `unexpected denial: ${result?.error}`);
    assert.equal(upstreamCalls.length, 1, 'the executor must have talked to Nextcloud');
    console.log('✓ in-scope call reaches the executor');

    // 3. 'filter' tools come back trimmed, count corrected
    reset();
    setUserScope({ 'nextcloud-deck': { mode: 'selected', selected: ['7'] } });
    result = await executeTool('nextcloud_deck_list_boards', {}, { userId: USER, session: CONNECTOR_SESSION });
    assert.ok(Array.isArray(result.boards), `expected boards array, got: ${JSON.stringify(result).slice(0, 200)}`);
    assert.deepEqual(result.boards.map(b => b.id), [7], 'board 8 must be filtered out');
    assert.equal(result.count, 1);
    console.log('✓ filter-policy results trimmed to the selection');

    // 4. mode off denies the whole family at dispatch
    reset();
    setUserScope({ 'nextcloud-deck': { mode: 'off' } });
    result = await executeTool('nextcloud_deck_list_boards', {}, { userId: USER, session: CONNECTOR_SESSION });
    assert.ok(result?.nc_scope_denied);
    assert.equal(upstreamCalls.length, 0);
    console.log('✓ off-mode family denied at dispatch');

    // 5. default scope: everything flows, nothing filtered
    reset();
    result = await executeTool('nextcloud_deck_list_boards', {}, { userId: USER, session: CONNECTOR_SESSION });
    assert.deepEqual(result.boards.map(b => b.id), [7, 8]);
    console.log('✓ default (allow-all) untouched');

    // 6. fall-through safety
    assert.equal(await executeNextcloudFamilyTool('gmail_list_messages', {}, USER, {}), undefined);
    console.log('✓ non-NC names fall through the family helper');

    // 7. the run scope a routine hands the dispatcher reaches the Files
    //    family: nextcloud_upload_file resolves a generated_file handle
    //    against THAT journey. The resolver is a double; what is pinned is
    //    that `runScope` survives executeTool → family → executeNextcloudTool.
    reset();
    const seen = [];
    inject('../automationRunner/generatedFileHandle.js', {
        readGeneratedFile: async (handle, runScope) => { seen.push(runScope); return null; },
    });
    result = await executeTool('nextcloud_upload_file', { path: '/Decks/', sourceHandle: { kind: 'generated_file', fileId: 'f1' } },
        { userId: USER, session: CONNECTOR_SESSION, runScope: { runId: 'run-9', rootRunId: 'run-8' } });
    assert.deepEqual(seen, [{ runId: 'run-9', rootRunId: 'run-8' }], 'runScope reached the upload tool');
    assert.match(result.error, /not a live file of this run/);
    console.log('✓ runScope threads through to the Files family');

    // 8. create_presentation with nextcloudPath is the Nextcloud tool in
    //    disguise: same scope guard (a folder outside the selection is
    //    denied before any traffic), and the path is completed from the
    //    title when only a folder was given.
    reset();
    setUserScope({ nextcloud: { mode: 'selected', selected: ['/Shared'] } });
    result = await executeTool('create_presentation', { title: 'Q3 review', markdown: '## A\n- a', nextcloudPath: '/Presentations' }, { userId: USER, session: CONNECTOR_SESSION });
    assert.ok(result?.error, 'denied outside the Files selection');
    assert.equal(upstreamCalls.length, 0, 'no Nextcloud traffic on a denial');
    assert.match(result.nextcloud?.error || '', /outside the folders/, 'falls back to a local deck and carries the denial');
    reset();
    let ncArgsSeen = null;
    inject('../../integrations/nextcloudTools.js', {
        ...require('../../integrations/nextcloudTools'),
        executeNextcloudTool: async (name, args) => { ncArgsSeen = { name, args }; return { success: true, path: args.path, fileId: '482', webUrl: 'https://nc.example.com/f/482', file: { kind: 'presentation', name: 'Q3 review.pptx', webUrl: 'https://nc.example.com/f/482' } }; },
    });
    delete require.cache[require.resolve('./toolDispatcher')];
    const fresh = require('./toolDispatcher');
    result = await fresh.executeTool('create_presentation', { title: 'Q3 review', markdown: '## A\n- a', nextcloudPath: '/Presentations' }, { userId: USER, session: CONNECTOR_SESSION });
    assert.equal(ncArgsSeen?.name, 'nextcloud_create_presentation');
    assert.equal(ncArgsSeen?.args?.path, '/Presentations/Q3 review.pptx', 'a folder path is completed from the title');
    assert.equal(ncArgsSeen.args.nextcloudPath, undefined, 'the routing argument does not leak into the Nextcloud tool');
    assert.equal(result.webUrl, 'https://nc.example.com/f/482');
    assert.equal(result.file.kind, 'presentation', 'the chat card travels with the result');
    console.log('✓ create_presentation + nextcloudPath = the Nextcloud tool behind the scope guard');

    // 9. create_word_document with nextcloudPath: the destination passes the
    //    same guard as nextcloud_create_document. Outside the selection:
    //    no Nextcloud traffic and the denial travels with the answer. Inside
    //    it: the .docx is PUT at the folder + a name from the title.
    reset();
    setUserScope({ nextcloud: { mode: 'selected', selected: ['/Shared'] } });
    result = await executeTool('create_word_document', { title: 'Offerte', markdown: '## A\n\ntekst', nextcloudPath: '/Private' }, { userId: USER, session: CONNECTOR_SESSION });
    assert.equal(upstreamCalls.length, 0, 'no Nextcloud traffic on a denial');
    assert.match(`${result?.error || ''} ${result?.nextcloud?.error || ''}`, /outside the folders/, 'the denial is reported');
    reset();
    setUserScope({ nextcloud: { mode: 'selected', selected: ['/Shared'] } });
    result = await executeTool('create_word_document', { title: 'Offerte', markdown: '## A\n\ntekst', nextcloudPath: '/Shared' }, { userId: USER, session: CONNECTOR_SESSION });
    assert.ok(!result?.error, `unexpected error: ${result?.error}`);
    assert.ok(upstreamCalls.some((u) => /\/Shared\/Offerte\.docx$/.test(u)), 'the file was written inside the selection');
    assert.equal(result.file.kind, 'word', 'the chat card travels with the result');
    assert.equal(result.file.path, '/Shared/Offerte.docx');
    console.log('✓ create_word_document + nextcloudPath goes through the Files scope guard');

    console.log('\nALL DISPATCHER NC-SCOPE TESTS PASSED');
};

run().then(() => process.exit(0)).catch(e => { console.error('TEST FAILED:', e); process.exit(1); });
