/**
 * Pure tests — the registry of unknown models (core/llm/unknownModelRegistry.js).
 *
 * Proven: counts and first/last seen per (provider, model), the data an admin route
 * needs, a bounded size, a warning that is rate limited per model and overall (and not
 * once per process any more), and that a hostile model name is neutralised in what is
 * stored and logged.
 *
 * Run: cd server && node --test core/llm/unknownModelRegistry.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const log = require('../../telemetry/log');
const reg = require('./unknownModelRegistry');

const warnings = [];
const realWarn = log.warn;
test.before(() => { log.warn = (...a) => { warnings.push(a.join(' ')); }; });
test.after(() => { log.warn = realWarn; });
test.beforeEach(() => { reg.resetUnknownModels(); warnings.length = 0; });

const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);

test('counts calls and remembers first and last seen, provider and the estimate used', () => {
    reg.recordUnknownModel({ model: 'gpt-9', provider: 'openai', estimate: { source: 'estimate:family:gpt-5', input: 1.25, output: 10, currency: 'USD' } }, T0);
    reg.recordUnknownModel({ model: 'gpt-9', provider: 'openai', estimate: { source: 'estimate:family:gpt-5', input: 1.25, output: 10, currency: 'USD' } }, T0 + 5000);
    reg.recordUnknownModel({ model: 'gpt-9', provider: 'azure' }, T0 + 6000);
    const list = reg.listUnknownModels();
    assert.strictEqual(list.length, 2, 'the same name at two providers is two entries');
    const openai = list.find((e) => e.provider === 'openai');
    assert.deepStrictEqual(openai, {
        model: 'gpt-9', provider: 'openai', reason: 'unknown_model', deployment: null, calls: 2,
        first_seen: new Date(T0).toISOString(), last_seen: new Date(T0 + 5000).toISOString(),
        estimate: { source: 'estimate:family:gpt-5', input: 1.25, output: 10, currency: 'USD' },
    });
    assert.strictEqual(list[0].provider, 'azure', 'most recently seen first');
    assert.strictEqual(list.find((e) => e.provider === 'azure').estimate, null, 'no estimate: rated at 0');
});

test('an unmapped Azure deployment keeps its reason, and a mapped one the deployment name', () => {
    reg.recordUnknownModel({ model: 'prod-chat', provider: 'azure', reason: 'unmapped_deployment' }, T0);
    reg.recordUnknownModel({ model: 'gpt-9', provider: 'azure', deployment: 'prod-2' }, T0);
    const list = reg.listUnknownModels();
    assert.strictEqual(list.find((e) => e.model === 'prod-chat').reason, 'unmapped_deployment');
    assert.strictEqual(list.find((e) => e.model === 'gpt-9').deployment, 'prod-2');
});

test('the returned list is a copy: mutating it does not touch the registry', () => {
    reg.recordUnknownModel({ model: 'm1', estimate: { source: 's' } }, T0);
    const a = reg.listUnknownModels();
    a[0].calls = 999;
    a[0].estimate.source = 'hacked';
    a.length = 0;
    const b = reg.listUnknownModels();
    assert.strictEqual(b[0].calls, 1);
    assert.strictEqual(b[0].estimate.source, 's');
});

test('the warning is rate limited per model: one per interval, not one per process', () => {
    reg.recordUnknownModel({ model: 'm1' }, T0);
    reg.recordUnknownModel({ model: 'm1' }, T0 + 1000);
    reg.recordUnknownModel({ model: 'm1' }, T0 + reg.WARN_PER_MODEL_MS - 1);
    assert.strictEqual(warnings.length, 1);
    reg.recordUnknownModel({ model: 'm1' }, T0 + reg.WARN_PER_MODEL_MS);
    assert.strictEqual(warnings.length, 2, 'it warns again after the interval');
    reg.recordUnknownModel({ model: 'm2' }, T0 + reg.WARN_PER_MODEL_MS + 1);
    assert.strictEqual(warnings.length, 3, 'a different model has its own budget');
});

test('a flood of distinct names cannot flood the log, and says how many were held back', () => {
    for (let i = 0; i < reg.WARN_PER_MINUTE + 30; i++) reg.recordUnknownModel({ model: `flood-${i}` }, T0 + i);
    assert.strictEqual(warnings.length, reg.WARN_PER_MINUTE);
    reg.recordUnknownModel({ model: 'later' }, T0 + 61_000);
    assert.strictEqual(warnings.length, reg.WARN_PER_MINUTE + 1);
    assert.match(warnings[warnings.length - 1], /30 further unknown-model warning\(s\) suppressed/);
});

test('the registry is bounded: new names beyond the cap are counted, not stored', () => {
    for (let i = 0; i < reg.MAX_ENTRIES + 25; i++) reg.recordUnknownModel({ model: `m-${i}` }, T0);
    assert.strictEqual(reg.listUnknownModels().length, reg.MAX_ENTRIES);
    assert.deepStrictEqual(reg.unknownModelStats(), { tracked: reg.MAX_ENTRIES, max: reg.MAX_ENTRIES, overflow: 25 });
    // a name already tracked still counts
    assert.strictEqual(reg.recordUnknownModel({ model: 'm-0' }, T0 + 1), true);
    assert.strictEqual(reg.listUnknownModels().find((e) => e.model === 'm-0').calls, 2);
    assert.strictEqual(reg.recordUnknownModel({ model: 'brand-new' }, T0 + 1), false);
});

test('a hostile model name is neutralised in what is stored and what is logged', () => {
    const evil = 'x\n[ModelCosts] FAKE LOG LINE\r\u2028\u0000"; DROP TABLE ai_usage_log;--' + 'y'.repeat(500);
    reg.recordUnknownModel({ model: evil, provider: 'Open AI!\n', estimate: { source: 'a\nb<script>', input: 'NaN', currency: 'xx' } }, T0);
    const [e] = reg.listUnknownModels();
    assert.ok(e.model.length <= 128);
    assert.ok(!/[\u0000-\u001f\u2028\u2029]/.test(e.model), 'no control or line-separator characters');
    assert.strictEqual(e.provider, null, 'a provider that is not an identifier is dropped');
    assert.strictEqual(e.estimate.input, null);
    assert.strictEqual(e.estimate.currency, null);
    assert.ok(!/[\n<]/.test(e.estimate.source));
    assert.strictEqual(warnings.length, 1);
    assert.ok(!/[\n\r\u2028]/.test(warnings[0]), 'one log line, no forged second line');
    // the model is quoted, so injected text stays inside the string
    assert.match(warnings[0], /Unknown model "/);
});

test('an empty or missing model is shown as a visible marker, never throws', () => {
    for (const m of [undefined, null, '', '   ', 42, {}]) assert.doesNotThrow(() => reg.recordUnknownModel({ model: m }, T0));
    assert.doesNotThrow(() => reg.recordUnknownModel(undefined, T0));
    assert.ok(reg.listUnknownModels().some((e) => e.model === '(none)'));
});

test('prototype-looking names are plain data', () => {
    for (const m of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) reg.recordUnknownModel({ model: m }, T0);
    assert.strictEqual(reg.listUnknownModels().length, 4);
    assert.strictEqual(({}).polluted, undefined);
});
