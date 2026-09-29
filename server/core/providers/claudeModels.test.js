'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
    CLAUDE_MODELS,
    describeClaudeModel,
    normalizeClaudeModelId,
    resolveEffort,
    supportsEffort,
    contextWindowFor,
    getClaudeListPrice,
    listPricedModels,
    cacheReadDiscount,
    cacheWriteMultiplier,
    listCatalogModels,
} = require('./claudeModels');

// ─────────────────────────────────────────────────────────────────────────────
// Defect 1 — claude-opus-5 was not matched by the adapter's adaptive-only
// regex, so it was sent `temperature: 1` and `budget_tokens`, both of which
// Opus 5 answers with a 400. These are the facts that made that possible.
// ─────────────────────────────────────────────────────────────────────────────
test('claude-opus-5 is adaptive-only and rejects sampling params', () => {
    const d = describeClaudeModel('claude-opus-5');
    assert.strictEqual(d.known, true, 'Opus 5 must be in the catalog');
    assert.strictEqual(d.adaptiveOnly, true);
    assert.strictEqual(d.temperature, false, 'Opus 5 400s on temperature');
    assert.strictEqual(d.thinking, 'adaptive');
    assert.strictEqual(d.reasoning, true);
});

test('claude-opus-5 supports the full effort ladder and 1M context', () => {
    assert.strictEqual(supportsEffort('claude-opus-5', 'xhigh'), true);
    assert.strictEqual(supportsEffort('claude-opus-5', 'max'), true);
    assert.strictEqual(contextWindowFor('claude-opus-5'), 1_000_000);
    assert.strictEqual(describeClaudeModel('claude-opus-5').maxOutput, 128_000);
});

test('claude-opus-5 thinks by default and caps disabled thinking at high', () => {
    const d = describeClaudeModel('claude-opus-5');
    assert.strictEqual(d.thinkingOnByDefault, true);
    assert.strictEqual(d.disableThinkingMaxEffort, 'high');
});

// ─────────────────────────────────────────────────────────────────────────────
// Defect 2 — three copies of the vision regex drifted apart. The adapter's copy
// was correct; attachmentProcessor's silently omitted Sonnet 5 and Fable 5.
// Every catalog model must agree with the adapter's (correct) regex.
// ─────────────────────────────────────────────────────────────────────────────
test('catalog vision matches the adapter regex it replaces, for every model', () => {
    const ADAPTER_VISION =
        /claude-3|claude-opus-[45]|claude-sonnet-[45]|claude-haiku-4|claude-fable|claude-mythos/;
    for (const id of Object.keys(CLAUDE_MODELS)) {
        assert.strictEqual(
            describeClaudeModel(id).vision,
            ADAPTER_VISION.test(id),
            `${id}: vision verdict diverged from the adapter regex`,
        );
    }
});

test('models the old attachmentProcessor regex missed do support vision', () => {
    // The exact ids the drifted copy returned false for.
    for (const id of ['claude-sonnet-5', 'claude-opus-5', 'claude-fable-5', 'claude-fable-5-1']) {
        assert.strictEqual(describeClaudeModel(id).vision, true, id);
        assert.strictEqual(describeClaudeModel(id).documents, true, id);
    }
});

test('no capability drifts from the adapter regexes the catalog replaced', () => {
    // The three checks that lived in claude.js before the catalog. A refactor
    // must not change any verdict — including for ids no longer sold, which
    // still sit in customer provider configs. The first version of this test
    // covered vision only, and missed that legacy 3.x models had silently
    // become "reasoning-capable" and would be sent a `thinking` param they
    // reject.
    const OLD_REASONING = (m) => (/^claude-haiku-4-5/.test(m)
        ? false
        : /^claude-(opus|sonnet)-[45]/.test(m) || /^claude-(fable|mythos)/.test(m));
    const OLD_CONTEXT_EDITING = (m) => /^claude-(opus|sonnet)-[45]/.test(m)
        || /^claude-haiku-4-5/.test(m)
        || /^claude-(fable|mythos)/.test(m);
    const OLD_VISION = (m) =>
        /claude-3|claude-opus-[45]|claude-sonnet-[45]|claude-haiku-4|claude-fable|claude-mythos/.test(m);

    const ids = [
        ...Object.keys(CLAUDE_MODELS),
        // Retired/legacy ids that can still appear in a stored provider config.
        'claude-3-5-sonnet-20241022',
        'claude-3-opus-20240229',
        'claude-3-7-sonnet-20250219',
        'claude-sonnet-4-5',
        'claude-opus-4-5',
    ];

    for (const id of ids) {
        const d = describeClaudeModel(id);
        assert.strictEqual(d.reasoning, OLD_REASONING(id), `${id}: reasoning drifted`);
        assert.strictEqual(d.contextEditing, OLD_CONTEXT_EDITING(id), `${id}: contextEditing drifted`);
        assert.strictEqual(d.vision, OLD_VISION(id), `${id}: vision drifted`);
    }
});

test('Claude 3.x takes no thinking param and still accepts temperature', () => {
    for (const id of ['claude-3-5-sonnet-20241022', 'claude-3-opus-20240229']) {
        const d = describeClaudeModel(id);
        assert.strictEqual(d.reasoning, false, `${id} must not be sent thinking`);
        assert.strictEqual(d.efforts, null, id);
        assert.strictEqual(d.temperature, true, `${id} still accepts sampling params`);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// The generation-aware fallback. Without it, a catalog just relocates defect 1
// to the next unreleased model id.
// ─────────────────────────────────────────────────────────────────────────────
test('an unreleased Claude id inherits its generation rules, not undefined', () => {
    const d = describeClaudeModel('claude-opus-6');
    assert.strictEqual(d.known, false, 'should be a guess, not a catalog hit');
    assert.strictEqual(d.adaptiveOnly, true);
    assert.strictEqual(d.temperature, false, 'must not send temperature to a gen-6 model');
    assert.ok(Array.isArray(d.efforts) && d.efforts.includes('xhigh'));
    assert.strictEqual(d.context, 1_000_000);
    assert.strictEqual(d.price, null, 'never invent a tariff for a guessed model');
});

test('a future Fable keeps forced tool choice disabled', () => {
    assert.strictEqual(describeClaudeModel('claude-fable-6').forcedToolChoice, false);
    assert.strictEqual(describeClaudeModel('claude-fable-6').thinking, 'always');
});

test('legacy number-first 3.x ids still parse and keep the old surface', () => {
    const d = describeClaudeModel('claude-3-5-sonnet-20241022');
    assert.strictEqual(d.family, 'sonnet');
    assert.strictEqual(d.temperature, true, '3.x still accepts temperature');
    assert.strictEqual(d.context, 200_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// Id normalisation across the shapes the same model reaches us in.
// ─────────────────────────────────────────────────────────────────────────────
test('normalizes Bedrock, Vertex, routing-prefix and dated-snapshot ids', () => {
    assert.strictEqual(normalizeClaudeModelId('anthropic.claude-opus-5'), 'claude-opus-5');
    assert.strictEqual(normalizeClaudeModelId('anthropic/claude-opus-5'), 'claude-opus-5');
    assert.strictEqual(normalizeClaudeModelId('claude-sonnet-5-20260115'), 'claude-sonnet-5');
    assert.strictEqual(normalizeClaudeModelId('claude-haiku-4-5-20251001'), 'claude-haiku-4-5');
    assert.strictEqual(normalizeClaudeModelId('claude-opus-4-5@20251101'), 'claude-opus-4-5');
    assert.strictEqual(normalizeClaudeModelId('  CLAUDE-OPUS-5  '), 'claude-opus-5');
});

test('the 8-digit snapshot strip never eats a version segment', () => {
    // claude-opus-4-8 ends in `-8`; a sloppier `-\d+$` strip would break it.
    assert.strictEqual(normalizeClaudeModelId('claude-opus-4-8'), 'claude-opus-4-8');
    assert.strictEqual(describeClaudeModel('claude-opus-4-8').known, true);
});

// ─────────────────────────────────────────────────────────────────────────────
// Effort vocabulary — preserves the adapter's EFFORT_MAP_XHIGH/LEGACY pair.
// ─────────────────────────────────────────────────────────────────────────────
test('xhigh maps to max on the ladders that lack it', () => {
    assert.strictEqual(resolveEffort('claude-opus-4-6', 'xhigh'), 'max');
    assert.strictEqual(resolveEffort('claude-sonnet-4-6', 'xhigh'), 'max');
    assert.strictEqual(resolveEffort('claude-opus-5', 'xhigh'), 'xhigh');
});

test('minimal is folded to low, unknown efforts fall to the model default', () => {
    assert.strictEqual(resolveEffort('claude-opus-5', 'minimal'), 'low');
    assert.strictEqual(resolveEffort('claude-opus-5', 'nonsense'), 'high');
    assert.strictEqual(resolveEffort('claude-sonnet-5', 'nonsense'), 'medium');
});

test('haiku 4.5 takes no effort at all', () => {
    assert.strictEqual(resolveEffort('claude-haiku-4-5', 'high'), null);
    assert.strictEqual(describeClaudeModel('claude-haiku-4-5').efforts, null);
    assert.strictEqual(describeClaudeModel('claude-haiku-4-5').reasoning, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// Pricing — the gap that let Claude models bill at upper-bound rates.
// ─────────────────────────────────────────────────────────────────────────────
test('listPricedModels emits the shape pricingService.FALLBACK_PRICING consumes', () => {
    const priced = listPricedModels();
    assert.ok(Object.keys(priced).length >= 10);
    for (const [id, p] of Object.entries(priced)) {
        assert.strictEqual(typeof p.input, 'number', `${id}.input`);
        assert.strictEqual(typeof p.output, 'number', `${id}.output`);
        assert.strictEqual(typeof p.cacheRead, 'number', `${id}.cacheRead`);
        assert.ok(p.input > 0 && p.output > 0, `${id} must have real rates`);
        assert.ok(p.cacheRead < p.input, `${id} cache read must be cheaper than input`);
    }
    assert.deepStrictEqual(priced['claude-opus-5'], { input: 5.0, output: 25.0, cacheRead: 0.5 });
    assert.deepStrictEqual(priced['claude-sonnet-5'], { input: 2.0, output: 10.0, cacheRead: 0.2 });
});

test('cache read discount is 0.1x across the family but not on Fable 5.1', () => {
    assert.strictEqual(cacheReadDiscount('claude-opus-5'), 0.1);
    assert.strictEqual(cacheReadDiscount('claude-sonnet-5'), 0.1);
    // Fable 5.1 reads at $0.25/MTok against a $10 input rate — a quarter of
    // Fable 5's, and the reason this is data rather than a constant.
    assert.strictEqual(cacheReadDiscount('claude-fable-5-1'), 0.025);
    assert.strictEqual(cacheReadDiscount('claude-fable-5'), 0.1);
});

test('cache write premium follows the requested TTL', () => {
    assert.strictEqual(cacheWriteMultiplier('1h'), 2.0);
    assert.strictEqual(cacheWriteMultiplier('5m'), 1.25);
    assert.strictEqual(cacheWriteMultiplier(null), 1.25, 'default TTL is 5m');
});

test('no price is returned for a model we only guessed at', () => {
    assert.strictEqual(getClaudeListPrice('claude-opus-6'), null);
    assert.strictEqual(listPricedModels()['claude-opus-6'], undefined);
});

// ─────────────────────────────────────────────────────────────────────────────
// Request-shaping facts that are a 400 when wrong.
// ─────────────────────────────────────────────────────────────────────────────
test('Fable 5.1 refuses forced tool choice; Fable 5 and Opus 5 accept it', () => {
    assert.strictEqual(describeClaudeModel('claude-fable-5-1').forcedToolChoice, false);
    assert.strictEqual(describeClaudeModel('claude-mythos-5-1').forcedToolChoice, false);
    assert.strictEqual(describeClaudeModel('claude-fable-5').forcedToolChoice, true);
    assert.strictEqual(describeClaudeModel('claude-opus-5').forcedToolChoice, true);
});

test('mid-conversation system messages: Opus 5 and Fable yes, Sonnet 5 no', () => {
    assert.strictEqual(describeClaudeModel('claude-opus-5').midConvSystem, true);
    assert.strictEqual(describeClaudeModel('claude-opus-4-8').midConvSystem, true);
    assert.strictEqual(describeClaudeModel('claude-fable-5-1').midConvSystem, true);
    assert.strictEqual(describeClaudeModel('claude-sonnet-5').midConvSystem, false);
});

test('cache minimum is not monotonic across generations', () => {
    assert.strictEqual(describeClaudeModel('claude-opus-5').cacheMinTokens, 512);
    assert.strictEqual(describeClaudeModel('claude-opus-4-8').cacheMinTokens, 1024);
    assert.strictEqual(describeClaudeModel('claude-opus-4-7').cacheMinTokens, 2048);
    assert.strictEqual(describeClaudeModel('claude-opus-4-6').cacheMinTokens, 4096);
    assert.strictEqual(describeClaudeModel('claude-haiku-4-5').cacheMinTokens, 4096);
});

test('the legacy budget_tokens family is exactly Opus 4.6 and Sonnet 4.6', () => {
    const budget = Object.keys(CLAUDE_MODELS)
        .filter((id) => CLAUDE_MODELS[id].thinking === 'budget')
        .sort();
    assert.deepStrictEqual(budget, ['claude-opus-4-6', 'claude-sonnet-4-6']);
    for (const id of budget) {
        assert.strictEqual(describeClaudeModel(id).temperature, true);
        assert.strictEqual(describeClaudeModel(id).adaptiveOnly, false);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// Catalog integrity.
// ─────────────────────────────────────────────────────────────────────────────
const FAMILY_RANKED = ['fable', 'mythos', 'opus', 'sonnet', 'haiku'];

test('every catalog entry is internally consistent', () => {
    for (const [id, e] of Object.entries(CLAUDE_MODELS)) {
        assert.ok(e.name, `${id} needs a display name`);
        assert.ok(e.context > 0, `${id} needs a context window`);
        assert.ok(e.maxOutput > 0, `${id} needs an output cap`);
        assert.ok(e.maxOutput < e.context, `${id}: output cap must fit the window`);
        assert.ok(e.price, `${id} needs list prices`);
        assert.ok(FAMILY_RANKED.includes(e.family), `${id}: unexpected family ${e.family}`);
        // A model with an effort ladder must name a default on it.
        if (e.efforts) assert.ok(e.efforts.includes(e.defaultEffort), `${id} default effort`);
        // Adaptive/always models never accept sampling params.
        if (e.thinking === 'adaptive' || e.thinking === 'always') {
            assert.strictEqual(e.temperature, false, `${id} must reject temperature`);
        }
    }
});

test('listCatalogModels exposes every model with display fields', () => {
    const list = listCatalogModels();
    assert.strictEqual(list.length, Object.keys(CLAUDE_MODELS).length);
    const opus5 = list.find((m) => m.id === 'claude-opus-5');
    assert.ok(opus5 && opus5.name === 'Claude Opus 5' && opus5.input === 5.0);
});
