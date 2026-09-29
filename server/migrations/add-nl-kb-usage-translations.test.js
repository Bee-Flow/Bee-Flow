/**
 * Guard bij de UITGEZETTE migratie `add-nl-kb-usage-translations` (Track Z).
 *
 * De migratie zaaide NL-waarden voor zeven `kb_detail.usage_*`-sleutels. Die
 * sleutels bestaan in GEEN van beide Engelse woordenboeken meer, dus de
 * migratie schreef bij elke boot DB-rijen voor sleutels die nergens worden
 * opgevraagd: onschadelijk, maar dood. De enige aanroeper
 * (stores/knowledgeBases.js) is daarom uitgezet; het migratiebestand blijft
 * bewust op schijf staan zodat replay van de migratiereeks mogelijk blijft.
 *
 * Deze test is statisch (leest bestanden als TEKST, raakt geen DB) en bewijst
 * de drie feiten waar dat besluit op rust:
 *   a. geen van de zeven sleutels komt nog in een woordenboek voor — komt er
 *      ooit één terug, dan wordt deze test rood en is dat het signaal om de
 *      aanroep in knowledgeBases.js weer aan te zetten;
 *   b. knowledgeBases.js roept de migratie niet meer aan, maar noemt haar naam
 *      nog wél in een comment (dat houdt de orphan-guard in
 *      boot/bootMigrations.test.js groen);
 *   c. het migratiebestand bestaat nog en exporteert nog `up()`.
 *
 * Run: node --test --test-reporter=tap migrations/add-nl-kb-usage-translations.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const MIGRATION_NAME = 'add-nl-kb-usage-translations';
const MIGRATION_FILE = path.join(__dirname, `${MIGRATION_NAME}.js`);
const KB_STORE_FILE = path.join(__dirname, '..', 'stores', 'knowledgeBases.js');

// De Engelse woordenboeken. ALLEEN LEZEN — deze test schrijft er nooit in.
// De serverkant is één bestand per namespace onder i18n/defaults/en/; de
// frontendkopie wordt daaruit gegenereerd (scripts/gen-i18n-defaults.mjs).
const SERVER_DICT_DIR = path.join(__dirname, '..', 'i18n', 'defaults', 'en');
const DICTIONARIES = [
    ...fs.readdirSync(SERVER_DICT_DIR)
        .filter((f) => f.endsWith('.js') && f !== 'index.js')
        .map((f) => path.join(SERVER_DICT_DIR, f)),
    path.join(__dirname, '..', '..', 'agent-hub', 'src', 'i18n', 'en-defaults.js'),
];

const read = (p) => fs.readFileSync(p, 'utf8');

/**
 * De sleutels uit het NL_TRANSLATIONS-blok van de migratie zelf lezen, niet
 * een tweede keer overtypen: verandert de migratie van inhoud, dan verschuift
 * deze guard mee in plaats van een verouderde kopie te bewaken.
 */
function migrationKeys() {
    const src = read(MIGRATION_FILE);
    const block = src.match(/const NL_TRANSLATIONS\s*=\s*\{([\s\S]*?)\n\};/);
    assert.ok(block, 'NL_TRANSLATIONS-blok niet gevonden in de migratie');
    return [...block[1].matchAll(/^\s*'([^']+)'\s*:/gm)].map((m) => m[1]);
}

/**
 * Regelnummers (1-based) van alle regels die commentaar zijn: een `//`-regel,
 * of een regel binnen een `/* ... *\/`-blok. Line-based en dus deterministisch;
 * een JS-parser is hier niet nodig, want de enige vraag is of de aanroepregel
 * code of commentaar is.
 */
function commentLines(src) {
    const out = new Set();
    let inBlock = false;
    src.split('\n').forEach((line, i) => {
        const trimmed = line.trim();
        if (inBlock) {
            out.add(i + 1);
            if (trimmed.includes('*/')) inBlock = false;
            return;
        }
        if (trimmed.startsWith('//')) { out.add(i + 1); return; }
        if (trimmed.startsWith('/*')) {
            out.add(i + 1);
            if (!trimmed.includes('*/')) inBlock = true;
        }
    });
    return out;
}

test('a. geen van de zeven kb_detail.usage_*-sleutels bestaat nog in een Engels woordenboek', () => {
    const keys = migrationKeys();
    assert.strictEqual(keys.length, 7,
        `verwacht 7 sleutels in NL_TRANSLATIONS, gevonden ${keys.length}: ${keys.join(', ')}`);

    for (const dict of DICTIONARIES) {
        const text = read(dict);
        for (const key of keys) {
            assert.ok(!text.includes(key),
                `sleutel ${key} staat weer in ${path.relative(path.join(__dirname, '..', '..'), dict)}. ` +
                `De migratie ${MIGRATION_NAME} is uitgezet omdat deze sleutels niet meer bestonden; ` +
                'bestaan ze weer, zet dan de aanroep in stores/knowledgeBases.js weer aan.');
        }
    }
});

test('b1. stores/knowledgeBases.js roept de migratie niet meer aan (geen actieve require().up())', () => {
    const src = read(KB_STORE_FILE);
    const comments = commentLines(src);
    const callPattern = new RegExp(
        String.raw`require\(\s*['"]\.\./migrations/${MIGRATION_NAME}['"]\s*\)\s*\.up\s*\(`);

    const activeCalls = src.split('\n')
        .map((line, i) => ({ line, no: i + 1 }))
        .filter(({ line, no }) => callPattern.test(line) && !comments.has(no));

    assert.deepStrictEqual(activeCalls.map(({ no }) => no), [],
        `stores/knowledgeBases.js roept ${MIGRATION_NAME} weer aan op regel(s) ` +
        `${activeCalls.map(({ no }) => no).join(', ')}. Die migratie zaait NL-waarden voor ` +
        'sleutels die in geen enkel woordenboek meer bestaan.');
});

test('b2. de naam staat er nog wél als comment in (houdt de orphan-guard van bootMigrations groen)', () => {
    const src = read(KB_STORE_FILE);
    const comments = commentLines(src);

    const mentions = src.split('\n')
        .map((line, i) => ({ line, no: i + 1 }))
        .filter(({ line }) => line.includes(MIGRATION_NAME));

    assert.ok(mentions.length > 0,
        `de naam ${MIGRATION_NAME} is helemaal uit stores/knowledgeBases.js verdwenen. ` +
        'boot/bootMigrations.test.js verklaart een migratie verantwoord zodra haar naam als ' +
        'substring in een runtime-bron voorkomt (comments tellen mee); zonder die vermelding ' +
        'wordt die orphan-guard rood.');
    assert.ok(mentions.every(({ no }) => comments.has(no)),
        `${MIGRATION_NAME} wordt in stores/knowledgeBases.js buiten commentaar genoemd op regel(s) ` +
        `${mentions.filter(({ no }) => !comments.has(no)).map(({ no }) => no).join(', ')}.`);
});

test('c. het migratiebestand staat er nog en exporteert nog up() (replay blijft mogelijk)', () => {
    assert.ok(fs.existsSync(MIGRATION_FILE),
        `${MIGRATION_NAME}.js is verwijderd. Een migratiebestand schrappen breekt replay van de ` +
        'migratiereeks; het hoort te blijven staan, alleen de aanroep is weg.');
    const mod = require(MIGRATION_FILE);
    assert.strictEqual(typeof mod.up, 'function', 'de migratie exporteert geen up()');
});
