/**
 * Regression tests for two load-bearing Claude-adapter behaviours the
 * builder optimizations rely on:
 *
 * 1. mergeToolResultRuns — an assistant turn with SEVERAL tool_use blocks is
 *    answered by one role:'tool' message per result upstream; the adapter
 *    must merge those into ONE user message (Anthropic requires every
 *    tool_result for a turn in the single immediately-following user
 *    message). Before the merge, repairToolPairs silently dropped every
 *    pair but the first — parallel tool calls lost their results.
 *
 * 2. extractSystem — multiple system messages become separate blocks and
 *    ONLY the first carries the 1h cache_control breakpoint, so the static
 *    prompt stays cached across turns while the per-turn dynamic context
 *    (draft state) rides in a later, uncached block.
 *
 * Run: node --test core/providers/claudeToolResultMerge.test.js
 * Pure message-shaping functions — no network, no SDK client.
 */

const assert = require('assert');
const ClaudeProvider = require('./claude');

const p = new ClaudeProvider();

// ── 1. parallel tool-call round survives normalization intact ──────────────
{
    const tc = (id) => ({ id, type: 'function', function: { name: `tool_${id}`, arguments: '{}' } });
    const messages = [
        { role: 'system', content: 'static rules' },
        { role: 'user', content: 'build it' },
        { role: 'assistant', content: null, tool_calls: [tc('t1'), tc('t2'), tc('t3')] },
        { role: 'tool', tool_call_id: 't1', content: '{"ok":1}' },
        { role: 'tool', tool_call_id: 't2', content: '{"ok":2}' },
        { role: 'tool', tool_call_id: 't3', content: '{"ok":3}' },
    ];
    const normalized = p.normalizeMessages(messages);

    const assistant = normalized.find(m => m.role === 'assistant');
    const toolUses = assistant.content.filter(b => b.type === 'tool_use');
    assert.strictEqual(toolUses.length, 3, 'ALL tool_use blocks survive (repairToolPairs must not orphan them)');

    const resultCarriers = normalized.filter(m => m.role === 'user'
        && Array.isArray(m.content) && m.content.some(b => b.type === 'tool_result'));
    assert.strictEqual(resultCarriers.length, 1, 'the three tool messages merged into ONE user message');
    const ids = resultCarriers[0].content.filter(b => b.type === 'tool_result').map(b => b.tool_use_id);
    assert.deepStrictEqual(ids, ['t1', 't2', 't3'], 'every tool_result kept, in order');
}

// ── a trailing plain-text user message is NOT merged into the result run ───
{
    const messages = [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'x1', type: 'function', function: { name: 'a', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'x1', content: '{"ok":1}' },
        { role: 'user', content: '[VALIDATION REPORT — machine-generated, not from the human user]\nno errors' },
    ];
    const normalized = p.normalizeMessages(messages);
    const last = normalized[normalized.length - 1];
    assert.strictEqual(last.role, 'user');
    const lastText = typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
    assert.ok(lastText.includes('[VALIDATION REPORT'), 'plain-text user note stays its own message');
    assert.ok(!(Array.isArray(last.content) && last.content.some(b => b.type === 'tool_result')),
        'validation note not folded into the tool_result message');
}

// ── 2. extractSystem: breakpoint on block[0] only ───────────────────────────
{
    const blocks = p.extractSystem([
        { role: 'system', content: 'STATIC prompt + catalog' },
        { role: 'user', content: 'hi' },
        { role: 'system', content: 'DYNAMIC draft state' },
    ]);
    assert.strictEqual(blocks.length, 2, 'both system messages become blocks');
    assert.deepStrictEqual(blocks[0].cache_control, { type: 'ephemeral', ttl: '1h' }, '1h breakpoint on the first block');
    assert.strictEqual(blocks[1].cache_control, undefined, 'later blocks carry NO cache_control (mutating them must not churn cache writes)');
    assert.ok(blocks[0].text.includes('STATIC'), 'order preserved: static first');
    assert.ok(blocks[1].text.includes('DYNAMIC'), 'dynamic block second');
}

console.log('claudeToolResultMerge.test.js: all merge/extractSystem tests passed');
