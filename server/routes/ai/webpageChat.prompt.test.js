// @typecheck strict
/**
 * routes/ai/webpageChat — the `bf-*` convention in the builder prompt.
 *
 * ── WHY THIS IS A TEST AND NOT A COMMENT LINE ───────────────────────
 *
 * The `bf-*` vocabulary already lives in three places (the client composer, the public bridge
 * and the snapshot expander) and this is the fourth. The other three
 * are kept in line with the registry by core/webpages/bfElements.drift.test.js; this place is different,
 * because a PROMPT also works when it lags behind — it is simply no longer correct. A model that proposes an element that does not exist,
 * or does not know the two new ones, gives no error message at all.
 *
 * That is why the list is not written out by hand here but DERIVED
 * (`vocabularyPromptLines()`), and this test checks only that that derivation
 * really ends up in there.
 *
 * ── WHAT THIS CAN PROVE ─────────────────────────────────────────────
 *
 * That the builder prompt takes its elements from the registry, and that the block stands in
 * the EDITING TOOLS chapter — next to the other write rules, not somewhere at the bottom with the bridges.
 *
 * ── WHAT THIS CANNOT PROVE ──────────────────────────────────────────
 *
 * That the model also FOLLOWS the convention. That is not a property of this text.
 *
 * The source text is read instead of running the prompt itself: the prompt is a template literal in a route file that, on `require`, sets up the whole
 * route stack and the database connections. Same reason and same mechanism as automation/builderTools/promptCatalogSync.test.js.
 *
 * Run: cd server && node --test --test-force-exit routes/ai/webpageChat.prompt.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const bf = require('../../core/webpages/bfElements');

// The prompt text lives in webpageChat/systemPrompt.js since the route was
// split; the "no second list" rule covers the route and every step of it.
const SOURCE = fs.readFileSync(path.join(__dirname, 'webpageChat', 'systemPrompt.js'), 'utf8');
const ROUTE_FILES = ['webpageChat.js', ...fs.readdirSync(path.join(__dirname, 'webpageChat'))
    .filter(f => f.endsWith('.js') && !f.endsWith('.test.js'))
    .map(f => path.join('webpageChat', f))];
const ROUTE_SOURCE = ROUTE_FILES.map(f => fs.readFileSync(path.join(__dirname, f), 'utf8')).join('\n');

/** Het EDITING TOOLS-hoofdstuk van de systeemprompt, als tekst. */
function editingToolsSection() {
    const start = SOURCE.indexOf('EDITING TOOLS');
    // A renamed heading must turn RED, not quietly yield an empty section.
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
    // If someone replaces the derivation with a literal list, that list will from that moment on
    // quietly lag behind core/webpages/bfElements.js.
    assert.match(SOURCE, /const BF_ELEMENTS_PROMPT = vocabularyPromptLines\(\)/,
        'BF_ELEMENTS_PROMPT hoort uit vocabularyPromptLines() te komen');
    // Bewust brontekst, zoals de bestandskop uitlegt: require() hier tuigt de
    // hele routestack en databankverbindingen op.
    assert.match(SOURCE, /require\('\.\.\/\.\.\/\.\.\/core\/webpages\/bfElements'\)/);

    // And the derivation really does yield every element, with the inertia included:
    // without that the model would propose a button and the author would only notice after
    // publishing that it does nothing there.
    const rendered = bf.vocabularyPromptLines().join('\n');
    for (const tag of bf.BF_TAGS) {
        assert.ok(rendered.includes(`<${tag}>`), `${tag} ontbreekt in de prompt-regels`);
    }
    for (const tag of bf.tagsNeedingJs()) {
        const line = bf.vocabularyPromptLines().find(l => l.startsWith(`<${tag}>`));
        assert.match(String(line), /INERT once published/, `${tag} moet in de prompt als inert bekendstaan`);
    }
    assert.ok(bf.tagsNeedingJs().length >= 3, 'sanity: er zijn elementen die JS nodig hebben');
});

test('geen tweede lijst — webpageChat.js en zijn stappen schrijven zelf geen tagnaam op', () => {
    // The same rule as in bfElements.drift.test.js, here explicitly for the
    // place where it is most easily broken: prose invites you to write out an example for a moment, and that example goes out of date.
    const tagWord = new RegExp(`(?<![-\\w])(?:${bf.BF_TAGS.join('|')})(?![-\\w])`, 'g');
    // Deliberately source text: "no second literal list" is a property of
    // the text itself, not of behaviour that you can observe by calling it.
    assert.ok(ROUTE_FILES.length >= 2, 'sanity: de stappen in webpageChat/ zijn gevonden');
    assert.deepStrictEqual(ROUTE_SOURCE.match(tagWord) || [], [],
        'routes/ai/webpageChat.js (of een stap in webpageChat/) noemt een bf-element met de hand; die naam kan achterlopen op de registry');
});
