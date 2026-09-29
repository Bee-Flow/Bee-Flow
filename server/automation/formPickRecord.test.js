/**
 * formPickRecord — searching and reading the records an `app_pick` question
 * offers.
 *
 * Two things are being pinned here, and they are the two the feature's safety
 * rests on:
 *
 *   1. It runs as the FILLER. A source whose tools this person cannot run is
 *      refused before anything is dispatched — the author's access never
 *      substitutes for theirs, and no caller id at all means no read.
 *   2. It never costs a submission. Every failure below still yields a
 *      descriptor; nothing throws out of describePick.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

process.env.NODE_ENV = 'test';

// ── Stubs for the two modules this one dispatches through ─────────────────
let grantedTools = new Set();
let toolsThrow = null;
const calls = [];
let toolAnswer = () => ({});

function stub(absPath, exports) {
    const p = require.resolve(absPath);
    const m = new Module(p);
    m.exports = exports;
    m.loaded = true;
    require.cache[p] = m;
}

stub('../core/integrations/integrationTools', {
    async getIntegrationTools() {
        if (toolsThrow) throw toolsThrow;
        return { tools: [...grantedTools].map(name => ({ function: { name } })) };
    },
});
stub('../core/tools/toolDispatcher', {
    async executeTool(name, args, ctx) {
        calls.push({ name, args, ctx });
        return toolAnswer(name, args);
    },
});

const { authorizeSource, searchRecords, describePick, boundText } = require('./formPickRecord');
const { MAX_TEXT_CHARS } = require('./formPickSources');

const FILLER = { userId: 'u_filler', session: { user: { id: 'u_filler' } }, orgId: 'org_1', orgIds: ['org_1'], userGroupIds: [] };

function reset({ granted = ['fireflies_list_transcripts', 'fireflies_get_transcript'], answer = () => ({}) } = {}) {
    grantedTools = new Set(granted);
    toolsThrow = null;
    toolAnswer = answer;
    calls.length = 0;
}

// ── Authorisation ─────────────────────────────────────────────────────────

test('without a signed-in filler nothing is searched and nothing is read', async () => {
    reset();
    const refused = await authorizeSource('fireflies_transcript', null);
    assert.match(refused.error, /signed in/i);

    const searched = await searchRecords('fireflies_transcript', 'kickoff', null);
    assert.match(searched.error, /signed in/i);
    assert.strictEqual(calls.length, 0, 'no tool may be dispatched without a caller');

    // A submission with a pick on it still goes through — it just carries the
    // reason instead of the record.
    const described = await describePick({ source: 'fireflies_transcript', recordId: 'tr_1', title: 'Kickoff' }, { caller: null });
    assert.strictEqual(described.kind, 'app_pick');
    assert.strictEqual(described.title, 'Kickoff');
    assert.match(described.textError, /signed in/i);
});

test('a source whose tools the filler cannot run is refused before dispatch', async () => {
    reset({ granted: [] });
    const out = await searchRecords('fireflies_transcript', '', FILLER);
    assert.match(out.error, /not connected/i);
    assert.deepStrictEqual(out.results, undefined);
    assert.strictEqual(calls.length, 0);
});

test('BOTH of a source\'s tools are required — search alone is not enough', async () => {
    // Otherwise a picker lists the person's meetings and then attaches
    // nothing, which is worse than an honest refusal before they pick.
    reset({ granted: ['fireflies_list_transcripts'] });
    const out = await searchRecords('fireflies_transcript', '', FILLER);
    assert.match(out.error, /not connected/i);
    assert.strictEqual(calls.length, 0);
});

test('an unresolvable tool set is a refusal, never an empty result list', async () => {
    reset();
    toolsThrow = new Error('resolver down');
    const out = await searchRecords('fireflies_transcript', '', FILLER);
    assert.ok(out.error, '"we do not know" must not read as "you have nothing"');
    assert.strictEqual(calls.length, 0);
});

test('an unknown source is refused', async () => {
    reset();
    const out = await searchRecords('not_an_app', '', FILLER);
    assert.match(out.error, /not available/i);
});

// ── Search ────────────────────────────────────────────────────────────────

test('a search dispatches the source\'s own tool, with args built here', async () => {
    reset({ answer: () => ({ results: [{ id: 'tr_1', title: 'Kickoff', date: '2026-09-01' }] }) });
    const out = await searchRecords('fireflies_transcript', '  kickoff  ', FILLER, { limit: 9999 });
    assert.deepStrictEqual(out.results.map(r => r.id), ['tr_1']);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].name, 'fireflies_list_transcripts');
    // Trimmed by the registry's clamp, and the caller's absurd limit capped.
    assert.strictEqual(calls[0].args.title, 'kickoff');
    assert.ok(calls[0].args.limit <= 25);
    // Dispatched as the FILLER, never as anybody else.
    assert.strictEqual(calls[0].ctx.userId, 'u_filler');
});

test('a tool that reports failure as { error } is a search error, not an empty list', async () => {
    reset({ answer: () => ({ error: 'Fireflies API key not configured.' }) });
    const out = await searchRecords('fireflies_transcript', '', FILLER);
    assert.match(out.error, /API key/);
});

test('a tool that throws is caught and named', async () => {
    reset({ answer: () => { throw new Error('upstream 503'); } });
    const out = await searchRecords('fireflies_transcript', '', FILLER);
    assert.ok(out.error);
});

// ── Read ──────────────────────────────────────────────────────────────────

test('a read merges the record onto the reference, and prefers the record\'s own title', async () => {
    reset({
        answer: (name) => (name === 'fireflies_get_transcript'
            ? { id: 'tr_1', title: 'Kickoff with Acme', date: '2026-09-01', url: 'https://ff/tr_1', sentences: [{ speaker: 'Tom', text: 'Welkom.' }] }
            : {}),
    });
    const out = await describePick({ source: 'fireflies_transcript', app: 'Fireflies', recordId: 'tr_1', title: 'stale title' }, { caller: FILLER });
    assert.strictEqual(out.kind, 'app_pick');
    assert.strictEqual(out.recordId, 'tr_1');
    assert.strictEqual(out.title, 'Kickoff with Acme');
    assert.strictEqual(out.url, 'https://ff/tr_1');
    assert.strictEqual(out.text, 'Tom: Welkom.');
    assert.strictEqual(out.textTruncated, false);
    assert.strictEqual(out.textError, undefined);
});

test('withText:false reads nothing at all — only the reference travels', async () => {
    reset({ answer: () => ({ sentences: [{ text: 'secret' }] }) });
    const out = await describePick({ source: 'fireflies_transcript', app: 'Fireflies', recordId: 'tr_1', title: 'Kickoff' }, { withText: false, caller: FILLER });
    assert.strictEqual(out.text, undefined);
    assert.strictEqual(out.title, 'Kickoff');
    assert.strictEqual(calls.length, 0, 'no read may be made when only a reference was asked for');
});

test('a record that cannot be read keeps the reference and says why', async () => {
    reset({ answer: () => ({ error: 'Transcript not found: tr_1' }) });
    const out = await describePick({ source: 'fireflies_transcript', app: 'Fireflies', recordId: 'tr_1', title: 'Kickoff' }, { caller: FILLER });
    assert.strictEqual(out.recordId, 'tr_1');
    assert.strictEqual(out.title, 'Kickoff');
    assert.match(out.textError, /not found/);
    assert.strictEqual(out.text, undefined);
});

test('an empty record is a named textError, not a silent empty string', async () => {
    reset({ answer: () => ({ title: 'Kickoff', sentences: [] }) });
    const out = await describePick({ source: 'fireflies_transcript', app: 'Fireflies', recordId: 'tr_1' }, { caller: FILLER });
    assert.ok(out.textError);
    assert.strictEqual(out.text, undefined);
});

test('a clipped record announces itself, whichever cap did the clipping', async () => {
    // The source's own flag…
    reset({ answer: () => ({ title: 'Long call', truncated: true, sentences: [{ text: 'hi' }] }) });
    let out = await describePick({ source: 'fireflies_transcript', recordId: 'tr_1' }, { caller: FILLER });
    assert.strictEqual(out.textTruncated, true, "the tool's own 500-sentence cap must survive the merge");

    // …and ours.
    const manySentences = Array.from({ length: 40 }, () => ({ speaker: 'Tom', text: 'x'.repeat(2000) }));
    reset({ answer: () => ({ title: 'Long call', sentences: manySentences }) });
    out = await describePick({ source: 'fireflies_transcript', recordId: 'tr_1' }, { caller: FILLER });
    assert.strictEqual(out.textTruncated, true);
    assert.strictEqual(out.text.length, MAX_TEXT_CHARS);
    assert.ok(out.textTotalChars > MAX_TEXT_CHARS);
});

test('boundText announces a cut and leaves a short text alone', () => {
    assert.deepStrictEqual(boundText('   '), {});
    assert.deepStrictEqual(boundText(null), {});
    const short = boundText('hello');
    assert.strictEqual(short.text, 'hello');
    assert.strictEqual(short.textTruncated, false);
});
