/**
 * Unit tests — OpenAI/Azure model capability helpers.
 *
 * Plain assert-based suite (no jest/mocha in this repo).
 * Run: node core/providers/openaiModelCaps.test.js
 */

const assert = require('assert');
const {
    clampEffort,
    buildReasoningParams,
    defaultVerbosity,
    supportsVerbosity,
    supportsTemperature,
    supportsParallelToolCalls,
    isReasoningModel,
    requiresResponsesApi,
    cacheTtlParams,
    mapToolChoice,
    mapResponsesToolChoice,
    qualifiesForStrict,
    isProModel,
} = require('./openaiModelCaps');

let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };

// ─── clampEffort ──────────────────────────────────────────────────────────
console.log('clampEffort');
t('returns null when no effort requested', () => {
    assert.strictEqual(clampEffort('gpt-5', undefined), null);
    assert.strictEqual(clampEffort('gpt-5', ''), null);
});
t('passes minimal through on the GPT-5 family', () => {
    assert.strictEqual(clampEffort('gpt-5', 'minimal'), 'minimal');
    assert.strictEqual(clampEffort('gpt-5-mini', 'minimal'), 'minimal');
    assert.strictEqual(clampEffort('gpt-5.4-nano', 'minimal'), 'minimal');
});
t('floors minimal to low on o-series (no minimal tier)', () => {
    assert.strictEqual(clampEffort('o3', 'minimal'), 'low');
    assert.strictEqual(clampEffort('o4-mini', 'minimal'), 'low');
});
t('keeps xhigh only for codex-max, caps elsewhere', () => {
    assert.strictEqual(clampEffort('gpt-5.1-codex-max', 'xhigh'), 'xhigh');
    assert.strictEqual(clampEffort('gpt-5', 'xhigh'), 'high');
    assert.strictEqual(clampEffort('gpt-5.2', 'xhigh'), 'high');
});
t('locks pro models to high regardless of requested effort', () => {
    assert.strictEqual(clampEffort('gpt-5-pro', 'minimal'), 'high');
    assert.strictEqual(clampEffort('gpt-5.2-pro', 'low'), 'high');
    assert.strictEqual(clampEffort('gpt-5.4-pro', 'medium'), 'high');
});
t('passes valid efforts through unchanged', () => {
    assert.strictEqual(clampEffort('gpt-5', 'low'), 'low');
    assert.strictEqual(clampEffort('gpt-5', 'medium'), 'medium');
    assert.strictEqual(clampEffort('gpt-5', 'high'), 'high');
    assert.strictEqual(clampEffort('gpt-5', 'none'), 'none');
});

// ─── buildReasoningParams ───────────────────────────────────────────────────
console.log('buildReasoningParams');
t('omits summary entirely when not requested (never "concise")', () => {
    const r = buildReasoningParams('gpt-5', { reasoningEffort: 'medium', reasoningSummary: false });
    assert.strictEqual(r.effort, 'medium');
    assert.ok(!('summary' in r), 'summary should be absent');
});
t('uses auto summary when enabled', () => {
    const r = buildReasoningParams('gpt-5', { reasoningEffort: 'high', reasoningSummary: true });
    assert.strictEqual(r.summary, 'auto');
});
t('honours detailed summary', () => {
    const r = buildReasoningParams('gpt-5', { reasoningSummary: 'detailed' });
    assert.strictEqual(r.summary, 'detailed');
});
t('never emits the GPT-5-unsupported "concise" value', () => {
    for (const v of [false, true, 'detailed', undefined]) {
        const r = buildReasoningParams('gpt-5', { reasoningSummary: v });
        assert.notStrictEqual(r.summary, 'concise');
    }
});
t('defaults effort to medium when unset, clamps pro to high', () => {
    assert.strictEqual(buildReasoningParams('gpt-5', {}).effort, 'medium');
    assert.strictEqual(buildReasoningParams('gpt-5-pro', { reasoningEffort: 'low' }).effort, 'high');
});

// ─── verbosity ──────────────────────────────────────────────────────────────
console.log('verbosity');
t('supportsVerbosity only for GPT-5 family', () => {
    assert.strictEqual(supportsVerbosity('gpt-5'), true);
    assert.strictEqual(supportsVerbosity('gpt-5-nano'), true);
    assert.strictEqual(supportsVerbosity('o3'), false);
    assert.strictEqual(supportsVerbosity('gpt-4o'), false);
});
t('defaultVerbosity is tier-aware and undefined for non-GPT-5', () => {
    assert.strictEqual(defaultVerbosity('gpt-5', 'fast'), 'low');
    assert.strictEqual(defaultVerbosity('gpt-5', 'writer'), 'high');
    assert.strictEqual(defaultVerbosity('gpt-5', 'thinking'), 'medium');
    assert.strictEqual(defaultVerbosity('o3', 'fast'), undefined);
});

// ─── tool helpers ─────────────────────────────────────────────────────────
console.log('tool helpers');
t('supportsParallelToolCalls is false only for minimal effort', () => {
    assert.strictEqual(supportsParallelToolCalls('minimal'), false);
    assert.strictEqual(supportsParallelToolCalls('low'), true);
    assert.strictEqual(supportsParallelToolCalls('high'), true);
});
t('mapToolChoice maps any/required and passes auto/none', () => {
    assert.strictEqual(mapToolChoice('any'), 'required');
    assert.strictEqual(mapToolChoice('required'), 'required');
    assert.strictEqual(mapToolChoice('auto'), 'auto');
    assert.strictEqual(mapToolChoice('none'), 'none');
    assert.strictEqual(mapToolChoice(undefined), undefined);
    // A forced function is normalised into the Chat Completions spelling —
    // it used to pass straight through, which sent the wrong shape to whichever
    // API did not happen to match. See the "tool_choice per API" block below.
    assert.deepStrictEqual(mapToolChoice({ type: 'function', name: 'x' }),
        { type: 'function', function: { name: 'x' } });
});
t('isProModel matches gpt-5 pro variants only', () => {
    assert.ok(isProModel('gpt-5-pro'));
    assert.ok(isProModel('gpt-5.2-pro'));
    assert.ok(isProModel('gpt-5.4-pro'));
    assert.ok(!isProModel('gpt-5'));
    assert.ok(!isProModel('gpt-5-mini'));
});

// ─── gpt-5.6 / gpt-6 vocabularies ──────────────────────────────────────────
// The regression that motivated the catalog: these generations changed the
// effort vocabulary, and every wrong value is a 400 that fails the request.
console.log('gpt-5.6 / gpt-6 efforts');
t('accepts max on gpt-5.6 and gpt-6', () => {
    assert.strictEqual(clampEffort('gpt-5.6-terra', 'max'), 'max');
    assert.strictEqual(clampEffort('gpt-5.6-luna', 'max'), 'max');
    assert.strictEqual(clampEffort('gpt-6-astra', 'max'), 'max');
});
t('no longer caps xhigh to high on gpt-5.6+', () => {
    assert.strictEqual(clampEffort('gpt-5.6-sol', 'xhigh'), 'xhigh');
    assert.strictEqual(clampEffort('gpt-6-astra', 'xhigh'), 'xhigh');
});
t('rounds the retired minimal tier up to low on gpt-5.6+', () => {
    // `minimal` does not exist from 5.6 on; sending it is a 400. OpenAI's own
    // migration guidance is to start at `low`.
    assert.strictEqual(clampEffort('gpt-5.6-terra', 'minimal'), 'low');
    assert.strictEqual(clampEffort('gpt-6-astra', 'minimal'), 'low');
});
t('rounds none up to low on gpt-6, which has no off switch', () => {
    assert.strictEqual(clampEffort('gpt-6-astra', 'none'), 'low');
    // 5.6 kept `none`, so it must still pass through there.
    assert.strictEqual(clampEffort('gpt-5.6-terra', 'none'), 'none');
});
t('still caps max down to the ceiling on the older GPT-5 line', () => {
    assert.strictEqual(clampEffort('gpt-5', 'max'), 'high');
    assert.strictEqual(clampEffort('gpt-5.2', 'max'), 'high');
    assert.strictEqual(clampEffort('o3', 'max'), 'high');
});
t('an unknown future id follows its generation, not gpt-5', () => {
    assert.strictEqual(clampEffort('gpt-5.9-preview', 'max'), 'max');
    assert.strictEqual(clampEffort('gpt-7-nova', 'minimal'), 'low');
    assert.strictEqual(supportsTemperature('gpt-7-nova'), false);
});

// ─── temperature / reasoning detection ─────────────────────────────────────
console.log('temperature + reasoning detection');
t('gpt-5.6 and gpt-6 reject temperature; gpt-4o accepts it', () => {
    assert.strictEqual(supportsTemperature('gpt-6-astra'), false);
    assert.strictEqual(supportsTemperature('gpt-5.6-luna'), false);
    assert.strictEqual(supportsTemperature('gpt-4o'), true);
    assert.strictEqual(supportsTemperature('gpt-4.1-nano'), false);
});
t('isReasoningModel covers gpt-6, which the old /^gpt-5/ regex missed', () => {
    assert.strictEqual(isReasoningModel('gpt-6-astra'), true);
    assert.strictEqual(isReasoningModel('gpt-5.6-sol'), true);
    assert.strictEqual(isReasoningModel('o3'), true);
    assert.strictEqual(isReasoningModel('gpt-4o'), false);
});
t('buildReasoningParams returns null for a non-reasoning model', () => {
    // Reachable now that the Responses API is the default for everything.
    assert.strictEqual(buildReasoningParams('gpt-4o', { reasoningEffort: 'low' }), null);
    assert.strictEqual(buildReasoningParams('gpt-6-astra', {}).effort, 'medium');
});
t('verbosity is gone from gpt-5.6 and gpt-6', () => {
    assert.strictEqual(supportsVerbosity('gpt-5.6-terra'), false);
    assert.strictEqual(supportsVerbosity('gpt-6-astra'), false);
    assert.strictEqual(supportsVerbosity('gpt-5.5'), true);
});

// ─── Responses-only tool calling ───────────────────────────────────────────
console.log('responses-only tool calling');
t('gpt-6 needs Responses for tools, but not for plain text', () => {
    const tools = [{ type: 'function', function: { name: 'x' } }];
    assert.strictEqual(requiresResponsesApi('gpt-6-astra', { tools }), true);
    assert.strictEqual(requiresResponsesApi('gpt-6-astra', {}), false);
    assert.strictEqual(requiresResponsesApi('gpt-5.6-sol', { tools }), false);
});

// ─── prompt cache TTL ──────────────────────────────────────────────────────
console.log('prompt cache ttl');
t('gpt-5.6+ take prompt_cache_options, older models take retention', () => {
    assert.deepStrictEqual(cacheTtlParams('gpt-6-astra'), { prompt_cache_options: { ttl: '30m' } });
    assert.deepStrictEqual(cacheTtlParams('gpt-5.6-luna'), { prompt_cache_options: { ttl: '30m' } });
    // Older models get nothing — their retention already defaults to 24h.
    assert.deepStrictEqual(cacheTtlParams('gpt-5.2'), {});
    assert.deepStrictEqual(cacheTtlParams('gpt-4o'), {});
    assert.deepStrictEqual(cacheTtlParams('o3', { promptCacheRetention: 'in_memory' }),
        { prompt_cache_retention: 'in_memory' });
});

// ─── strict tool schemas ───────────────────────────────────────────────────
console.log('strict tool schemas');
t('accepts a schema that meets both structured-output rules', () => {
    assert.ok(qualifiesForStrict({
        type: 'object',
        properties: { a: { type: 'string' }, b: { type: 'number' } },
        required: ['a', 'b'],
        additionalProperties: false,
    }));
});
t('declines a schema with an optional field or open properties', () => {
    assert.ok(!qualifiesForStrict({
        type: 'object',
        properties: { a: { type: 'string' }, b: { type: 'number' } },
        required: ['a'],
        additionalProperties: false,
    }), 'b is optional');
    assert.ok(!qualifiesForStrict({
        type: 'object',
        properties: { a: { type: 'string' } },
        required: ['a'],
    }), 'additionalProperties not closed');
});
t('declines a nested object that breaks the rules', () => {
    assert.ok(!qualifiesForStrict({
        type: 'object',
        properties: {
            inner: { type: 'object', properties: { x: { type: 'string' } }, required: [] },
        },
        required: ['inner'],
        additionalProperties: false,
    }));
});
t('declines $ref, which we cannot prove conforms', () => {
    assert.ok(!qualifiesForStrict({
        type: 'object',
        properties: { a: { $ref: '#/$defs/thing' } },
        required: ['a'],
        additionalProperties: false,
    }));
});

// ─── tool_choice differs per API ───────────────────────────────────────────
// Chat Completions wraps the forced function, Responses does not. Sending the
// wrong one is `400 Missing required parameter: 'tool_choice.name'`.
console.log('tool_choice per API');
t('Responses spells a forced function flat', () => {
    assert.deepStrictEqual(mapResponsesToolChoice({ type: 'function', function: { name: 'emit' } }),
        { type: 'function', name: 'emit' });
    assert.deepStrictEqual(mapResponsesToolChoice({ type: 'function', name: 'emit' }),
        { type: 'function', name: 'emit' });
    assert.deepStrictEqual(mapResponsesToolChoice({ name: 'emit' }),
        { type: 'function', name: 'emit' });
});
t('Chat Completions keeps the wrapper, and adds it when missing', () => {
    assert.deepStrictEqual(mapToolChoice({ type: 'function', function: { name: 'emit' } }),
        { type: 'function', function: { name: 'emit' } });
    assert.deepStrictEqual(mapToolChoice({ type: 'function', name: 'emit' }),
        { type: 'function', function: { name: 'emit' } });
});
t('both map the strings identically', () => {
    for (const map of [mapToolChoice, mapResponsesToolChoice]) {
        assert.strictEqual(map('any'), 'required');
        assert.strictEqual(map('required'), 'required');
        assert.strictEqual(map('auto'), 'auto');
        assert.strictEqual(map('none'), 'none');
        assert.strictEqual(map(undefined), undefined);
    }
});
t('non-function choices pass through untouched on both', () => {
    const allowed = { type: 'allowed_tools', mode: 'auto', tools: [{ type: 'function', name: 'emit' }] };
    assert.strictEqual(mapResponsesToolChoice(allowed), allowed);
    assert.strictEqual(mapToolChoice(allowed), allowed);
});

console.log(`\n${passed} assertions passed.`);
