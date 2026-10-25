// @typecheck strict
/**
 * The AI turn and the version history (W4).
 *
 * ── WHY THIS IS A SOURCE-TEXT TEST ──────────────────────────────────────
 *
 * The write path sits deep inside the SSE stream of POST /ai/chat/webpage/stream: an
 * adapter, a tool loop, a validation round. Recreating that whole machine to see one createVersion call is a test that mostly proves itself.
 * What is at stake here is a DECISION, and that decision is visible in the source text: the same form that webpageShareReconciler.test.js uses to show that the datatable tap really does call the shared reconciler.
 *
 * WHAT THIS CAN PROVE: that the AI arm writes a snapshot per turn, with `source: 'ai'`, with a summary that comes from the TOOLS, and with a line difference that is measured against the state from before the turn.
 *
 * WHAT THIS CANNOT PROVE: that this call actually happens during a real turn. That hangs on the tool loop above; this test looks at the wiring, not at the behaviour.
 *
 * Run: node --test --test-force-exit routes/ai/webpageChat.versions.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

// Since the route was split, the end of the turn lives in webpageChat/finalize.js,
// the pre-turn copy in webpageChat/toolLoop.js and the tool writes in
// webpageChat/tools.js.
const SRC = fs.readFileSync(require.resolve('./webpageChat/finalize'), 'utf8');
const LOOP_SRC = fs.readFileSync(require.resolve('./webpageChat/toolLoop'), 'utf8');
const TOOLS_SRC = fs.readFileSync(require.resolve('./webpageChat/tools'), 'utf8');

/** The block that writes the operations of this turn. */
function persistBlock() {
    const start = SRC.indexOf('if (dirtySlots.size > 0) {');
    assert.ok(start !== -1, 'sanity: het persistentieblok van de beurt is niet meer te vinden');
    const end = SRC.indexOf('if (_streamUntok)', start);
    assert.ok(end > start, 'sanity: het einde van het persistentieblok is niet meer te vinden');
    return SRC.slice(start, end);
}

test("een AI-beurt schrijft zijn momentopname met source 'ai'", () => {
    // Before W4 there was no source here, so AI turns landed as 'manual' —
    // the value 'ai' was already reserved and was written nowhere.
    const block = persistBlock();
    assert.match(block, /createVersion\([\s\S]*?'ai'/,
        "zonder deze waarde is een AI-beurt in de lijst niet van een handmatige save te onderscheiden");
});

test('BIJT: de 5-minuten-debounce staat NIET meer in het AI-pad', () => {
    // Keystrokes may be summarised; a turn is an event.
    // Under the debounce, two turns within five minutes shared one restore point, and then the second turn could no longer be restored on its own.
    const block = persistBlock();
    assert.ok(!/shouldAutoVersion/.test(block),
        'een tweede beurt binnen het venster hoort zijn eigen terugzetpunt te krijgen');
});

test('de samenvatting komt uit de gereedschappen, niet uit de proza van het model', () => {
    const block = persistBlock();
    assert.match(block, /versionFacts\.aiTurnSummary\(dirtySlots\)/,
        'het model beschrijft zijn eigen werk niet altijd correct; dirtySlots wel');
    assert.ok(!/createVersion\([^)]*fullContent/.test(block),
        'de tekst van het antwoord mag nooit de samenvatting worden');
});

test('het regelverschil wordt gemeten tegen de stand van VÓÓR de beurt', () => {
    const block = persistBlock();
    assert.match(block, /slotsLineDelta\(preTurnFiles, liveFiles, dirtySlots\)/,
        'liveFiles wordt door de gereedschappen ter plekke overschreven — zonder de kopie is er niets meer te meten');
    // Deliberately source text, as the file header above explains: pinning the wiring
    // is what is achievable here, not the behaviour of a real SSE turn.
    assert.match(LOOP_SRC, /const preTurnFiles = \{ \.\.\.liveFiles \};/,
        'de kopie moet gemaakt worden vóór de eerste gereedschapsronde');
    // De gereedschappen schrijven liveFiles in tools.js; de lus maakt de kopie
    // vóórdat hij die schrijver (createToolDispatcher) optuigt.
    assert.ok(TOOLS_SRC.includes('liveFiles[slot] = toolResult.content'),
        'sanity: de gereedschappen schrijven liveFiles nog ter plekke');
    const copyAt = LOOP_SRC.indexOf('const preTurnFiles');
    const firstToolWrite = LOOP_SRC.indexOf('createToolDispatcher(');
    assert.ok(copyAt !== -1 && firstToolWrite !== -1 && copyAt < firstToolWrite,
        'sanity: de kopie staat vóór de plek waar de gereedschappen liveFiles schrijven');
});

test('de maker is de persoon achter de beurt, niet een verzonnen AI-account', () => {
    const block = persistBlock();
    assert.match(block, /actorUserId: userId/,
        "'source' zegt al dat het een AI-beurt was; een tweede plek die dat nog eens zegt gaat er ooit anders over denken");
});

test('de versiefeiten komen uit de gedeelde module, niet uit een eigen kopie', () => {
    assert.match(SRC, /require\('\.\.\/\.\.\/\.\.\/core\/webpages\/versionFacts'\)/,
        'drie schrijfplekken met elk hun eigen manier om regels te tellen gaan verschillende taal spreken');
});
