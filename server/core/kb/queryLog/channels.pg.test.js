'use strict';

/**
 * The channel hooks of the KB query log, driven through the REAL search functions with the retrieval
 * (searchLocally) and the access checks stubbed: logging off writes nothing; logging on writes a row
 * with the channel, the query and the passages; the answering step fills answer, model and outcome;
 * a failing model call becomes outcome `error`; one answer finishes every search of a turn.
 *
 * The channels of first-party modules (webpage, studio_ai_generate, automation_ai_step) are in
 * channels.<module>.pg.test.js beside this file, over the same world (channels.testkit.js).
 *
 * Run: cd server && node --test core/kb/queryLog/channels.pg.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const rec = require('./recorder.mts');
const hook = require('./hook.mts');
const { useChannelWorld, store, raw, entry, settle, warnings, setFound, getFound, KB_ON, KB_OFF, DOC_ON, DOC_OFF } = require('./channels.testkit');
useChannelWorld();

const { quickKBSearch } = require('../../agentRuntime/knowledgeSearch');

test('quickKBSearch (direct_chat): logging off writes nothing', async () => {
    setFound([{ ...getFound()[0], document_id: DOC_OFF }]);
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
    setFound([]);
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
