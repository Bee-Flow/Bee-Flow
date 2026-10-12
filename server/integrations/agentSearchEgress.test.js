'use strict';
/**
 * A chat-dispatched web search writes one egress row, on success and on a
 * throw, and hands the search's own result or error back unchanged.
 *
 * Run: node --test integrations/agentSearchEgress.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { runAgentSearchWithEgress } = require('./agentSearchEgress');

const PROBE = Object.freeze({ sealed: true, peers: [{ host: 'api.search.test', ip: '203.0.113.9' }] });

function deps(search) {
    const rows = [];
    let clock = 1000;
    return {
        rows,
        captureCall: async (fn) => {
            try { return { ok: true, value: await fn(), error: null, probe: PROBE }; } catch (error) { return { ok: false, value: undefined, error, probe: PROBE }; }
        },
        logToolEgress: (row) => rows.push(row),
        executeAgentSearchTool: search,
        now: () => { clock += 25; return clock; },
    };
}

const EGRESS = { source: 'webpage_chat', ids: { organization_id: 'org1', user_id: 'u1', conversation_id: 'w1' } };

test('a successful search returns its result and writes one row with the probe', async () => {
    const d = deps(async (name, args) => ({ results: [name, args.query] }));
    const out = await runAgentSearchWithEgress('web_search', { query: 'bees' }, EGRESS, d);
    assert.deepEqual(out, { results: ['web_search', 'bees'] });
    assert.equal(d.rows.length, 1);
    const row = d.rows[0];
    assert.equal(row.toolName, 'web_search');
    assert.equal(row.source, 'webpage_chat');
    assert.equal(row.probe, PROBE);
    assert.equal(row.error, null);
    assert.deepEqual(row.ids, EGRESS.ids);
    assert.equal(row.durationMs, 25);
});

test('a failing search still writes its row, then rethrows the same error', async () => {
    const boom = new Error('provider down');
    const d = deps(async () => { throw boom; });
    await assert.rejects(() => runAgentSearchWithEgress('web_search', { query: 'x' }, EGRESS, d), (e) => e === boom);
    assert.equal(d.rows.length, 1);
    assert.equal(d.rows[0].error, boom);
    assert.equal(d.rows[0].result, null);
});

test('read_url goes to the page reader, not the search provider, and still writes its row', async () => {
    const d = deps(async () => { throw new Error('search provider must not be called'); });
    d.executeReadUrlTool = async (name, args) => ({ url: args.url, text: 'page' });
    const out = await runAgentSearchWithEgress('read_url', { url: 'https://example.test/a' }, EGRESS, d);
    assert.deepEqual(out, { url: 'https://example.test/a', text: 'page' });
    assert.equal(d.rows.length, 1);
    assert.equal(d.rows[0].toolName, 'read_url');
});
