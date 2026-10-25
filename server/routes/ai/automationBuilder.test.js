/**
 * Unit tests for the automation-builder route's internal helpers:
 * parseToolArgs, isTransientChatError, chatWithRetry, applyBuilderTierFloor.
 *
 * Run: node routes/ai/automationBuilder.test.js
 *
 * No HTTP/DB needed — we exercise the exported `_test` helpers directly.
 * (Requiring the route opens a DB pool, so we process.exit at the end.)
 */

const assert = require('assert');
const {
    parseToolArgs, isTransientChatError, chatWithRetry, applyBuilderTierFloor, validateLayerForSummary, sanitiseLayerSummary,
    accumulateUsage, renderValidationNote, sanitizeHistory, VALIDATION_NOTE_PREFIX, applyPlanMarkDone,
    isTruncatedStop, truncationRetryMessages, TRUNCATION_PLACEHOLDER,
} = require('./automationBuilder')._test;

(async () => {
    // ── truncation guard helpers ──
    for (const r of ['length', 'max_tokens', 'max_output_tokens', 'MAX_TOKENS']) {
        assert.strictEqual(isTruncatedStop(r), true, `${r} is a max_tokens cut-off`);
    }
    for (const r of ['stop', 'tool_calls', 'end_turn', null, undefined, '']) {
        assert.strictEqual(isTruncatedStop(r), false, `${String(r)} is not a cut-off`);
    }
    {
        const [a, u] = truncationRetryMessages(null, []);
        assert.strictEqual(a.role, 'assistant');
        assert.strictEqual(a.content, TRUNCATION_PLACEHOLDER, 'no text → non-empty placeholder (an empty assistant block is an Anthropic 400)');
        assert.ok(a.content.trim().length > 0);
        assert.strictEqual('thinking' in a, false, 'no thinking blocks → no thinking key');
        assert.strictEqual(u.role, 'user');
        assert.ok(u.content.startsWith(VALIDATION_NOTE_PREFIX), 'note carries the machine-generated prefix…');
        assert.deepStrictEqual(sanitizeHistory([{ role: 'user', content: 'hi' }, u]), [{ role: 'user', content: 'hi' }], '…so sanitizeHistory drops it across turns');
        assert.ok(/tool call/i.test(u.content), 'tells the model to answer with the tool call');
    }
    {
        const th = [{ text: 'hmm', signature: 'sig' }];
        const [a] = truncationRetryMessages('  partial text ', th);
        assert.strictEqual(a.content, '  partial text ', 'the model\'s own text is kept when there is any');
        assert.deepStrictEqual(a.thinking, th, 'signed thinking is replayed like on a normal turn');
        assert.strictEqual(truncationRetryMessages('   ', [])[0].content, TRUNCATION_PLACEHOLDER, 'whitespace-only counts as empty');
    }

    // ── parseToolArgs ──
    assert.deepStrictEqual(parseToolArgs('{"a":1}', 'builder_add_action'), { args: { a: 1 }, truncated: false }, 'valid JSON parses');
    assert.deepStrictEqual(parseToolArgs({ a: 1 }, 'builder_add_action'), { args: { a: 1 }, truncated: false }, 'object passthrough');
    assert.deepStrictEqual(parseToolArgs('', 'builder_summarise'), { args: {}, truncated: false }, 'empty args ok for paramless tool');
    assert.deepStrictEqual(parseToolArgs('', 'builder_add_action'), { args: {}, truncated: false }, 'empty string is not a truncation');
    assert.deepStrictEqual(parseToolArgs('{}', 'builder_add_action'), { args: {}, truncated: false }, '"{}" is valid empty args');
    {
        const r = parseToolArgs('{"tool":"gmail_search","inputs":{"q":', 'builder_add_action');
        assert.strictEqual(r.truncated, true, 'truncated JSON for a param tool flags truncated');
        assert.deepStrictEqual(r.args, {}, 'truncated args resolve to {}');
    }
    assert.strictEqual(parseToolArgs('not json', 'builder_finalize').truncated, false, 'bad args for paramless tool is not a truncation');

    // ── isTransientChatError ──
    assert.strictEqual(isTransientChatError({ status: 429 }), true, '429 is transient');
    assert.strictEqual(isTransientChatError({ status: 503 }), true, '503 is transient');
    assert.strictEqual(isTransientChatError({ status: 401 }), false, '401 is permanent');
    assert.strictEqual(isTransientChatError({ status: 400 }), false, '400 is permanent');
    assert.strictEqual(isTransientChatError(new Error('Rate limit exceeded')), true, 'rate-limit message is transient');
    assert.strictEqual(isTransientChatError(new Error('socket hang up')), true, 'network message is transient');
    assert.strictEqual(isTransientChatError(new Error('invalid api key')), false, 'auth message is permanent');

    // ── chatWithRetry ──
    {
        let calls = 0;
        const adapter = { chat: async () => { calls++; if (calls < 3) throw Object.assign(new Error('overloaded'), { status: 503 }); return 'ok'; } };
        const res = await chatWithRetry(adapter, { apiKey: 'k', url: 'u' }, 'm', [], {}, { retries: 2, baseDelayMs: 1 });
        assert.strictEqual(res, 'ok', 'returns success after transient retries');
        assert.strictEqual(calls, 3, 'retried twice then succeeded (3 calls)');
    }
    {
        let calls = 0;
        const adapter = { chat: async () => { calls++; throw Object.assign(new Error('bad key'), { status: 401 }); } };
        await assert.rejects(() => chatWithRetry(adapter, { apiKey: 'k', url: 'u' }, 'm', [], {}, { retries: 2, baseDelayMs: 1 }), /bad key/, 'permanent error rethrows');
        assert.strictEqual(calls, 1, 'permanent error is not retried');
    }
    {
        let calls = 0;
        const adapter = { chat: async () => { calls++; throw Object.assign(new Error('boom'), { status: 500 }); } };
        await assert.rejects(() => chatWithRetry(adapter, { apiKey: 'k', url: 'u' }, 'm', [], {}, { retries: 2, baseDelayMs: 1 }), /boom/, 'exhausts then throws');
        assert.strictEqual(calls, 3, 'tried retries+1 (3) times');
    }

    // ── applyBuilderTierFloor ──
    {
        const tiers = { fast: { modelId: 'ministral-8b' }, standard: { modelId: 'claude-sonnet-4-6' }, thinking: { modelId: 'claude-opus-4-8' } };
        const r = applyBuilderTierFloor('fast', 'ministral-8b', tiers);
        assert.strictEqual(r.tier, 'standard', 'small model is floored to the first non-small tier');
        assert.strictEqual(r.modelId, 'claude-sonnet-4-6', 'floored model id is the standard tier model');
    }
    {
        const tiers = { fast: { modelId: 'ministral-8b' }, standard: { modelId: 'claude-sonnet-4-6' } };
        const r = applyBuilderTierFloor('standard', 'claude-sonnet-4-6', tiers);
        assert.strictEqual(r.modelId, 'claude-sonnet-4-6', 'non-small model is left unchanged');
        assert.strictEqual(r.tier, 'standard', 'non-small tier is left unchanged');
    }
    {
        // Small-only org: no non-small tier to floor to → unchanged.
        const tiers = { fast: { modelId: 'ministral-8b' }, standard: { modelId: 'gpt-5-mini' } };
        const r = applyBuilderTierFloor('fast', 'ministral-8b', tiers);
        assert.strictEqual(r.modelId, 'ministral-8b', 'small-only org keeps the small model');
        assert.strictEqual(r.tier, 'fast', 'small-only org keeps the resolved tier');
    }

    // ── validateLayerForSummary ──
    assert.strictEqual(validateLayerForSummary({ steps: [] }), null, 'empty-but-valid layer passes');
    assert.strictEqual(validateLayerForSummary({ title: 'x', steps: [{ id: 's1', type: 'code' }] }), null, 'layer with steps passes');
    assert.ok(validateLayerForSummary(null), 'null layer rejected');
    assert.ok(validateLayerForSummary('nope'), 'string layer rejected');
    assert.ok(validateLayerForSummary([]), 'array layer rejected');
    assert.ok(validateLayerForSummary({ title: 'x' }), 'layer without steps array rejected');
    assert.ok(validateLayerForSummary({ steps: {} }), 'non-array steps rejected');
    assert.ok(validateLayerForSummary({ steps: new Array(201).fill({ id: 'x', type: 'code' }) }), 'oversized layer rejected');

    // ── sanitiseLayerSummary ──
    assert.strictEqual(sanitiseLayerSummary('  Looks up the contact.  '), 'Looks up the contact.', 'trims surrounding whitespace');
    assert.strictEqual(sanitiseLayerSummary('"Sends a digest email."'), 'Sends a digest email.', 'strips surrounding straight quotes');
    assert.strictEqual(sanitiseLayerSummary('“Smart quotes here”'), 'Smart quotes here', 'strips surrounding smart quotes');
    assert.strictEqual(sanitiseLayerSummary('a\n\n  b   c'), 'a b c', 'collapses internal whitespace runs');
    assert.strictEqual(sanitiseLayerSummary(null), '', 'null → empty string');
    assert.strictEqual(sanitiseLayerSummary(undefined), '', 'undefined → empty string');
    assert.ok(sanitiseLayerSummary('x'.repeat(400)).length <= 280, 'caps very long output at 280 chars');

    // ── accumulateUsage (WS1) ──
    {
        const totals = { prompt: 0, completion: 0, cached: 0, cacheCreation: 0, rounds: 0 };
        accumulateUsage(totals, { prompt_tokens: 100, completion_tokens: 20, cached_tokens: 80, cache_creation_tokens: 10 });
        accumulateUsage(totals, { prompt_tokens: 50, completion_tokens: 5 }); // partial payload → missing fields count 0
        assert.deepStrictEqual(totals, { prompt: 150, completion: 25, cached: 80, cacheCreation: 10, rounds: 2 }, 'usage totals accumulate');
        accumulateUsage(totals, null);
        assert.strictEqual(totals.rounds, 2, 'null usage is a no-op');
        accumulateUsage(totals, { prompt_tokens: 'garbage' });
        assert.strictEqual(totals.prompt, 150, 'non-numeric fields never NaN the totals');
    }

    // ── renderValidationNote (WS2) ──
    {
        const err = { code: 'ref.invalid', path: 'steps.a', message: 'bad', hint: 'fix' };
        const warn = { code: 'condition.partial_branch', path: 'steps.c', message: 'one-sided' };
        const withErrors = renderValidationNote({ errors: [err], warnings: [warn] }, { tested: false });
        assert.ok(withErrors.startsWith(VALIDATION_NOTE_PREFIX), 'note carries the machine-generated marker');
        assert.ok(withErrors.includes('ref.invalid'), 'errors serialized in full');
        assert.ok(withErrors.includes('warnings(1): condition.partial_branch'), 'warnings compacted to one codes line');

        assert.strictEqual(renderValidationNote({ errors: [], warnings: [warn] }, { tested: false }), null,
            'warnings-only on a build round → NO note (half-built graphs legitimately warn)');
        const tested = renderValidationNote({ errors: [], warnings: [warn] }, { tested: true });
        assert.ok(tested && tested.includes('condition.partial_branch'), 'warnings surface on a dry-run/finalize round');
        assert.strictEqual(renderValidationNote({ errors: [], warnings: [] }, { tested: true }), null, 'clean → no note');
    }

    // ── sanitizeHistory strips loop-internal validation notes (WS2) ──
    {
        const h = sanitizeHistory([
            { role: 'user', content: 'build it' },
            { role: 'user', content: `${VALIDATION_NOTE_PREFIX}\n[]` },
            { role: 'assistant', content: 'done' },
        ]);
        assert.strictEqual(h.length, 2, 'validation note filtered out of cross-turn history');
        assert.ok(h.every(m => !m.content.startsWith(VALIDATION_NOTE_PREFIX)));
        // No tail cap here any more (was `.slice(-20)`): a sliding tail moved
        // the first kept message every turn and broke the prompt-prefix cache.
        // The head-anchored window at the compose site bounds the length now.
        const long = Array.from({ length: 25 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` }));
        assert.strictEqual(sanitizeHistory(long).length, 25, '25 in → 25 out');
    }

    // ── applyPlanMarkDone (WS6) ──
    {
        const todos = [{ text: 'a', done: false }, { text: 'b', done: false }, { text: 'c', done: true }];
        const out = applyPlanMarkDone(todos, [0, 5, -1, 'x', 1.5]);
        assert.deepStrictEqual(out.map(t => t.done), [true, false, true], 'flips in-range integer indices only');
        assert.strictEqual(todos[0].done, false, 'input array not mutated');
        assert.deepStrictEqual(applyPlanMarkDone(todos, undefined).map(t => t.done), [false, false, true], 'missing markDone → unchanged copy');
        assert.deepStrictEqual(applyPlanMarkDone(null, [0]), [], 'null todos → empty list');
    }

    console.log('automationBuilder.test.js: all helper tests passed');
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
