/**
 * Unit tests — replaying stored reasoning back to Claude, and where the prompt
 * cache breakpoints land.
 *
 * Run: node --test core/providers/claude.thinkingReplay.test.js
 *
 * Two regressions are pinned here:
 *
 *  1. Extended thinking never survived a turn. The adapter rebuilt thinking
 *     blocks only for assistant messages carrying `tool_calls`, so an ordinary
 *     question→answer chat replayed none of its reasoning — and `thinking` was
 *     stripped from every message before the adapter even saw it
 *     (utils/messageUtils.sanitizeMessages), so the tool-call path could not
 *     fire either. Both halves are covered here.
 *
 *  2. The message-level cache breakpoint searched backwards for a TEXT block.
 *     An uploaded PDF is pushed as `text` (extracted) + `document` (raw bytes),
 *     so the breakpoint parked before the expensive half and the document was
 *     re-billed at full price on every follow-up question.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const ClaudeProvider = require('./claude');
const { sanitizeMessages, stripInternalFields } = require('../../utils/messageUtils');

const SIGNED = { id: 'p0', text: 'because the invoice total did not add up', signature: 'sig-abc' };
const REDACTED = { id: 'p1', redacted: true, redactedData: 'ENCRYPTED-PAYLOAD' };

const blocksOf = (msg) => (Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: msg.content }]);
const typesOf = (msg) => blocksOf(msg).map(b => b.type);

// ── Replay ──────────────────────────────────────────────────────────────

test('REGRESSION: a plain assistant turn replays its signed thinking', () => {
    const p = new ClaudeProvider();
    const out = p.normalizeMessages([
        { role: 'user', content: 'why?' },
        { role: 'assistant', content: 'The total was wrong.', thinking: [SIGNED] },
        { role: 'user', content: 'and now?' },
    ]);

    assert.deepStrictEqual(typesOf(out[1]), ['thinking', 'text'],
        'thinking must precede the answer text, exactly as Anthropic returned it');
    assert.strictEqual(out[1].content[0].thinking, SIGNED.text);
    assert.strictEqual(out[1].content[0].signature, SIGNED.signature);
});

test('an assistant turn with tool calls replays thinking before the tool_use blocks', () => {
    const p = new ClaudeProvider();
    const out = p.normalizeMessages([
        { role: 'user', content: 'look it up' },
        {
            role: 'assistant',
            content: null,
            thinking: [SIGNED],
            tool_calls: [{ id: 'tu1', function: { name: 'search', arguments: '{"q":"x"}' } }],
        },
        { role: 'tool', tool_call_id: 'tu1', content: 'result' },
        { role: 'assistant', content: 'found it' },
    ]);

    assert.deepStrictEqual(typesOf(out[1]), ['thinking', 'tool_use'],
        'Anthropic requires signed thinking in front of tool_use on replay');
});

test('redacted thinking is replayed from its opaque payload', () => {
    const p = new ClaudeProvider();
    const out = p.normalizeMessages([
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'a', thinking: [REDACTED] },
    ]);

    assert.deepStrictEqual(typesOf(out[1]), ['redacted_thinking', 'text']);
    assert.strictEqual(out[1].content[0].data, 'ENCRYPTED-PAYLOAD');
});

test('unreplayable parts are dropped, not sent as invalid blocks', () => {
    const p = new ClaudeProvider();
    const out = p.normalizeMessages([
        { role: 'user', content: 'q' },
        {
            role: 'assistant',
            content: 'a',
            thinking: [
                { id: 'x', text: 'no signature — Anthropic rejects this' },
                { id: 'y', redacted: true },      // redacted with no payload
                SIGNED,
            ],
        },
    ]);

    assert.deepStrictEqual(typesOf(out[1]), ['thinking', 'text']);
    assert.strictEqual(out[1].content[0].thinking, SIGNED.text);
});

test("REGRESSION: a signed block with empty text (display:'omitted') is still replayed", () => {
    const p = new ClaudeProvider();
    // On Opus 5 / Sonnet 5 / Opus 4.8 / 4.7 the API returns exactly this shape
    // unless display is set — the reasoning lives inside the signature, which
    // the server decrypts. Dropping it loses the whole turn's reasoning.
    const out = p.normalizeMessages([
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'a', thinking: [{ id: 'p0', text: '', signature: 'sig-omitted' }] },
    ]);

    assert.deepStrictEqual(typesOf(out[1]), ['thinking', 'text']);
    assert.strictEqual(out[1].content[0].signature, 'sig-omitted');
    assert.strictEqual(out[1].content[0].thinking, '');
});

test('a thinking-only assistant turn drops the thinking rather than emitting an invalid message', () => {
    const p = new ClaudeProvider();
    const out = p.normalizeMessages([
        { role: 'user', content: 'q' },
        { role: 'assistant', content: '', thinking: [SIGNED] },
        { role: 'user', content: 'still there?' },
    ]);

    // Reasoning with nothing to anchor it to is not a valid assistant turn.
    assert.ok(!JSON.stringify(out).includes(SIGNED.signature));
});

test('thinking off → nothing is replayed (the blocks would be dead weight)', () => {
    const p = new ClaudeProvider();
    const history = [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'a', thinking: [SIGNED] },
    ];

    assert.deepStrictEqual(typesOf(p.normalizeMessages(history, { keepThinking: false })[1]), ['text']);

    const params = p._buildSdkParams('claude-sonnet-4-6', history, { reasoningEffort: 'none' });
    assert.strictEqual(params.thinking, undefined);
    assert.ok(!JSON.stringify(params.messages).includes(SIGNED.signature),
        'a thinking-disabled request must not carry thinking blocks');
});

test('_buildSdkParams replays thinking when thinking is on', () => {
    const p = new ClaudeProvider();
    const params = p._buildSdkParams('claude-opus-4-8', [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'a', thinking: [SIGNED] },
        { role: 'user', content: 'follow up' },
    ], {});

    assert.strictEqual(params.thinking.type, 'adaptive');
    assert.ok(JSON.stringify(params.messages).includes(SIGNED.signature));
});

// ── display: the reason the reasoning panel was empty ───────────────────

test("REGRESSION: adaptive thinking asks for display:'summarized'", () => {
    const p = new ClaudeProvider();
    // Without this the API returns thinking blocks with an EMPTY `thinking`
    // field on Opus 5 / Sonnet 5 / Opus 4.8 / 4.7 / Fable 5 (their default is
    // 'omitted') and emits no thinking_delta events at all — so the product's
    // reasoning panel finds no text and hides itself. The model still thinks
    // and is still billed for it; only the visibility differs.
    for (const model of ['claude-sonnet-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-sonnet-4-6']) {
        assert.strictEqual(p.buildThinking(model, {}).thinking.display, 'summarized', model);
        assert.strictEqual(p._buildSdkParams(model, [{ role: 'user', content: 'hi' }], {}).thinking.display,
            'summarized', model);
    }
});

test("display is never sent with thinking disabled (the API rejects that pair)", () => {
    const p = new ClaudeProvider();
    assert.strictEqual(p.buildThinking('claude-sonnet-5', { reasoningEffort: 'none' }), undefined);
    assert.strictEqual(
        p._buildSdkParams('claude-sonnet-5', [{ role: 'user', content: 'hi' }], { reasoningEffort: 'none' }).thinking,
        undefined);
});

test('the legacy budget_tokens path is left alone — those models already default to summarized', () => {
    const p = new ClaudeProvider();
    const cfg = p.buildThinking('claude-sonnet-4-6', { budgetTokens: 4096 });
    assert.deepStrictEqual(cfg.thinking, { type: 'enabled', budget_tokens: 4096 });
});

// ── The strip that made all of the above unreachable ─────────────────────

test('REGRESSION: sanitizeMessages keeps `thinking`, the wire adapters drop it', () => {
    const msgs = [{ role: 'assistant', content: 'a', thinking: [SIGNED], parentId: 'nope', kbSources: [1] }];

    const clean = sanitizeMessages(msgs);
    assert.deepStrictEqual(clean[0].thinking, [SIGNED],
        'stripping this here is what made reasoning vanish from every multi-turn chat');
    assert.strictEqual(clean[0].parentId, undefined, 'unrelated internals still go');
    assert.strictEqual(clean[0].kbSources, undefined);

    // Adapters that hand `messages` to a provider SDK verbatim strip it again.
    const wire = stripInternalFields(clean);
    assert.strictEqual(wire[0].thinking, undefined);
    assert.strictEqual(wire[0].content, 'a');
});

// ── Retry when a signature cannot be verified ────────────────────────────

test('chat(): an unverifiable thinking signature retries once without the blocks', async () => {
    const p = new ClaudeProvider();
    const calls = [];
    let n = 0;
    p.createClient = () => ({
        messages: {
            create: async (params) => {
                calls.push(JSON.parse(JSON.stringify(params)));
                if (++n === 1) {
                    const err = new Error('invalid_request_error');
                    err.status = 400;
                    err.error = { error: { message: 'messages.1.content.0.thinking: signature verification failed' } };
                    throw err;
                }
                return { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: {} };
            },
        },
    });

    const result = await p.chat('sk-ant-api-key', null, 'claude-opus-4-8', [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'a', thinking: [SIGNED] },
        { role: 'user', content: 'follow up' },
    ], {});

    assert.strictEqual(result.content, 'ok');
    assert.strictEqual(calls.length, 2, 'exactly one retry');
    assert.ok(JSON.stringify(calls[0].messages).includes(SIGNED.signature));
    assert.ok(!JSON.stringify(calls[1].messages).includes(SIGNED.signature), 'retry dropped the blocks');
});

// ── Cache breakpoint placement ───────────────────────────────────────────

function findCacheMarkedBlocks(messages) {
    const out = [];
    for (const m of messages) {
        if (!Array.isArray(m.content)) continue;
        for (const b of m.content) if (b?.cache_control) out.push(b);
    }
    return out;
}

test('REGRESSION: the breakpoint covers a trailing document block, not just the text', () => {
    const p = new ClaudeProvider();
    const out = p.normalizeMessages([
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
        { role: 'user', content: 'and?' },
        { role: 'assistant', content: 'go on' },
        {
            role: 'user',
            content: [
                { type: 'text', text: 'summarise this invoice' },
                { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBER' } },
            ],
        },
    ]);

    const last = out[out.length - 1];
    const marked = last.content.filter(b => b.cache_control);
    assert.strictEqual(marked.length, 1);
    assert.strictEqual(marked[0].type, 'document',
        'a breakpoint before the document leaves the expensive half outside the cached prefix');
});

test('a growing chat gets a trailing breakpoint one turn back (20-block lookback)', () => {
    const p = new ClaudeProvider();
    const history = [];
    for (let i = 0; i < 5; i++) {
        history.push({ role: 'user', content: `q${i}` });
        history.push({ role: 'assistant', content: `a${i}` });
    }
    const out = p.normalizeMessages(history);
    const marked = findCacheMarkedBlocks(out);

    assert.strictEqual(marked.length, 2,
        'one write for the current turn, one refresh keeping the previous write reachable');
});

test('the 4-breakpoint API cap is never exceeded, upstream markers included', () => {
    const p = new ClaudeProvider();
    const history = [
        { role: 'user', content: [{ type: 'text', text: 'file a', cache_control: { type: 'ephemeral' } }] },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: [{ type: 'text', text: 'file b', cache_control: { type: 'ephemeral' } }] },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'and now summarise both' },
        { role: 'assistant', content: 'sure' },
        { role: 'user', content: 'go' },
    ];
    const marked = findCacheMarkedBlocks(p.normalizeMessages(history));

    // extractSystem spends the fourth on the 1-hour system breakpoint.
    assert.ok(marked.length <= 3, `messages may use at most 3 breakpoints, got ${marked.length}`);
});
