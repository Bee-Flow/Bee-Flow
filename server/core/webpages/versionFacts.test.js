/**
 * versionFacts — de feiten achter één rij in de geschiedenislijst.
 *
 * De regel die elke test hieronder verdedigt is dezelfde:
 * ONBEKEND IS NIET NUL EN NIET JIJ. Een geschiedenis die "0 regels" of "jij"
 * zegt op grond van niets, is erger dan een geschiedenis die zwijgt: de eerste
 * wordt geloofd.
 *
 * Zuivere module, dus geen harnas — geen database, geen opslag, geen mocks.
 *
 * Run: node --test --test-force-exit core/webpages/versionFacts.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const {
    SLOT_FILES, MANUAL_EDIT_SUMMARY,
    countLines, lineDelta, slotsLineDelta, joinFileNames,
    aiTurnSummary, restoreSummary, actorOf,
} = require('./versionFacts');

// ── Regels tellen ─────────────────────────────────────────────────────

test('een leeg bestand heeft nul regels, niet één lege regel', () => {
    assert.strictEqual(countLines(''), 0);
    assert.strictEqual(countLines('a'), 1);
});

test('een afsluitende newline maakt geen extra regel', () => {
    // BIJT: `split('\n').length` geeft hier 2, en dan zou elke bewerking die
    // alleen het bestand netjes afsluit als "+1 regel" in de lijst komen.
    assert.strictEqual(countLines('a\n'), 1);
    assert.strictEqual(countLines('a\nb'), 2);
    assert.strictEqual(countLines('a\nb\n'), 2);
    assert.strictEqual(countLines('\n'), 1, 'één lege regel is wél een regel');
});

test('wat geen tekst is heeft geen regels', () => {
    for (const v of [null, undefined, 0, {}, []]) {
        assert.strictEqual(countLines(v), 0, `${JSON.stringify(v)} is geen tekst`);
    }
});

// ── Het regelverschil ─────────────────────────────────────────────────

test('het verschil telt beide kanten op', () => {
    assert.strictEqual(lineDelta('a', 'a\nb\nc'), 2);
    assert.strictEqual(lineDelta('a\nb\nc', 'a'), -2);
    assert.strictEqual(lineDelta('a', 'b'), 0, 'evenveel regels, andere inhoud');
});

test('BIJT: een kant die ontbreekt levert null, nooit een getal', () => {
    // Dit is het hele punt van de kolom. Zou dit 0 (of het aantal regels van
    // de bekende kant) opleveren, dan zou een rij waar niets gemeten kon
    // worden in de lijst als "geen wijziging" verschijnen — een bewering.
    assert.strictEqual(lineDelta(null, 'a\nb'), null);
    assert.strictEqual(lineDelta('a\nb', null), null);
    assert.strictEqual(lineDelta(undefined, undefined), null);
});

test('over meerdere slots telt het verschil op, en meet alleen wat er is', () => {
    const before = { html: 'a', css: 'x\ny\nz' };
    const after = { html: 'a\nb\nc', css: 'x' };
    assert.strictEqual(slotsLineDelta(before, after, ['html', 'css']), 0, '+2 en −2');
    assert.strictEqual(slotsLineDelta(before, after, ['html']), 2);
});

test('BIJT: geen enkel meetbaar slot levert null, geen 0', () => {
    assert.strictEqual(slotsLineDelta({}, {}, ['html', 'css']), null);
    assert.strictEqual(slotsLineDelta({ html: 'a' }, {}, ['html']), null);
    assert.strictEqual(slotsLineDelta(null, null, ['html']), null);
    assert.strictEqual(slotsLineDelta({ html: 'a' }, { html: 'a' }, ['html']), 0,
        'maar een gemeten nulverschil IS 0 — dat is een uitspraak die we mogen doen');
});

test('een Set van slots werkt net zo goed als een array', () => {
    // De aanroeper in webpageChat.js heeft `dirtySlots` als Set.
    assert.strictEqual(slotsLineDelta({ html: 'a' }, { html: 'a\nb' }, new Set(['html'])), 1);
});

// ── De samenvatting ───────────────────────────────────────────────────

test('bestandsnamen worden als zin aan elkaar geregen', () => {
    assert.strictEqual(joinFileNames(['a']), 'a');
    assert.strictEqual(joinFileNames(['a', 'b']), 'a and b');
    assert.strictEqual(joinFileNames(['a', 'b', 'c']), 'a, b and c');
    assert.strictEqual(joinFileNames([]), '');
});

test('de AI-beurt noemt de bestanden die hij schreef, in een vaste volgorde', () => {
    assert.strictEqual(aiTurnSummary(new Set(['html'])), 'AI edited index.html');
    // BIJT: css eerst toegevoegd, maar html wordt eerst genoemd — twee
    // identieke beurten moeten dezelfde regel opleveren, ook als de
    // gereedschappen in een andere volgorde vuurden.
    assert.strictEqual(aiTurnSummary(new Set(['css', 'html'])), 'AI edited index.html and style.css');
    assert.strictEqual(aiTurnSummary(new Set(['js', 'css', 'html'])),
        'AI edited index.html, style.css and script.js');
});

test('een beurt zonder herkenbaar slot valt terug op de oude, eerlijke tekst', () => {
    assert.strictEqual(aiTurnSummary(new Set()), 'AI edit');
    assert.strictEqual(aiTurnSummary(new Set(['verzonnen'])), 'AI edit',
        'een onbekend slot mag geen bestandsnaam verzinnen');
    assert.strictEqual(aiTurnSummary(null), 'AI edit');
});

test('de slotnamen zijn de namen die het hele product gebruikt', () => {
    // Niet "styles.css"/"app.js": de opslag, de bestandsverkenner, de
    // ZIP-export en de snapshot-renderer schrijven deze drie zo op.
    assert.deepStrictEqual(SLOT_FILES, { html: 'index.html', css: 'style.css', js: 'script.js' });
});

test('de handmatige bewerking heet naar waar hij gemaakt is', () => {
    assert.strictEqual(MANUAL_EDIT_SUMMARY, 'Edited in code');
});

test('de terugzet-momentopname zegt dat hij van VÓÓR het terugzetten is', () => {
    // De rij bevat de oude stand; "Restored v12" zou op zo'n rij precies
    // andersom lezen ("terugzetten geeft me v12" — nee, het geeft de stand van
    // vóór die actie).
    assert.strictEqual(restoreSummary(12), 'Before restoring v12');
    assert.strictEqual(restoreSummary(null), 'Before restoring an earlier version',
        'een rij van vóór de seq-kolom heeft geen nummer om naar te wijzen');
    assert.strictEqual(restoreSummary(0), 'Before restoring an earlier version');
});

// ── De maker ──────────────────────────────────────────────────────────

test('BIJT: een niet-vastgelegde maker is null — niet de lezer', () => {
    // Zou dit terugvallen op viewerId, dan zou elke rij van vóór de kolom
    // beweren dat de huidige gebruiker hem maakte.
    assert.strictEqual(actorOf(null, { viewerId: 'alice' }), null);
    assert.strictEqual(actorOf('', { viewerId: 'alice' }), null);
    assert.strictEqual(actorOf('   ', { viewerId: 'alice' }), null);
    assert.strictEqual(actorOf(undefined, { viewerId: 'alice' }), null);
});

test('BIJT: een maker die niet op te zoeken is houdt zijn id en verliest zijn naam', () => {
    // Niet leeg (er stáát een maker) en niet "jij" (hij is het niet).
    const a = actorOf('ghost', { viewerId: 'alice', names: new Map() });
    assert.deepStrictEqual(a, { id: 'ghost', name: null, isYou: false });
});

test('de lezer zelf is herkenbaar aan het id, niet aan de naam', () => {
    const a = actorOf('alice', { viewerId: 'alice', names: new Map([['alice', 'Alice A']]) });
    assert.strictEqual(a.isYou, true);
    assert.strictEqual(a.name, 'Alice A');
    // Twee collega's met dezelfde weergavenaam mogen elkaars werk niet erven.
    const b = actorOf('bob', { viewerId: 'alice', names: new Map([['bob', 'Alice A']]) });
    assert.strictEqual(b.isYou, false);
});

test('zonder lezer is niemand "jij"', () => {
    assert.strictEqual(actorOf('alice', { names: new Map([['alice', 'A']]) }).isYou, false);
});

test('de namen mogen als Map of als gewoon object komen', () => {
    assert.strictEqual(actorOf('u1', { names: new Map([['u1', 'One']]) }).name, 'One');
    assert.strictEqual(actorOf('u1', { names: { u1: 'One' } }).name, 'One');
    assert.strictEqual(actorOf('u1', { names: { u1: '   ' } }).name, null,
        'een naam van alleen spaties is geen naam');
});
