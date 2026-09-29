/**
 * De AI-beurt en de versiegeschiedenis (W4).
 *
 * ── WAAROM DIT EEN BRONTEKST-TEST IS ────────────────────────────────────────
 *
 * De schrijfweg zit diep in de SSE-stream van POST /ai/chat/webpage/stream: een
 * adapter, een gereedschapslus, een validatieronde. Die hele machine namaken om
 * één createVersion-aanroep te zien is een test die vooral zichzelf bewijst.
 * Wat hier op het spel staat is een BESLISSING, en die is in de brontekst
 * zichtbaar: dezelfde vorm die webpageShareReconciler.test.js gebruikt om te
 * tonen dat de datatable-tap de gedeelde reconciler écht aanroept.
 *
 * WAT DIT KAN BEWIJZEN: dat de AI-arm per beurt een momentopname schrijft, met
 * `source: 'ai'`, met een samenvatting die uit de GEREEDSCHAPPEN komt, en met
 * een regelverschil dat tegen de stand van vóór de beurt is gemeten.
 *
 * WAT DIT NIET KAN BEWIJZEN: dat die aanroep bij een echte beurt ook werkelijk
 * gebeurt. Dat hangt aan de gereedschapslus erboven; deze test kijkt naar de
 * bedrading, niet naar het gedrag.
 *
 * Run: node --test --test-force-exit routes/ai/webpageChat.versions.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const SRC = fs.readFileSync(require.resolve('./webpageChat'), 'utf8');

/** Het blok dat de bewerkingen van deze beurt wegschrijft. */
function persistBlock() {
    const start = SRC.indexOf('if (dirtySlots.size > 0) {');
    assert.ok(start !== -1, 'sanity: het persistentieblok van de beurt is niet meer te vinden');
    const end = SRC.indexOf('if (_streamUntok)', start);
    assert.ok(end > start, 'sanity: het einde van het persistentieblok is niet meer te vinden');
    return SRC.slice(start, end);
}

test("een AI-beurt schrijft zijn momentopname met source 'ai'", () => {
    // Vóór W4 stond hier geen source, dus landden AI-beurten als 'manual' —
    // de waarde 'ai' was al gereserveerd en werd nergens geschreven.
    const block = persistBlock();
    assert.match(block, /createVersion\([\s\S]*?'ai'/,
        "zonder deze waarde is een AI-beurt in de lijst niet van een handmatige save te onderscheiden");
});

test('BIJT: de 5-minuten-debounce staat NIET meer in het AI-pad', () => {
    // Toetsaanslagen mogen samengevat worden; een beurt is een gebeurtenis.
    // Onder de debounce deelden twee beurten binnen vijf minuten één
    // terugzetpunt, en dan is de tweede beurt niet meer los terug te draaien.
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
    // Bewust brontekst, zoals de bestandskop hierboven uitlegt: de bedrading
    // pinnen is hier het haalbare, niet het gedrag van een echte SSE-beurt.
    assert.match(SRC, /const preTurnFiles = \{ \.\.\.liveFiles \};/,
        'de kopie moet gemaakt worden vóór de eerste gereedschapsronde');
    const copyAt = SRC.indexOf('const preTurnFiles');
    const firstToolWrite = SRC.indexOf('liveFiles[slot] = toolResult.content');
    assert.ok(copyAt !== -1 && firstToolWrite !== -1 && copyAt < firstToolWrite,
        'sanity: de kopie staat vóór de plek waar de gereedschappen liveFiles schrijven');
});

test('de maker is de persoon achter de beurt, niet een verzonnen AI-account', () => {
    const block = persistBlock();
    assert.match(block, /actorUserId: userId/,
        "'source' zegt al dat het een AI-beurt was; een tweede plek die dat nog eens zegt gaat er ooit anders over denken");
});

test('de versiefeiten komen uit de gedeelde module, niet uit een eigen kopie', () => {
    assert.match(SRC, /require\('\.\.\/\.\.\/core\/webpages\/versionFacts'\)/,
        'drie schrijfplekken met elk hun eigen manier om regels te tellen gaan verschillende taal spreken');
});
