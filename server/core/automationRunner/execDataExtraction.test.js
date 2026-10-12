/**
 * execDataExtraction — the output contract of the `data_extraction` step.
 *
 *   - the prompt is assembled by the server (the contract's system sentence,
 *     the field list, the optional instructions, the document under a marked
 *     delimiter, the middle cut out of an over-long document — and it says so);
 *   - numbers are coerced from the European forms too, decided by which
 *     separator comes LAST; a value that will not coerce is null, never a string;
 *   - the output is exactly the declared names, a missing field is null, an
 *     extra key is dropped;
 *   - a reply that will not parse FAILS the step, quoting what was asked and
 *     the first 200 characters of what came back;
 *   - a dry run never calls the model and returns typed samples;
 *   - the request options are the fixed ones — never a tier's — and the model
 *     is the admin's extraction model.
 *
 * Run: node --test --test-force-exit core/automationRunner/execDataExtraction.test.js
 */

'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');

const { installResolveStub } = require('../../testUtils/stubRequire');

// ── The doubles ────────────────────────────────────────────────────────────

const chatCalls = [];
let chatReply = '{"datum":"2026-03-12","totaal":"€ 1.554,25"}';
let configuredModel = 'model-extract';
const guardCalls = [];
const usageRows = [];

const restore = installResolveStub({
    '../../stores/configStore': {
        async getConfig(key) { return key === 'data_extraction_model' ? configuredModel : null; },
    },
    '../llm/modelResolver': {
        async getUserTierMap() { return { fast: { modelId: 'model-fast', maxTokens: 2048, temperature: 0.7, reasoningEffort: 'medium' } }; },
    },
    '../aiAgent': {
        async getProviderForModel(modelId) { return { apiKey: 'k', url: 'u', providerType: 'test', modelId }; },
        async getAIConfig() { return { model: 'model-global' }; },
    },
    '../providers': {
        getAdapter: () => ({
            async chat(_key, _url, modelId, messages, options) {
                chatCalls.push({ modelId, messages: JSON.parse(JSON.stringify(messages)), options });
                return { content: typeof chatReply === 'function' ? chatReply() : chatReply, usage: { promptTokens: 10, completionTokens: 5 } };
            },
        }),
    },
    './safety': {
        async resolveAutomationPolicy() { return { action: 'off' }; },
        buildAuditBase() { return {}; },
        async guardAiInput(messages) { guardCalls.push({ kind: 'ai_input', messages: JSON.parse(JSON.stringify(messages)) }); return { blocked: false }; },
        async guardAiOutput(content) { guardCalls.push({ kind: 'ai_output', content }); return { content }; },
        restoreForRunState: (v) => v,
        buildPiiSummary() { return null; },
    },
    '../../stores/usageStore': { async logUsage(row) { usageRows.push(row); } },
});
after(() => restore());

const {
    SYSTEM_PROMPT, DOC_START, DOC_END,
    buildExtractionPrompt, truncateMiddle,
    coerceNumber, coerceDate, coerceBoolean, coerceValue,
    parseExtractionReply, shapeExtractionOutput, synthesiseDryRunExtraction,
    execDataExtraction,
} = require('./execDataExtraction');

const CTX = { userId: 'u1', orgId: 'org1', automationId: 'a1', runId: 'r1', automationTitle: 'Invoices' };
const FIELDS = [
    { name: 'datum', type: 'date', description: 'Invoice date', required: true },
    { name: 'totaal', type: 'number', description: 'Total including VAT' },
    { name: 'betaald', type: 'boolean', description: 'Already paid' },
    { name: 'leverancier', type: 'string', description: 'Supplier name' },
];
const step = (over = {}) => ({
    id: 'ex1', type: 'data_extraction',
    source: { kind: 'ref', path: 'steps.read.output.content' },
    fields: FIELDS,
    ...over,
});
const state = (content = 'Factuur 2026-0042\nFactuurdatum: 12-03-2026\nTotaal incl. btw: € 1.554,25\nBetaald: nee\nAcme B.V.') => ({
    trigger: { output: {} }, steps: { read: { output: { content }, status: 'success' } }, vars: {}, secrets: { key: 'S' }, loop: {},
});
function reset() { chatCalls.length = 0; guardCalls.length = 0; usageRows.length = 0; chatReply = '{"datum":"2026-03-12","totaal":"€ 1.554,25"}'; configuredModel = 'model-extract'; }

// ── Prompt assembly ────────────────────────────────────────────────────────

test('the prompt carries the contract sentence, the field list, the instructions and the delimited document', () => {
    const { messages, truncated } = buildExtractionPrompt({ fields: FIELDS, instructions: 'Amounts are in euros.', sourceText: 'Hello invoice' });
    assert.strictEqual(messages.length, 2);
    assert.strictEqual(messages[0].role, 'system');
    assert.strictEqual(messages[1].role, 'user');
    const sys = messages[0].content;
    assert.ok(sys.startsWith(SYSTEM_PROMPT));
    assert.match(sys, /Answer with ONE JSON object and nothing else/);
    assert.match(sys, /A field you cannot find is null\. Never invent a value\./);
    assert.match(sys, /- datum \(date\) — Invoice date \[required\]/, 'name (type) — description, required flagged');
    assert.match(sys, /- totaal \(number\) — Total including VAT\n/, 'an optional field carries no flag');
    assert.match(sys, /Extra instructions:\nAmounts are in euros\./);
    const user = messages[1].content;
    assert.ok(user.includes(`${DOC_START}\nHello invoice\n${DOC_END}`), 'the document sits under a marked delimiter');
    assert.match(user, /exactly these keys: datum, totaal, betaald, leverancier/);
    assert.strictEqual(truncated, false);
});

test('no instructions → no instructions block; a field without a description has no dash', () => {
    const { messages } = buildExtractionPrompt({ fields: [{ name: 'x', type: 'string', description: '', required: false }], instructions: '   ', sourceText: 't' });
    assert.ok(!/Extra instructions/.test(messages[0].content));
    assert.match(messages[0].content, /- x \(string\)\n/);
});

test('an over-long document loses its MIDDLE, keeps head and tail, and says so', () => {
    const head = 'HEAD-'.repeat(2000);          // 10 000 chars
    const middle = 'MIDDLE-'.repeat(10000);     // 70 000 chars
    const tail = 'TAIL-'.repeat(2000);          // 10 000 chars
    const src = head + middle + tail;
    const r = truncateMiddle(src);
    assert.strictEqual(r.truncated, true);
    assert.ok(r.text.length <= 60000, `capped: ${r.text.length}`);
    assert.ok(r.text.startsWith('HEAD-HEAD-'), 'head kept');
    assert.ok(r.text.endsWith('TAIL-TAIL-'), 'tail kept');
    assert.match(r.text, /\[… \d+ characters omitted from the middle of the document/);
    assert.strictEqual(r.omitted, src.length - (r.text.length - (r.text.match(/\n\n\[…[^\]]*\]\n\n/)[0].length)));
    // Under the cap: untouched.
    const small = truncateMiddle('short');
    assert.deepStrictEqual(small, { text: 'short', truncated: false, omitted: 0 });
    // And through the prompt builder the flag rides along.
    const { truncated, messages } = buildExtractionPrompt({ fields: FIELDS, sourceText: src });
    assert.strictEqual(truncated, true);
    assert.match(messages[1].content, /characters omitted from the middle/);
});

// ── Number coercion ────────────────────────────────────────────────────────

test('numbers: the LAST separator is the decimal separator, currency and spaces are stripped', () => {
    assert.strictEqual(coerceNumber('€ 1.554,25'), 1554.25);
    assert.strictEqual(coerceNumber('1.554,25'), 1554.25);
    assert.strictEqual(coerceNumber('1,554.25'), 1554.25);
    assert.strictEqual(coerceNumber('875'), 875);
    assert.strictEqual(coerceNumber('EUR 1 234,50'), 1234.5);
    assert.strictEqual(coerceNumber('$1,234,567.89'), 1234567.89);
    assert.strictEqual(coerceNumber('1.234.567,89'), 1234567.89);
    assert.strictEqual(coerceNumber('12,50'), 12.5);
    assert.strictEqual(coerceNumber('12.50'), 12.5);
    assert.strictEqual(coerceNumber('0.125'), 0.125);
    assert.strictEqual(coerceNumber('0,5'), 0.5);
    // A lone separator followed by exactly three digits is thousands grouping.
    assert.strictEqual(coerceNumber('1.554'), 1554);
    assert.strictEqual(coerceNumber('1,554'), 1554);
    assert.strictEqual(coerceNumber('1.234.567'), 1234567);
    // Negatives in the three shapes accountants write them.
    assert.strictEqual(coerceNumber('-1.554,25'), -1554.25);
    assert.strictEqual(coerceNumber('1.554,25-'), -1554.25);
    assert.strictEqual(coerceNumber('(1.554,25)'), -1554.25);
    assert.strictEqual(coerceNumber('€ -12,00'), -12);
    // "€ 1.554,-" is Dutch for a whole amount, not a negative one.
    assert.strictEqual(coerceNumber('€ 1.554,-'), 1554);
    assert.strictEqual(coerceNumber('5,-'), 5);
    assert.strictEqual(coerceNumber('10.000'), 10000);
    assert.strictEqual(coerceNumber('100.000,00'), 100000);
    // Real numbers pass through.
    assert.strictEqual(coerceNumber(1554.25), 1554.25);
    assert.strictEqual(coerceNumber(0), 0);
});

test('numbers: what will not coerce is null — never a string', () => {
    for (const v of ['n/a', '', '   ', 'unknown', '-', 'abc', true, false, {}, [], NaN, Infinity, '1.2.3,4', '12.34.5']) {
        assert.strictEqual(coerceNumber(v), null, JSON.stringify(v));
        assert.strictEqual(coerceValue('number', v), null, JSON.stringify(v));
    }
    assert.strictEqual(coerceValue('number', null), null);
    assert.strictEqual(coerceValue('number', undefined), null);
});

// ── Dates and booleans ─────────────────────────────────────────────────────

test('dates come out as YYYY-MM-DD from ISO, European and written forms; nonsense is null', () => {
    assert.strictEqual(coerceDate('2026-03-12'), '2026-03-12');
    assert.strictEqual(coerceDate('2026-3-2'), '2026-03-02');
    assert.strictEqual(coerceDate('2026-03-12T10:20:30Z'), '2026-03-12');
    assert.strictEqual(coerceDate('12-03-2026'), '2026-03-12', 'day first');
    assert.strictEqual(coerceDate('12/03/2026'), '2026-03-12');
    assert.strictEqual(coerceDate('12.03.2026'), '2026-03-12');
    assert.strictEqual(coerceDate('03/25/2026'), '2026-03-25', 'flips when the second number cannot be a month');
    assert.strictEqual(coerceDate('20260312'), '2026-03-12');
    assert.strictEqual(coerceDate('12 March 2026'), '2026-03-12');
    for (const v of ['2026-13-01', '31-02-2026', 'yesterday', '', 'n/a', 42, null]) {
        assert.strictEqual(coerceDate(v), null, JSON.stringify(v));
    }
});

test('booleans read yes/no in two languages and 0/1; anything else is null', () => {
    for (const v of [true, 'true', 'yes', 'ja', 'Y', '1', 1]) assert.strictEqual(coerceBoolean(v), true, JSON.stringify(v));
    for (const v of [false, 'false', 'no', 'nee', 'N', '0', 0]) assert.strictEqual(coerceBoolean(v), false, JSON.stringify(v));
    for (const v of ['maybe', '', 2, {}, null]) assert.strictEqual(coerceBoolean(v), null, JSON.stringify(v));
});

// ── Shaping ────────────────────────────────────────────────────────────────

test('output is exactly the declared names: missing → null, extra keys dropped, case-insensitive key match', () => {
    const out = shapeExtractionOutput(FIELDS, { Datum: '12-03-2026', totaal: '€ 1.554,25', _raw: 'x', extra: 1 });
    assert.deepStrictEqual(out, { datum: '2026-03-12', totaal: 1554.25, betaald: null, leverancier: null });
    assert.deepStrictEqual(Object.keys(out), ['datum', 'totaal', 'betaald', 'leverancier'], 'declared order');
    // A string field that came back empty is "not found".
    assert.strictEqual(shapeExtractionOutput([{ name: 's', type: 'string' }], { s: '  ' }).s, null);
    assert.strictEqual(shapeExtractionOutput([{ name: 's', type: 'string' }], { s: 42 }).s, '42');
});

// ── Reply parsing ──────────────────────────────────────────────────────────

test('a fenced or prose-wrapped object still parses', () => {
    const p = { stepId: 'ex1', fieldNames: ['a'] };
    assert.deepStrictEqual(parseExtractionReply('```json\n{"a": 1}\n```', p), { a: 1 });
    assert.deepStrictEqual(parseExtractionReply('Here you go: {"a": 1}. Done.', p), { a: 1 });
    assert.deepStrictEqual(parseExtractionReply('{"a": "line\none"}', p), { a: 'line\none' }, 'raw newline inside a string is repaired');
});

test('a reply that is not the object FAILS, saying what was asked and quoting the first 200 characters', () => {
    const p = { stepId: 'ex1', fieldNames: ['datum', 'totaal'] };
    const prose = 'I am sorry, I could not find an invoice in this text. '.repeat(10);
    assert.throws(() => parseExtractionReply(prose, p), (err) => {
        assert.match(err.message, /asked for a JSON object with the fields "datum", "totaal"/);
        assert.match(err.message, /answered with something else/);
        assert.match(err.message, /steps\.ex1\.output/);
        assert.match(err.message, /First 200 characters: /);
        const quoted = err.message.split('First 200 characters: ')[1];
        assert.strictEqual(quoted, prose.trim().slice(0, 200));
        assert.strictEqual(err.errorClass, 'ValidationError');
        return true;
    });
    // Empty, an array, a bare number: all "something else".
    for (const bad of ['', '   ', '[1,2]', '42', 'null']) {
        assert.throws(() => parseExtractionReply(bad, p), /answered with something else/, JSON.stringify(bad));
    }
    // A reply cut off mid-object reads as truncation.
    assert.throws(() => parseExtractionReply('{"datum": "2026-03-12", "totaal": 15', p), (err) => {
        assert.match(err.message, /cut off before the JSON was complete/);
        assert.match(err.message, /First 200 characters: \{"datum"/);
        return true;
    });
});

// ── Dry run ────────────────────────────────────────────────────────────────

test('dry run: typed samples for the declared fields, tagged, and NO model call', async () => {
    reset();
    const r = await execDataExtraction(step(), CTX, state(), 'dry_run');
    assert.strictEqual(r.dryRunSynthesised, true);
    assert.deepStrictEqual(Object.keys(r.output), ['datum', 'totaal', 'betaald', 'leverancier']);
    assert.match(r.output.datum, /^\d{4}-\d{2}-\d{2}$/);
    assert.strictEqual(typeof r.output.totaal, 'number');
    assert.strictEqual(typeof r.output.betaald, 'boolean');
    assert.strictEqual(typeof r.output.leverancier, 'string');
    assert.strictEqual(chatCalls.length, 0, 'the model is never called in a dry run');
    assert.strictEqual(guardCalls.length, 0);
    assert.deepStrictEqual(synthesiseDryRunExtraction([{ name: 'n', type: 'number' }]), { n: 123.45 });
});

// ── Live ───────────────────────────────────────────────────────────────────

test('live: the admin model, the fixed options, thinking off, the shaped output', async () => {
    reset();
    chatReply = '{"datum":"12-03-2026","totaal":"€ 1.554,25","betaald":"nee","leverancier":"Acme B.V.","_raw":"…"}';
    const r = await execDataExtraction(step(), CTX, state(), 'live');
    assert.deepStrictEqual(r.output, { datum: '2026-03-12', totaal: 1554.25, betaald: false, leverancier: 'Acme B.V.' });
    assert.strictEqual(r._model, 'model-extract');
    assert.strictEqual(r._modelSource, 'config');
    assert.strictEqual(chatCalls.length, 1);
    const call = chatCalls[0];
    assert.strictEqual(call.modelId, 'model-extract', 'the configured extraction model, not the fast tier');
    assert.deepStrictEqual(call.options, { temperature: 0, reasoningEffort: 'none', maxTokens: 512 + 96 * 4, timeoutMs: 120000 }, 'fixed options — nothing from the tier (which says 0.7 / medium / 2048)');
    assert.ok(!('tools' in call.options), 'no tools');
    // The source text reached the model under the delimiter.
    const user = call.messages[1].content;
    assert.match(user, /Factuurdatum: 12-03-2026/);
    // Guarded on the way out and on the way back.
    assert.ok(guardCalls.some(c => c.kind === 'ai_input' && JSON.stringify(c.messages).includes('Factuurdatum')));
    assert.ok(guardCalls.some(c => c.kind === 'ai_output'));
    // Usage logged as automation spend against the extraction model.
    assert.strictEqual(usageRows.length, 1);
    assert.strictEqual(usageRows[0].model, 'model-extract');
    assert.strictEqual(usageRows[0].source, 'automation');
});

test('live: unset config falls back to the fast tier MODEL only — its options are still not used', async () => {
    reset();
    configuredModel = null;
    const r = await execDataExtraction(step(), CTX, state(), 'live');
    assert.strictEqual(chatCalls[0].modelId, 'model-fast');
    assert.strictEqual(r._modelSource, 'fast_tier');
    assert.strictEqual(chatCalls[0].options.temperature, 0);
    assert.strictEqual(chatCalls[0].options.reasoningEffort, 'none');
    assert.strictEqual(chatCalls[0].options.maxTokens, 512 + 96 * 4);
});

test('live: a field the model did not return is null; an unparseable reply fails the step', async () => {
    reset();
    chatReply = '{"datum":"2026-03-12"}';
    const r = await execDataExtraction(step(), CTX, state(), 'live');
    assert.deepStrictEqual(r.output, { datum: '2026-03-12', totaal: null, betaald: null, leverancier: null });

    reset();
    chatReply = 'Sorry, I cannot help with that.';
    await assert.rejects(() => execDataExtraction(step(), CTX, state(), 'live'), (err) => {
        assert.match(err.message, /answered with something else/);
        assert.match(err.message, /First 200 characters: Sorry, I cannot help with that\./);
        assert.strictEqual(err.errorClass, 'ValidationError');
        return true;
    });
});

test('live: a REQUIRED field that came back null fails the step, an optional one does not', async () => {
    reset();
    chatReply = '{"datum": null, "totaal": 12}';
    await assert.rejects(() => execDataExtraction(step(), CTX, state(), 'live'), /required field "datum"/);
    reset();
    chatReply = '{"datum": "2026-01-01", "totaal": null}';
    const r = await execDataExtraction(step(), CTX, state(), 'live');
    assert.strictEqual(r.output.totaal, null);
});

test('live: an empty source fails loudly rather than extracting from nothing', async () => {
    reset();
    await assert.rejects(() => execDataExtraction(step(), CTX, state(''), 'live'), (err) => {
        assert.match(err.message, /there is no text to read/);
        assert.match(err.message, /steps\.read\.output\.content/);
        return true;
    });
    assert.strictEqual(chatCalls.length, 0);
    // A missing upstream value likewise.
    const st = state();
    delete st.steps.read;
    await assert.rejects(() => execDataExtraction(step(), CTX, st, 'live'), /there is no text to read/);
});

test('live: a non-string source is serialised for the model; a template binding is interpolated', async () => {
    reset();
    const st = state();
    st.steps.read.output.content = { subject: 'Factuur', body: 'Totaal € 10,00' };
    await execDataExtraction(step(), CTX, st, 'live');
    assert.match(chatCalls[0].messages[1].content, /"subject": "Factuur"/);

    reset();
    await execDataExtraction(step({ source: { kind: 'template', value: 'Onderwerp: {{steps.read.output.content}}' } }), CTX, state('Hallo'), 'live');
    assert.match(chatCalls[0].messages[1].content, /Onderwerp: Hallo/);

    // A secret can never be smuggled into the document: the secrets root is
    // blanked before the binding resolves, the same rule every template gets.
    reset();
    const st2 = state('Hallo');
    st2.secrets = { key: 'SECRET-VALUE-XYZ' };
    await execDataExtraction(step({ source: { kind: 'template', value: '{{steps.read.output.content}} {{secrets.key}}' } }), CTX, st2, 'live');
    assert.ok(!/SECRET-VALUE-XYZ/.test(JSON.stringify(chatCalls[0].messages)), 'secrets never reach the model');
    reset();
    await assert.rejects(() => execDataExtraction(step({ source: { kind: 'ref', path: 'secrets.key' } }), CTX, st2, 'live'), /there is no text to read/);
    assert.strictEqual(chatCalls.length, 0);
});

test('live: inside a fan-out the source resolves through loop.<itemVar>', async () => {
    reset();
    const st = state();
    st.loop = { f: { item: { path: '/a.txt' }, output: { content: 'Factuur van Acme' } } };
    await execDataExtraction(step({ source: { kind: 'ref', path: 'loop.f.output.content' } }), CTX, st, 'live');
    assert.match(chatCalls[0].messages[1].content, /Factuur van Acme/);
});

test('no declared fields fails before anything is resolved or called', async () => {
    reset();
    await assert.rejects(() => execDataExtraction(step({ fields: [] }), CTX, state(), 'live'), /no fields to extract/);
    await assert.rejects(() => execDataExtraction(step({ fields: [{ name: 'Bad Name', type: 'string' }] }), CTX, state(), 'dry_run'), /no fields to extract/);
    assert.strictEqual(chatCalls.length, 0);
});
