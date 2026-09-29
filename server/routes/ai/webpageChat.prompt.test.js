/**
 * routes/ai/webpageChat — de `bf-*`-conventie in de bouwer-prompt.
 *
 * ── WAAROM DIT EEN TEST IS EN GEEN COMMENTAARREGEL ──────────────────
 *
 * Het `bf-*`-vocabulaire leeft al op drie plekken (de client-composer, de
 * publieke brug en de snapshot-uitklapper) en dit is de vierde. De drie andere
 * worden door core/webpages/bfElements.drift.test.js aan de registry gehouden;
 * deze plek is anders, want een PROMPT werkt ook als hij achterloopt — hij is
 * alleen niet meer waar. Een model dat een element voorstelt dat niet bestaat,
 * of dat de twee nieuwe niet kent, geeft geen enkele foutmelding.
 *
 * Daarom staat de lijst hier niet met de hand maar wordt hij AFGELEID
 * (`vocabularyPromptLines()`), en toetst deze test alleen dat die afleiding
 * er ook echt in belandt.
 *
 * ── WAT DIT KAN BEWIJZEN ────────────────────────────────────────────
 *
 * Dat de bouwer-prompt zijn elementen uit de registry haalt, en dat het blok in
 * het EDITING TOOLS-hoofdstuk staat — bij de andere schrijfregels, niet ergens
 * onderaan bij de bruggen.
 *
 * ── WAT DIT NIET KAN BEWIJZEN ───────────────────────────────────────
 *
 * Dat het model de conventie ook VOLGT. Dat is geen eigenschap van deze tekst.
 *
 * De brontekst wordt gelezen in plaats van de prompt zelf uitgevoerd: de prompt
 * is een template-literal in een routebestand dat bij `require` de hele
 * routestack en de databankverbindingen optuigt. Zelfde reden en zelfde
 * mechanisme als automation/builderTools/promptCatalogSync.test.js.
 *
 * Draaien: cd server && node --test --test-force-exit routes/ai/webpageChat.prompt.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const bf = require('../../core/webpages/bfElements');

const SOURCE = fs.readFileSync(path.join(__dirname, 'webpageChat.js'), 'utf8');

/** Het EDITING TOOLS-hoofdstuk van de systeemprompt, als tekst. */
function editingToolsSection() {
    const start = SOURCE.indexOf('EDITING TOOLS');
    // Een hernoemde kop moet ROOD worden, niet stil een lege sectie opleveren.
    assert.notStrictEqual(start, -1, 'de systeemprompt draagt nog een EDITING TOOLS-hoofdstuk');
    const end = SOURCE.indexOf('SQLITE DATABASE', start);
    assert.notStrictEqual(end, -1, 'en daarna nog een SQLITE DATABASE-hoofdstuk');
    const section = SOURCE.slice(start, end);
    assert.ok(section.length > 500, 'sanity: het hoofdstuk is uitgelezen en niet leeg');
    return section;
}

test('de bouwer-prompt noemt de bf-*-conventie IN het EDITING TOOLS-hoofdstuk', () => {
    const section = editingToolsSection();
    assert.match(section, /\$\{BF_ELEMENTS_PROMPT\}/,
        'de afgeleide elementlijst wordt niet in het EDITING TOOLS-hoofdstuk uitgevouwen; daar staan de '
        + 'schrijfregels, en een conventie die ergens anders staat wordt bij het schrijven niet gelezen');
    // De twee regels die van een element pas een werkend element maken.
    assert.match(section, /webpage_grant_/,
        'de prompt moet zeggen dat een element pas werkt als het doel aan de pagina is toegekend');
    assert.match(section, /published page runs NO JavaScript/,
        'en dat een gepubliceerde pagina geen JS draait — anders stelt het model een knop voor die daar dood is');
});

test('BITE — de lijst is AFGELEID uit de registry, niet met de hand geschreven', () => {
    // Vervangt iemand de afleiding door een letterlijke lijst, dan loopt die
    // vanaf dat moment stil achter op core/webpages/bfElements.js.
    assert.match(SOURCE, /const BF_ELEMENTS_PROMPT = vocabularyPromptLines\(\)/,
        'BF_ELEMENTS_PROMPT hoort uit vocabularyPromptLines() te komen');
    // Bewust brontekst, zoals de bestandskop uitlegt: require() hier tuigt de
    // hele routestack en databankverbindingen op.
    assert.match(SOURCE, /require\('\.\.\/\.\.\/core\/webpages\/bfElements'\)/);

    // En de afleiding levert werkelijk elk element op, met de inertie erbij:
    // zonder dat zou het model een knop voorstellen en zou de auteur pas na
    // publiceren merken dat hij daar niets doet.
    const rendered = bf.vocabularyPromptLines().join('\n');
    for (const tag of bf.BF_TAGS) {
        assert.ok(rendered.includes(`<${tag}>`), `${tag} ontbreekt in de prompt-regels`);
    }
    for (const tag of bf.tagsNeedingJs()) {
        const line = bf.vocabularyPromptLines().find(l => l.startsWith(`<${tag}>`));
        assert.match(line, /INERT once published/, `${tag} moet in de prompt als inert bekendstaan`);
    }
    assert.ok(bf.tagsNeedingJs().length >= 3, 'sanity: er zijn elementen die JS nodig hebben');
});

test('geen tweede lijst — webpageChat.js schrijft zelf geen tagnaam op', () => {
    // Dezelfde regel als in bfElements.drift.test.js, hier expliciet voor de
    // plek waar hij het makkelijkst wordt overtreden: proza nodigt uit om even
    // een voorbeeld uit te schrijven, en dat voorbeeld veroudert.
    const tagWord = new RegExp(`(?<![-\\w])(?:${bf.BF_TAGS.join('|')})(?![-\\w])`, 'g');
    // Bewust brontekst: "geen tweede letterlijke lijst" is een eigenschap van
    // de tekst zelf, niet van gedrag dat je door aanroepen kunt waarnemen.
    assert.deepStrictEqual(SOURCE.match(tagWord) || [], [],
        'routes/ai/webpageChat.js noemt een bf-element met de hand; die naam kan achterlopen op de registry');
});
