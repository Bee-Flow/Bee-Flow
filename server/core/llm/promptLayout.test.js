/**
 * core/llm/promptLayout — moving the volatile system block behind the history.
 *
 * Run: cd server && node --test --test-force-exit core/llm/promptLayout.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { placeVolatileBlock, hoistVolatileBlock, supportsLateSystemBlock } = require('./promptLayout');

const roles = (ms) => ms.map(m => m.role).join(',');
const mk = () => {
    const stable = { role: 'system', content: 'stable' };
    const vol = { role: 'system', content: 'Now: …' };
    const u1 = { role: 'user', content: 'u1' };
    const a1 = { role: 'assistant', content: 'a1' };
    const u2 = { role: 'user', content: 'u2' };
    return { stable, vol, u1, a1, u2 };
};

test('the assembly shape [stable, volatile, history…, user] becomes [stable, history…, volatile, user]', () => {
    const { stable, vol, u1, a1, u2 } = mk();
    const messages = [stable, vol, u1, a1, u2];
    const out = placeVolatileBlock(messages, vol);
    assert.strictEqual(out, messages, 'same array, mutated in place');
    assert.deepStrictEqual(out, [stable, u1, a1, vol, u2]);
    assert.strictEqual(out[3], vol, 'moved by reference, not copied');
});

test('idempotent — a second call after tool rounds leaves the block where it is', () => {
    const { stable, vol, u1, a1, u2 } = mk();
    const messages = placeVolatileBlock([stable, vol, u1, a1, u2], vol);
    const toolCall = { role: 'assistant', content: null, tool_calls: [{ id: 't1' }] };
    const toolResult = { role: 'tool', tool_call_id: 't1', content: '{}' };
    messages.push(toolCall, toolResult);
    const before = [...messages];
    placeVolatileBlock(messages, vol);
    assert.deepStrictEqual(messages, before);
    assert.strictEqual(roles(messages), 'system,user,assistant,system,user,assistant,tool');
});

test('a block that is not in the list is inserted, never duplicated', () => {
    const { stable, vol, u1 } = mk();
    const messages = [stable, u1];
    placeVolatileBlock(messages, vol);
    assert.deepStrictEqual(messages, [stable, vol, u1]);
    placeVolatileBlock(messages, vol);
    assert.strictEqual(messages.filter(m => m === vol).length, 1);
});

test('with no user message the block is appended', () => {
    const { stable, vol } = mk();
    assert.deepStrictEqual(placeVolatileBlock([stable, vol], vol), [stable, vol]);
    assert.deepStrictEqual(placeVolatileBlock([stable], vol), [stable, vol]);
});

test('a single-turn conversation keeps its shape', () => {
    // [stable, vol, u1] is already "volatile immediately before the last user".
    const { stable, vol, u1 } = mk();
    assert.deepStrictEqual(placeVolatileBlock([stable, vol, u1], vol), [stable, vol, u1]);
});

test('garbage in, same thing out', () => {
    const { vol } = mk();
    assert.strictEqual(placeVolatileBlock(null, vol), null);
    const messages = [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }];
    assert.deepStrictEqual(placeVolatileBlock(messages, undefined), messages);
});

test('the safe set: adapters that extract or fold system messages, plus local; not Scaleway', () => {
    for (const t of ['claude', 'google', 'google-vertex', 'openai', 'azure', 'mistral']) {
        assert.ok(supportsLateSystemBlock(t), t);
    }
    assert.ok(supportsLateSystemBlock('llamacpp', { isLocal: true }));
    assert.ok(supportsLateSystemBlock(undefined, { isLocal: true }), 'a URL-guessed local adapter has no stored type');
    assert.strictEqual(supportsLateSystemBlock('scaleway'), false, 'vLLM + strict templates (Gemma) reject a late system role and nothing folds it');
    assert.strictEqual(supportsLateSystemBlock('llamacpp'), false, 'the stored type alone is not the signal — the caller passes isLocal');
    assert.strictEqual(supportsLateSystemBlock(undefined), false);
});

test('hoistVolatileBlock restores the assembly shape, and the two are inverses', () => {
    const { stable, vol, u1, a1, u2 } = mk();
    const messages = [stable, vol, u1, a1, u2];
    placeVolatileBlock(messages, vol);
    hoistVolatileBlock(messages, vol);
    assert.deepStrictEqual(messages, [stable, vol, u1, a1, u2]);
    hoistVolatileBlock(messages, vol);
    assert.deepStrictEqual(messages, [stable, vol, u1, a1, u2], 'idempotent');
    // No stable block in front: the volatile block leads.
    const bare = [u1, a1];
    hoistVolatileBlock(bare, vol);
    assert.deepStrictEqual(bare, [vol, u1, a1]);
});
