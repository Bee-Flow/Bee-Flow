/**
 * POST /suggest-mappings (suggestMappings.js): what one request may cost.
 *
 * Any author with the automations beta can call the route directly, with
 * samples up to the route's own limits. Two things must hold whatever they
 * send:
 *   - describing the samples stays linear: one long string (an attachment as
 *     base64, a token) once took seconds in the e-mail mask and blocked the
 *     event loop for every tenant;
 *   - the message the model gets stays bounded as a WHOLE, not only its
 *     field list: inputs, enum values and the "already mapped" block once
 *     added up to millions of characters per call.
 *
 * Run: cd server && node --test routes/ai/automationBuilder/suggestMappings.bounds.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const {
    normaliseSuggestRequest, buildSuggestPrompt, suggestMappings, SuggestMappingsBody, MODEL_PROMPT_CHARS,
} = require('./suggestMappings');

const input = (body) => normaliseSuggestRequest(SuggestMappingsBody.parse(body));
const userMessage = (body) => buildSuggestPrompt(input(body)).messages[1].content;
const TITLE = [{ key: 'title', type: 'string' }];

// ── Linear time ─────────────────────────────────────────────────────────────

test('one long string without spaces or "@" (base64, a token) is described in linear time', () => {
    // 120 000 chars: the unanchored e-mail mask took seconds on this (it
    // grows with the square of the length); the cut-first mask takes ~1 ms.
    const base64 = 'UmVwb3J0IFExIDIwMjYgLSBmaW5hbC5wZGY'.repeat(3430).slice(0, 120_000);
    const body = { params: TITLE, sources: [{ root: 'steps.s1.output', real: true, sample: { attachment: { contentBase64: base64 }, note: 'a'.repeat(60_000) } }] };
    const t0 = process.hrtime.bigint();
    const user = userMessage(body);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 500, `describing took ${ms.toFixed(0)} ms`);
    const line = user.split('\n').find((l) => l.includes('contentBase64'));
    assert.ok(line && line.length < 260, line);
});

test('an address that crosses the cut is still masked as a whole', () => {
    // The value is cut before the mask runs (that is what keeps it linear);
    // the cut keeps a whole address beyond the visible part, so one that
    // starts just before the visible end is never shown half.
    const local = `firstname.lastname.department.${'q'.repeat(30)}`;
    const domain = `${'d'.repeat(63)}.example.com`;
    const note = `${'x'.repeat(79)} ${local}@${domain} and more`;
    const user = userMessage({ params: TITLE, sources: [{ root: 'trigger.output', sample: { note } }] });
    const line = user.split('\n').find((l) => l.includes('trigger.output.note'));
    assert.match(line, /<email>/);
    assert.doesNotMatch(line, /firstname|lastname|qqqq|dddd/);
});

test('a long list of addresses never shows a piece of the address the cut fell into', () => {
    // Masking shortens the text (60 chars become "<email>"), which pulls text
    // from beyond the cut into view: the address the cut split must not come
    // along half (its name without the domain is still personal data).
    const people = Array.from({ length: 12 }, (_, i) => `person${i}.surname${i}.${'p'.repeat(30)}@company${i}.example.com`);
    const user = userMessage({ params: TITLE, sources: [{ root: 'trigger.output', sample: { to: people.join(', ') } }] });
    const line = user.split('\n').find((l) => l.includes('trigger.output.to'));
    assert.match(line, /<email>, <email>/);
    assert.doesNotMatch(line, /person|surname|pppp|company/);
});

// ── The whole message is bounded ────────────────────────────────────────────

/** The largest request the schema lets through, padded where it renders worst. */
function largestBody() {
    const ctl = '\u0001';
    const params = Array.from({ length: 40 }, (_, i) => ({
        key: `p${i}_${'"'.repeat(190)}`,
        type: 'string',
        title: ctl.repeat(300),
        description: ctl.repeat(2000),
        enum: Array.from({ length: 100 }, (_, j) => `${j}${ctl.repeat(296)}`),
        required: true,
    }));
    const mapped = Array.from({ length: 80 }, (_, i) => ({
        key: `m${i}${ctl.repeat(190)}`,
        kind: 'ref',
        paths: Array.from({ length: 10 }, () => `steps.s1.output.${ctl.repeat(980)}`),
    }));
    // One source whose single key is almost the whole sample, and wide ones
    // (a control character costs six in JSON, so these sit near the limits).
    const sources = [{ root: 'steps.k.output', label: ctl.repeat(200), sample: { ['k'.repeat(199_000)]: 1 } }];
    for (let s = 0; s < 11; s++) {
        const wide = {};
        for (let i = 0; i < 50; i++) wide[`f${i}${ctl.repeat(10)}`] = `v${ctl.repeat(40)}`;
        sources.push({ root: `steps.w${s}.output`, label: `Wide ${s}`, sample: { rows: [wide, wide] } });
    }
    return { step: { label: ctl.repeat(200), tool: 'x'.repeat(200) }, params, mapped, sources };
}

test('the message to the model is bounded as a whole, however the request is padded', () => {
    const body = largestBody();
    assert.ok(JSON.stringify(body).length > 1_000_000, 'the request itself is large');
    const user = userMessage(body);
    assert.ok(user.length <= MODEL_PROMPT_CHARS, `user message is ${user.length} chars`);
    assert.ok(MODEL_PROMPT_CHARS <= 64_000);
    // Still a usable prompt: inputs listed first, then data.
    assert.match(user, /^Inputs to fill:|^The step:/);
    assert.match(user, /Data from the steps above/);
});

test('a long choice list is shortened for the model, yet checked in full', async () => {
    const choices = Array.from({ length: 30 }, (_, i) => `choice-${i}`);
    const body = {
        params: [{ key: 'status', type: 'string', enum: choices }],
        sources: [{ root: 'trigger.output', sample: { state: 'choice-25' } }],
    };
    const user = userMessage(body);
    const line = user.split('\n').find((l) => l.startsWith('- "status"'));
    assert.match(line, /"choice-0"/);
    assert.doesNotMatch(line, /"choice-25"/, 'not every choice is spelled out');
    assert.match(line, /and 10 more/);
    // The model never returns a choice, only a field: the full list decides.
    const chat = async () => ({ structured: { bindings: [{ key: 'status', kind: 'ref', path: 'trigger.output.state', reason: 'State' }] } });
    const out = await suggestMappings(input(body), { chat });
    assert.deepStrictEqual(out.suggestions.map((s) => s.sampleValue), ['choice-25']);
});

test('a field whose path alone is huge is left out instead of overflowing the list', () => {
    const user = userMessage({ params: TITLE, sources: [{ root: 'trigger.output', sample: { ['k'.repeat(150_000)]: 'v', subject: 'Hello' } }] });
    assert.ok(user.length < 5000, `user message is ${user.length} chars`);
    assert.match(user, /trigger\.output\.subject {2}\(text\) = "Hello"/);
    assert.match(user, /\[field list shortened\]/);
});

test('inputs the message has no room for are not filled from the answer either', async () => {
    const body = largestBody();
    const prompt = buildSuggestPrompt(input(body));
    const shown = prompt.params.map((p) => p.key);
    assert.ok(shown.length >= 1 && shown.length < 40, `${shown.length} inputs shown`);
    const hiddenKey = body.params[39].key;
    assert.ok(!shown.includes(hiddenKey));
    const chat = async () => ({ structured: { bindings: [{ key: hiddenKey, kind: 'ref', path: 'steps.w0.output.rows[0]', reason: '' }] } });
    const out = await suggestMappings(input(body), { chat });
    assert.deepStrictEqual(out.suggestions, []);
    assert.match(out.rejected[0].reason, /not one of the inputs/);
});
