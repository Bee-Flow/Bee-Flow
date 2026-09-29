/**
 * Two things every write through this tool must carry, on BOTH of its ingest
 * paths — and neither was carried before K10.
 *
 * 1. THE PRIVACY SHIELD. `ingestDocument` screens text only when a caller asks
 *    it to, and this caller never did. That was survivable while the only
 *    caller was the support template, whose prompt spends a paragraph telling
 *    the model to strip personal data — a prompt is not a control, but it was
 *    something. K10 gave every routine a `knowledge_write` step that can be
 *    pointed straight at a raw email body or a transcript, and what lands here
 *    is text an agent later quotes back with a citation.
 *
 * 2. THE ORIGIN. `support_ticket` / provider `support` were constants, so a
 *    nightly system summary was filed as a support ticket.
 *
 * The trap this file exists for is the SECOND path. A sourceUri makes the step
 * idempotent, which means `_refreshInPlace` is the path taken on every run
 * after the first — the more travelled one, not the less. Applying either of
 * these only to the first write means a nightly routine's article is screened
 * once, on the night it was created, and never again.
 *
 * Read as SOURCE rather than executed: reaching the ingest needs a database, a
 * knowledge base and the write gate, and what is under test is that the option
 * is threaded to every call.
 *
 * Run: cd server && node --test --test-force-exit integrations/kbIngestTools.shield.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, 'kbIngestTools.js'), 'utf8');

/**
 * Every `ingestDocument(...)` CALL SITE in the file, as source text.
 *
 * Anchored on `await ingestDocument(` so the header comment's prose mention of
 * the function is not read as a call — the first version of this test failed
 * on its own documentation.
 */
function ingestCalls() {
    const out = [];
    const NEEDLE = 'await ingestDocument(';
    let i = SRC.indexOf(NEEDLE);
    while (i !== -1) {
        // Take to the closing `});` of the options object — enough to see
        // which options the call passes.
        const end = SRC.indexOf('});', i);
        out.push(SRC.slice(i, end === -1 ? i + 400 : end));
        i = SRC.indexOf(NEEDLE, i + 1);
    }
    return out;
}

test('every ingest through this tool passes the privacy screen', () => {
    const calls = ingestCalls();
    assert.ok(calls.length >= 2, `expected both ingest paths, found ${calls.length}`);
    for (const call of calls) {
        assert.match(call, /privacy:/, `an ingest that skips the screen:\n${call.slice(0, 200)}`);
    }
});

test('the refresh path — the one a nightly routine takes — takes the options', () => {
    // The first write and every write after it must behave the same. A
    // refresh that dropped them would screen an article once and never again.
    const refreshCalls = [...SRC.matchAll(/_refreshInPlace\([^;]*?\);/gs)]
        .map(m => m[0])
        .filter(c => !c.includes('async function'));
    assert.ok(refreshCalls.length >= 3, `expected the refresh/replace/merge call sites, found ${refreshCalls.length}`);
    for (const call of refreshCalls) {
        assert.match(call, /refreshOpts\)/, `a refresh that drops the screen and the origin:\n${call}`);
    }
});

test('nothing is filed as a support ticket unless it IS one', () => {
    // `SOURCE_TYPE` is the support constant. After K10 it may only appear in
    // the ORIGINS table that names it; every ingest reads its origin instead.
    const uses = [...SRC.matchAll(/\bSOURCE_TYPE\b/g)].length;
    assert.strictEqual(uses, 2, `SOURCE_TYPE survives only as its own const and the ORIGINS entry; found ${uses}`);
    for (const call of ingestCalls()) {
        assert.doesNotMatch(call, /SOURCE_TYPE/, `an ingest hardcoding the support source type:\n${call.slice(0, 200)}`);
    }
});

test('a routine write and a support write are filed differently', () => {
    const { ORIGINS } = require('./kbIngestTools');
    assert.notStrictEqual(ORIGINS.routine.sourceType, ORIGINS.support.sourceType);
    assert.notStrictEqual(ORIGINS.routine.provider, ORIGINS.support.provider);
    // `support` stays the DEFAULT so callers that predate this are unchanged.
    assert.strictEqual(ORIGINS.support.sourceType, 'support_ticket');
});

test('the write gate still comes before anything is created', () => {
    // Re-asserted here because this file adds work between the gate and the
    // ingest, and the order is the whole point: nothing about a refused write
    // may reach the store, not even a source row.
    const fn = SRC.slice(SRC.indexOf('async function executeKbIngestTool'));
    assert.ok(fn.indexOf('canOwnerWriteToKb') < fn.indexOf('_ensureAutomationSource'),
        'the identity check comes before the source is attached');
    assert.ok(fn.indexOf('canOwnerWriteToKb') < fn.indexOf('ingestDocument('),
        'and before anything is ingested');
});


// ── the refusal must not destroy what it was replacing ──────────────────
//
// `_refreshInPlace` DELETES the existing document (with skipSnapshot, so there
// is no version to restore) and ingests second. That ordering is only safe
// while nothing in between can refuse. The privacy screen CAN refuse — for an
// org set to `block`, and for any incomplete scan under the default fail-closed
// mode — so a screen applied INSIDE the ingest destroyed a maintained article
// the first time a guard service was degraded for a minute.
//
// The screen therefore runs once in executeKbIngestTool, before anything is
// deleted. These assertions pin that ordering.

test('the privacy screen runs BEFORE the destructive delete, not inside the ingest', () => {
    const fn = SRC.slice(SRC.indexOf('async function executeKbIngestTool'));
    const screen = fn.indexOf('applyShield(');
    const refresh = fn.indexOf('_refreshInPlace(');
    const ingest = fn.indexOf('ingestDocument(');
    assert.ok(screen !== -1, 'executeKbIngestTool screens the text itself');
    assert.ok(screen < refresh, 'and it screens BEFORE the refresh path deletes anything');
    assert.ok(screen < ingest, 'and before anything is ingested');
});

test('a refused screen returns an error and reaches no store call', () => {
    const fn = SRC.slice(SRC.indexOf('async function executeKbIngestTool'));
    const guard = fn.indexOf('OUTCOME.SKIPPED');
    assert.ok(guard !== -1, 'the SKIPPED verdict is handled');
    assert.ok(guard < fn.indexOf('_refreshInPlace('), 'and it returns before the delete');
    // The early return, not a fall-through.
    const after = fn.slice(guard, guard + 400);
    assert.match(after, /return \{ error:/, 'a refusal returns an error rather than continuing');
});

test('nothing screens twice — the ingest calls carry the verdict, not the policy', () => {
    // Screening the already-tokenised text would tokenise the tokens.
    for (const call of ingestCalls()) {
        assert.match(call, /privacy: null/, 'an ingest that would re-run the screen:\n' + call.slice(0, 200));
    }
    assert.match(SRC, /const screenedBody =/, 'the screened text is what flows on');
    // And the raw body must not be what gets stored anywhere.
    const fn = SRC.slice(SRC.indexOf('async function executeKbIngestTool'));
    assert.doesNotMatch(fn, /article: body,/, 'the metadata copy is the screened text, not the raw body');
});

test('a skipped ingest is reported as an error, never as a written document', () => {
    // ingestDocument REPORTS a refusal, it does not throw: an unstorable
    // document comes back as {status:'skipped', chunks:0} with a content-less
    // row. Reading only res.document.id turned that into a green step claiming
    // written:true against a document holding nothing.
    const fn = SRC.slice(SRC.indexOf('async function executeKbIngestTool'));
    const checks = [...fn.matchAll(/res\.status === 'skipped'/g)];
    assert.ok(checks.length >= 2, `both ingest paths check the status; found ${checks.length}`);
});
