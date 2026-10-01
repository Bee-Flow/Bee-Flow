/**
 * The AI builder's auto-bind of a required input, held to the one matching
 * rule the web builder's auto-map uses (shared/mapping/match.mjs). The
 * shared cases in shared/mapping/matchCases.mjs run here and in agent-hub's
 * autoMapInputs.test.js, so the two cannot drift apart again.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { applyToolCall, emptyDefinition } = require('../../builderTools');
const { matchItemFields, autoBindRequiredInputs } = require('./inputBindings');

const ENVELOPE = ['index', 'item', 'output', 'status'];

test('the shared cases bind the same field the web auto-map binds', async () => {
    const { MATCH_CASES } = await import('../../../shared/mapping/matchCases.mjs');
    for (const c of MATCH_CASES) {
        const names = Object.keys(c.item);
        const res = c.fanout
            ? { source: 'fanout', fields: [...ENVELOPE, ...names.map(n => `output.${n}`)] }
            : { source: 'runtime', fields: names };
        const { matches } = matchItemFields(res, Object.keys(c.inputs));
        const got = Object.fromEntries(matches.map(m => [m.key, m.path]));
        const want = Object.fromEntries(Object.entries({ ...c.expect, ...c.aiBuilder }).filter(([, p]) => p !== null));
        assert.deepStrictEqual(got, want, c.name);
    }
});

test('a name a fan-out entry has under output AND item is ambiguous, not guessed', () => {
    const res = { source: 'fanout', fields: [...ENVELOPE, 'output.content', 'item.content', 'item.path'] };
    const r = matchItemFields(res, ['content', 'path']);
    assert.deepStrictEqual(r.matches, [{ key: 'path', path: 'item.path', how: 'exact' }]);
    assert.deepStrictEqual(r.ambiguous, [{ key: 'content', paths: ['output.content', 'item.content'] }]);
    assert.deepStrictEqual(matchItemFields({ fields: null }, ['x']), { matches: [], ambiguous: [] });
});

function wrap() {
    const str = { type: 'string' };
    return {
        userId: 'u_test',
        def: emptyDefinition(),
        _inputSchemasByTool: {
            gmail_search: { type: 'object', properties: { query: str }, required: ['query'] },
            gmail_read: { type: 'object', properties: { messageId: str }, required: ['messageId'] },
        },
        _inspectedTools: new Set(['gmail_search', 'gmail_read']),
    };
}

test('regression: a required messageId binds the item\'s id, as the web auto-map does', async () => {
    const dw = wrap();
    await applyToolCall('builder_propose_trigger', { kind: 'manual' }, dw);
    const search = await applyToolCall('builder_add_action', { tool: 'gmail_search', inputs: { query: { kind: 'literal', value: 'is:unread' } } }, dw);
    assert.ok(!search.error, search.error);
    const read = await applyToolCall('builder_add_action', {
        tool: 'gmail_read', forEach: { overRef: `steps.${search.added.id}.output.results`, itemVar: 'm' },
    }, dw);
    assert.ok(!read.error, `bound instead of refused: ${read.error}`);
    assert.deepStrictEqual(read.added.inputs, { messageId: { kind: 'ref', path: 'loop.m.id' } });
    assert.ok(read._warnings.some(w => /^input "messageId" was not bound — bound to loop\.m\.id/.test(w)), JSON.stringify(read._warnings));
});

// A list step whose rows carry a column with a space, one with a dot (a CSV,
// datatable or sheet header) and a page token.
function listGraph(extra = {}) {
    return {
        graph: {
            trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
            steps: [{ id: 'up', type: 'integration_action', tool: 'sheet_rows', inputs: {} }, ...(extra.steps || [])],
        },
        draftWrap: { _runtimeShapes: { sheet_rows: { rows: { _array: { 'Message ID': 'm1', 'customer.id': 'c1', pageToken: 'p2' } } } } },
    };
}

test('regression: a key with a space or a dot is bound as a ref the runtime can read', () => {
    const { graph, draftWrap } = listGraph();
    const forEach = { overRef: 'steps.up.output.rows', itemVar: 'f' };
    const r = autoBindRequiredInputs({ graph, tool: 'gmail_read', inputs: {}, forEach, missing: ['messageId', 'customer_id'], draftWrap });
    assert.deepStrictEqual(r.inputs, {
        messageId: { kind: 'ref', path: 'loop.f["Message ID"]' },
        customer_id: { kind: 'ref', path: 'loop.f["customer.id"]' },
    });
    // Offered, not bound, when the step does not repeat yet: the same paths.
    const filtered = listGraph({ steps: [{ id: 'flt', type: 'filter', arrayRef: 'steps.up.output.rows', expr: 'true' }] });
    const offer = autoBindRequiredInputs({ graph: filtered.graph, tool: 'gmail_read', inputs: {}, missing: ['messageId'], afterStepId: 'flt', draftWrap: filtered.draftWrap });
    assert.deepStrictEqual(offer.candidates.map(c => [c.why, c.path]), [['needs-forEach', 'loop.f["Message ID"]']]);
});

test('regression: a required pageToken the item carries under that name is bound, as it was before the shared rule', () => {
    const { graph, draftWrap } = listGraph();
    const forEach = { overRef: 'steps.up.output.rows', itemVar: 'f' };
    const r = autoBindRequiredInputs({ graph, tool: 'gmail_search', inputs: {}, forEach, missing: ['pageToken'], draftWrap });
    assert.deepStrictEqual(r.bound, [{ key: 'pageToken', path: 'loop.f.pageToken', from: 'forEach' }]);
});
