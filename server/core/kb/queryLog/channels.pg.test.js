'use strict';

/**
 * The channel hooks of the KB query log, driven through the REAL search functions with the retrieval
 * (searchLocally) and the access checks stubbed: logging off writes nothing; logging on writes a row
 * with the channel, the query and the passages; the answering step fills answer, model and outcome;
 * a failing model call becomes outcome `error`; one answer finishes every search of a turn.
 *
 * Run: cd server && node --test core/kb/queryLog/channels.pg.test.js
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { pgliteDb } = require('../../../testUtils/pgliteDb');
const { makeKbQueryLogStore } = require('../../../stores/kb/queryLog/index.mts');
const { KB_QUERY_LOG_COLUMN_DDL, KB_QUERY_LOG_TABLE_DDL } = require('../../../stores/kb/queryLog/ddl.mts');
const crypto = require('./crypto.mts');
const rec = require('./recorder.mts');
const hook = require('./hook.mts');

// The retrieval and the configuration, stubbed before the modules under test run.
const configStore = require('../../../stores/configStore');
configStore.getConfig = async () => '';
configStore.getSecret = async () => '';
const localKBIngest = require('../localKBIngest');
const resolveProvider = require('../resolveProvider');
resolveProvider.resolveKbProvider = async () => 'local';
const kbVisibility = require('../kbVisibility');
kbVisibility.filterKbIdsForUser = async (ids) => ids;

const { pg, db } = pgliteDb();
const store = makeKbQueryLogStore(db);

const KB_ON = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; // logs
const KB_OFF = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'; // does not log
const DOC_ON = 'a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1';
const DOC_OFF = 'c1c1c1c1-c1c1-41c1-81c1-c1c1c1c1c1c1';

let found = [];
localKBIngest.searchLocally = async () => found;

const warnings = [];
const raw = async () => (await pg.query('SELECT * FROM kb_query_log ORDER BY created_at')).rows;
const entry = async (row) => store.getEntry(row.kb_id, row.id);
const settle = async (...handles) => { for (const h of handles) await h.settled(); await new Promise((r) => setTimeout(r, 50)); };

before(async () => {
    crypto._setCryptoDeps({ getOrgRootKey: async () => Buffer.alloc(32, 3), sealingEnabled: async () => true });
    await pg.exec(`CREATE TABLE knowledge_bases (id UUID PRIMARY KEY, tenant_id TEXT, name TEXT, organization_id TEXT);
        CREATE TABLE documents (id UUID PRIMARY KEY, knowledge_base_id UUID REFERENCES knowledge_bases(id) ON DELETE CASCADE, content_hash TEXT);
        CREATE TABLE kb_document_versions (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), document_id UUID NOT NULL, deleted_at TIMESTAMPTZ DEFAULT now());`);
    for (const sql of KB_QUERY_LOG_COLUMN_DDL) await pg.exec(sql);
    for (const sql of KB_QUERY_LOG_TABLE_DDL) await pg.exec(sql);
    await pg.exec(`INSERT INTO knowledge_bases (id, tenant_id, name, organization_id, query_log_enabled, query_log_retention_days) VALUES
        ('${KB_ON}', 't', 'On', 'org1', true, 90), ('${KB_OFF}', 't', 'Off', 'org1', false, 90);
        INSERT INTO documents (id, knowledge_base_id) VALUES ('${DOC_ON}', '${KB_ON}'), ('${DOC_OFF}', '${KB_OFF}');
        INSERT INTO kb_query_log_ack (user_id, kb_id) SELECT u, '${KB_ON}'::uuid FROM unnest(ARRAY['u1','asker','u','owner','viewer','author','viewer1']) AS u;`);
});
after(async () => { rec._setRecorderDeps(null); crypto._setCryptoDeps(null); await pg.close(); });
beforeEach(async () => {
    await pg.exec('DELETE FROM kb_query_log');
    warnings.length = 0;
    found = [{ id: 'c1', chunk_id: 'c1', document_id: DOC_ON, source_uri: 'policy.pdf', title: 'Policy', score: 0.5, content: 'The notice period is two months.' }];
    rec._setRecorderDeps({ store, hasFeature: async () => true, log: { warn: (m) => warnings.push(m) } });
});

const { quickKBSearch } = require('../../agentRuntime/knowledgeSearch');

test('quickKBSearch (direct_chat): logging off writes nothing', async () => {
    found = [{ ...found[0], document_id: DOC_OFF }];
    const out = await quickKBSearch('u1', [KB_OFF], 'notice period', { log: { channel: 'direct_chat', channelRef: {}, orgId: 'org1', userId: 'u1' } });
    assert.equal(out.length, 1);
    await hook.handleOf(out)?.settled();
    assert.equal((await raw()).length, 0);
});

test('quickKBSearch: no `log` option writes nothing even when the KB logs', async () => {
    const out = await quickKBSearch('u1', [KB_ON], 'notice period');
    assert.equal(hook.handleOf(out), null);
    assert.equal((await raw()).length, 0);
});

test('quickKBSearch (direct_chat): logging on records channel, query, user and passages; finish adds the answer', async () => {
    const out = await quickKBSearch('owner', [KB_ON], 'what is the notice period?', {
        log: { channel: 'direct_chat', channelRef: { conversationId: 'cv1' }, orgId: 'org1', userId: 'asker' },
    });
    const handle = hook.handleOf(out);
    assert.ok(handle, 'the handle rides on the array');
    assert.deepEqual(Object.keys(out), ['0'], 'and is not enumerable');
    await settle(handle);
    let [row] = await raw();
    assert.equal(row.channel, 'direct_chat');
    assert.equal(row.user_id, 'asker', 'the person asking, not the tenant id');
    assert.equal(row.chunk_count, 1);
    assert.equal(row.outcome, 'no_results', 'an answering channel waits for finish');
    let e = await entry(row);
    assert.equal(e.query, 'what is the notice period?');
    assert.equal(e.chunks[0].text, 'The notice period is two months.');
    assert.deepEqual(e.channelRef, { conversationId: 'cv1' });

    hook.finishLogs(handle, { outcome: 'answered', answer: 'Two months.', model: 'm-1', answerMs: 12, citations: [{ title: 'Policy', content: 'dropped', documentId: DOC_ON }] });
    await settle(handle);
    [row] = await raw();
    assert.equal(row.outcome, 'answered');
    e = await entry(row);
    assert.equal(e.answer, 'Two months.');
    assert.equal(e.model, 'm-1');
    assert.deepEqual(e.citations, [{ title: 'Policy', documentId: DOC_ON }], 'citations keep ids, not passage text');
});

test('quickKBSearch: a search that finds nothing is logged as no_results', async () => {
    found = [];
    const out = await quickKBSearch('u', [KB_ON], 'something unknown', { log: { channel: 'template_chat', channelRef: {}, userId: 'u' } });
    await settle(hook.handleOf(out));
    const [row] = await raw();
    assert.equal(row.outcome, 'no_results');
    assert.equal(row.chunk_count, 0);
});

test('trackAnswer: a model failure becomes outcome error with a short code, and is rethrown', async () => {
    const out = await quickKBSearch('u', [KB_ON], 'notice period', { log: { channel: 'kb_test', channelRef: { kbId: KB_ON }, userId: 'u' } });
    const handle = hook.handleOf(out);
    await settle(handle);
    const boom = Object.assign(new Error('secret provider text'), { status: 503 });
    await assert.rejects(hook.trackAnswer(handle, { model: 'm', answerOf: () => 'x' }, async () => { throw boom; }), /secret provider text/);
    await settle(handle);
    const [row] = await raw();
    assert.equal(row.outcome, 'error');
    assert.equal(row.error_code, 'http_503');
    assert.ok(!JSON.stringify(row).includes('secret provider text'));
});

test('trackAnswer: the answer, model and timing are stored on success', async () => {
    const out = await quickKBSearch('u', [KB_ON], 'notice period', { log: { channel: 'kb_test', channelRef: { kbId: KB_ON }, userId: 'u' } });
    const handle = hook.handleOf(out);
    await settle(handle);
    const res = await hook.trackAnswer(handle, { model: 'm-2', answerOf: (r) => r.text }, async () => ({ text: 'Answer [Source 1]' }));
    assert.equal(res.text, 'Answer [Source 1]');
    await settle(handle);
    const [row] = await raw();
    assert.equal(row.outcome, 'answered');
    assert.equal(row.model, 'm-2');
    assert.equal((await entry(row)).answer, 'Answer [Source 1]');
});

test('a turn with two searches: one final answer finishes both (agent kb_search used twice)', async () => {
    const turn = {};
    for (const q of ['first query', 'second query']) {
        const out = await quickKBSearch('u', [KB_ON], q, { log: { channel: 'agent_chat', channelRef: { agentId: 'ag1', conversationId: 'cv' }, orgId: 'org1', userId: 'u', carrier: turn } });
        await settle(hook.handleOf(out));
    }
    assert.equal(hook.turnLogsOf(turn).handles().length, 2);
    hook.finishTurnLogs(turn, { outcome: 'answered', answer: 'the final answer', model: 'm', answerMs: 5 });
    await settle(...hook.turnLogsOf(turn).handles());
    const rows = await raw();
    assert.equal(rows.length, 2);
    for (const r of rows) {
        assert.equal(r.outcome, 'answered');
        assert.equal((await entry(r)).answer, 'the final answer');
    }
    assert.deepEqual((await Promise.all(rows.map(entry))).map((e) => e.query).sort(), ['first query', 'second query']);
});

test('a turn that fails finishes every search as error', async () => {
    const turn = {};
    const out = await quickKBSearch('u', [KB_ON], 'q', { log: { channel: 'agent_chat', channelRef: {}, userId: 'u', carrier: turn } });
    await settle(hook.handleOf(out));
    hook.failTurnLogs(turn, new Error('provider down'), Date.now() - 10, 'm');
    await settle(...hook.turnLogsOf(turn).handles());
    const [row] = await raw();
    assert.equal(row.outcome, 'error');
    assert.equal(row.error_code, 'Error');
});

test('a carrier that never searched costs nothing', () => {
    assert.equal(hook.peekTurnLogs({}), null);
    hook.finishTurnLogs({}, { outcome: 'answered', answer: 'x' });
    hook.failTurnLogs(undefined, new Error('x'));
});

test('executeKbSearchTool (agent_chat): logs the tool query and passages, the handle rides on the payload without serialising', async () => {
    const agentStore = require('../../../stores/agentStore');
    agentStore.getForRuntime = async () => ({ config: { knowledge_base_ids: [KB_ON] } });
    require('../../agentRuntime/testAs').visibleKbIdsFor = async (ids) => ids;
    const { executeKbSearchTool } = require('../../../integrations/kbSearchTools');
    const ctx = { userId: 'asker', agentId: 'ag1', conversationId: 'cv-tool', log: { channel: 'agent_chat', channelRef: { agentId: 'ag1', conversationId: 'cv-tool' }, orgId: 'org1', userId: 'asker' } };

    const payload = await executeKbSearchTool('kb_search', { query: 'notice period' }, ctx);
    const handle = hook.handleOf(payload);
    assert.ok(handle);
    assert.ok(!('_queryLog' in JSON.parse(JSON.stringify(payload))));
    await settle(handle);
    const [row] = await raw();
    assert.equal(row.channel, 'agent_chat');
    assert.equal((await entry(row)).query, 'notice period');

    // without a `log` option nothing is written
    const quiet = await executeKbSearchTool('kb_search', { query: 'another one' }, { ...ctx, log: undefined, conversationId: 'cv-2' });
    assert.equal(hook.handleOf(quiet), null);
    await settle();
    assert.equal((await raw()).length, 1);
});

test('searchNotebookKB (notebook): the viewer is the user, the result carries the handle', async () => {
    const { searchNotebookKB } = require('../notebookKnowledgeSearch');
    const result = await searchNotebookKB({
        userId: 'owner', kbIds: [KB_ON], query: 'notice period',
        log: { channel: 'notebook', channelRef: { notebookId: 'nb1' }, orgId: 'org1', userId: 'viewer' },
    });
    const handle = hook.handleOf(result);
    assert.ok(handle);
    await settle(handle);
    const [row] = await raw();
    assert.equal(row.channel, 'notebook');
    assert.equal(row.user_id, 'viewer');
    assert.deepEqual((await entry(row)).channelRef, { notebookId: 'nb1' });
    const off = await searchNotebookKB({ userId: 'owner', kbIds: [KB_ON], query: 'x' });
    assert.equal(hook.handleOf(off), null);
});

test('searchWebpageKB (webpage): an anonymous visitor is never logged; the tool registers on the carrier', async () => {
    const { searchWebpageKB, executeWebpageKBSearchTool } = require('../../webpages/webpageKnowledgeSearch');
    const result = await searchWebpageKB({
        userId: 'author', kbIds: [KB_ON], query: 'notice period',
        log: { channel: 'webpage', channelRef: { webpageId: 'wp1', surface: 'public_share' }, orgId: 'org1', userId: null },
    });
    await settle(hook.handleOf(result));
    assert.equal((await raw()).length, 0, 'webpage needs an acknowledgement, an anonymous visitor cannot give one');

    await pg.exec('DELETE FROM kb_query_log');
    const turn = {};
    await executeWebpageKBSearchTool({ query: 'notice period' }, 'author', [KB_ON], {
        channel: 'webpage', channelRef: { webpageId: 'wp1', surface: 'chat' }, orgId: 'org1', userId: 'author', carrier: turn,
    });
    assert.equal(hook.turnLogsOf(turn).handles().length, 1);
    await settle(...hook.turnLogsOf(turn).handles());
    const [row] = await raw();
    assert.equal(row.user_id, 'author');
    assert.equal(row.channel, 'webpage');
});

test('groundWithKB (studio_ai_generate): the viewer is the user, not the app owner; no viewer means no search and no row', async () => {
    const aiRuntime = require('../../../appStudio/aiRuntime');
    const askerContext = require('../askerContext');
    askerContext.askerContext = async () => ({ orgIds: new Set(['org1']), userGroups: [] });
    const app = { id: 'app1', userId: 'owner', organizationId: 'org1' };
    const log = { channel: 'studio_ai_generate', channelRef: { appId: 'app1', actionId: 'act1' }, orgId: 'org1' };

    const ground = await aiRuntime.groundWithKB(app, { knowledgeBaseIds: [KB_ON], query: 'notice period', viewer: { id: 'viewer1' }, log });
    assert.ok(ground.context.includes('two months'));
    const handle = hook.handleOf(ground.chunks);
    assert.ok(handle);
    await settle(handle);
    const [row] = await raw();
    assert.equal(row.channel, 'studio_ai_generate');
    assert.equal(row.user_id, 'viewer1');
    assert.deepEqual((await entry(row)).channelRef, { appId: 'app1', actionId: 'act1' });

    await pg.exec('DELETE FROM kb_query_log');
    const none = await aiRuntime.groundWithKB(app, { knowledgeBaseIds: [KB_ON], query: 'notice period', viewer: null, log });
    assert.deepEqual(none.chunks, []);
    await settle();
    assert.equal((await raw()).length, 0, 'issue #599: nothing is searched without a viewer, so nothing is logged');
});

test('groundAiStepWithKB (automation_ai_step): real runs log with automation, run and step; a dry run does not', async () => {
    const { groundAiStepWithKB } = require('../../automationRunner/aiStepGrounding');
    const deps = { knowledgeSearch: () => require('../../agentRuntime/knowledgeSearch'), kbVisibility: () => ({ filterKbIdsForUser: async (ids) => ids }) };
    const ctx = { userId: 'owner', orgId: 'org1', automationId: 'auto1', runId: 'run1' };
    const step = { id: 'step1', knowledgeBaseIds: [KB_ON] };

    const live = await groundAiStepWithKB(step, ctx, 'notice period', 'live', null, deps);
    assert.ok(live.queryLogHandle);
    await settle(live.queryLogHandle);
    const [row] = await raw();
    assert.equal(row.channel, 'automation_ai_step');
    assert.deepEqual((await entry(row)).channelRef, { automationId: 'auto1', runId: 'run1', stepId: 'step1' });

    await pg.exec('DELETE FROM kb_query_log');
    const dry = await groundAiStepWithKB(step, ctx, 'notice period', 'dry_run', null, deps);
    assert.equal(dry.queryLogHandle, null);
    await settle();
    assert.equal((await raw()).length, 0);
});

test('a recorder that cannot write never breaks the search', async () => {
    rec._setRecorderDeps({
        store: { ...store, insertEntries: async () => { throw new Error('db down'); } },
        hasFeature: async () => true, log: { warn: (m) => warnings.push(m) },
    });
    const out = await quickKBSearch('u', [KB_ON], 'notice period', { log: { channel: 'direct_chat', channelRef: {}, userId: 'u' } });
    assert.equal(out.length, 1);
    await settle(hook.handleOf(out));
    assert.equal((await raw()).length, 0);
});
