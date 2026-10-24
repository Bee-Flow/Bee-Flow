/**
 * Guard on the SWITCHED-OFF migration `add-nl-kb-usage-translations` (Track Z).
 *
 * The migration seeded NL values for seven `kb_detail.usage_*` keys. Those keys exist in NEITHER
 * English dictionary any more, so the migration wrote DB rows at every boot for keys that are
 * requested nowhere: harmless, but dead. The only caller
 * (stores/kb/schema.js, formerly stores/knowledgeBases.js) has therefore been switched off; the migration
 * file deliberately stays on disk so that replay of the migration sequence remains possible.
 *
 * This test is static (reads files as TEXT, touches no DB) and proves the three facts on which that
 * decision rests:
 *   a. none of the seven keys still occurs in a dictionary — should one ever return, this test turns
 *      red and that is the signal to switch the call in stores/kb/schema.js back on;
 *   b. stores/kb/schema.js no longer calls the migration, but still names its name in a comment (that keeps
 *      the orphan guard in boot/bootMigrations.test.js green);
 *   c. the migration file still exists and still exports `up()`.
 *
 * Run: node --test --test-reporter=tap migrations/add-nl-kb-usage-translations.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const MIGRATION_NAME = 'add-nl-kb-usage-translations';
const MIGRATION_FILE = path.join(__dirname, `${MIGRATION_NAME}.js`);
const KB_STORE_FILE = path.join(__dirname, '..', 'stores', 'kb', 'schema.js');

// The English dictionaries. READ ONLY — this test never writes to them.
// The server side is one file per namespace under i18n/defaults/en/;
// the frontend copy is generated from that (scripts/gen-i18n-defaults.mjs).
const SERVER_DICT_DIR = path.join(__dirname, '..', 'i18n', 'defaults', 'en');
const DICTIONARIES = [
    ...fs.readdirSync(SERVER_DICT_DIR)
        .filter((f) => f.endsWith('.js') && f !== 'index.js')
        .map((f) => path.join(SERVER_DICT_DIR, f)),
    path.join(__dirname, '..', '..', 'agent-hub', 'src', 'i18n', 'en-defaults.js'),
];

const read = (p) => fs.readFileSync(p, 'utf8');

/**
 * Read the keys from the NL_TRANSLATIONS block of the migration itself, rather than
 * retyping them a second time: if the migration changes its content, this guard moves
 * along instead of guarding an outdated copy.
 */
function migrationKeys() {
    const src = read(MIGRATION_FILE);
    const block = src.match(/const NL_TRANSLATIONS\s*=\s*\{([\s\S]*?)\n\};/);
    assert.ok(block, 'NL_TRANSLATIONS-blok niet gevonden in de migratie');
    return [...block[1].matchAll(/^\s*'([^']+)'\s*:/gm)].map((m) => m[1]);
}

/**
 * Line numbers (1-based) of all lines that are comments: a `//` line,
 * or a line within a `/* ... *\/` block. Line-based and therefore deterministic;
 * a JS parser is not needed here, because the only question is whether the calling line is
 * code or comment.
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
                'bestaan ze weer, zet dan de aanroep in stores/kb/schema.js weer aan.');
        }
    }
});

test('b1. stores/kb/schema.js roept de migratie niet meer aan (geen actieve require().up())', () => {
    const src = read(KB_STORE_FILE);
    const comments = commentLines(src);
    const callPattern = new RegExp(
        String.raw`require\(\s*['"](?:\.\./)+migrations/${MIGRATION_NAME}['"]\s*\)\s*\.up\s*\(`);

    const activeCalls = src.split('\n')
        .map((line, i) => ({ line, no: i + 1 }))
        .filter(({ line, no }) => callPattern.test(line) && !comments.has(no));

    assert.deepStrictEqual(activeCalls.map(({ no }) => no), [],
        `stores/kb/schema.js roept ${MIGRATION_NAME} weer aan op regel(s) ` +
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
        `de naam ${MIGRATION_NAME} is helemaal uit stores/kb/schema.js verdwenen. ` +
        'boot/bootMigrations.test.js verklaart een migratie verantwoord zodra haar naam als ' +
        'substring in een runtime-bron voorkomt (comments tellen mee); zonder die vermelding ' +
        'wordt die orphan-guard rood.');
    assert.ok(mentions.every(({ no }) => comments.has(no)),
        `${MIGRATION_NAME} wordt in stores/kb/schema.js buiten commentaar genoemd op regel(s) ` +
        `${mentions.filter(({ no }) => !comments.has(no)).map(({ no }) => no).join(', ')}.`);
});

test('c. het migratiebestand staat er nog en exporteert nog up() (replay blijft mogelijk)', () => {
    assert.ok(fs.existsSync(MIGRATION_FILE),
        `${MIGRATION_NAME}.js is verwijderd. Een migratiebestand schrappen breekt replay van de ` +
        'migratiereeks; het hoort te blijven staan, alleen de aanroep is weg.');
    const mod = require(MIGRATION_FILE);
    assert.strictEqual(typeof mod.up, 'function', 'de migratie exporteert geen up()');
});
