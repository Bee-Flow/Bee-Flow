/**
 * The coverage direction for the Solutions overview: every key those screens
 * name has Dutch, and every Dutch value names a key that exists.
 *
 * Both directions are silent failures otherwise, and in opposite ways:
 *
 *   a key with no Dutch      renders English inside a Dutch workspace. `t()`
 *                            falls back, nothing throws, and the screen looks
 *                            finished to whoever wrote it in English.
 *   Dutch for a key nobody   is dead weight that also hides a typo: mis-spell
 *   has                      one here and the screen quietly stays English
 *                            while the catalogue looks complete.
 *
 * SCOPE, stated because a claim is never wider than its scan: this reads the
 * three files the overview is MADE of — the screen, the card, and the shared
 * counted-phrase module — and no further. It does not claim the whole
 * `solutions.*` namespace is translated, and it is not: the section names,
 * bands and Check-tab copy that O2 added have no Dutch catalogue at all, and
 * `sectionNames` can put those on a card. That gap belongs to the stage that
 * wrote them; naming it here is the point of saying what this test does cover.
 *
 * Run: node --test --test-force-exit migrations/add-nl-solution-overview-translations.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { NL_TRANSLATIONS } = require('./add-nl-solution-overview-translations');
const { GUI_DEFAULTS } = require('../i18n/defaults/en');

const MIGRATIONS_DIR = __dirname;
const HUB = path.join(__dirname, '..', '..', 'agent-hub', 'src', 'components');

/** The three files the overview is made of. */
const SCREEN_FILES = [
    path.join(HUB, 'admin', 'Studio', 'Solutions', 'SolutionsOverview.jsx'),
    path.join(HUB, 'admin', 'Studio', 'Solutions', 'SolutionCard.jsx'),
    path.join(HUB, 'admin', 'Studio', 'Solutions', 'solutionCounts.js'),
];

/**
 * Every `solutions.*` key those files name, plus the `_plural` half `nOf`
 * derives at run time for any of them that has one.
 *
 * The derived half is the one no regex over the source can find — it exists as
 * a literal nowhere — which is exactly why it is the half that goes missing.
 */
function keysTheScreensName() {
    const keys = new Set();
    for (const file of SCREEN_FILES) {
        assert.ok(fs.existsSync(file), `the scan points at a file that is not there: ${file}`);
        const src = fs.readFileSync(file, 'utf8');
        for (const m of src.matchAll(/'(solutions\.[A-Za-z0-9_.]+)'/g)) keys.add(m[1]);
    }
    for (const key of [...keys]) {
        if (Object.prototype.hasOwnProperty.call(GUI_DEFAULTS, `${key}_plural`)) keys.add(`${key}_plural`);
    }
    return keys;
}

/**
 * Every `solutions.*` key any Dutch catalogue seeds, mapped to its file.
 *
 * Read from the SOURCE rather than by requiring each module: a migration that
 * fails to load would otherwise look like a migration with no keys, and this
 * test would go green on an empty union.
 */
function dutchSolutionKeys() {
    const found = new Map();
    const files = fs.readdirSync(MIGRATIONS_DIR)
        .filter(f => /^add-nl-.*\.js$/.test(f) && !f.endsWith('.test.js'));
    assert.ok(files.length > 5, 'no add-nl-* catalogues found — the scan is looking in the wrong place');
    for (const f of files) {
        const src = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
        for (const m of src.matchAll(/^\s*'(solutions\.[A-Za-z0-9_.]+)':/gm)) {
            if (!found.has(m[1])) found.set(m[1], f);
        }
    }
    return found;
}

test('every key the overview names has Dutch in some catalogue', () => {
    const dutch = dutchSolutionKeys();
    const untranslated = [...keysTheScreensName()].filter(k => !dutch.has(k)).sort();
    assert.deepStrictEqual(untranslated, [],
        'these keys render English inside a Dutch workspace');
});

test('every key in this catalogue is a key that exists', () => {
    // A typo here is invisible: the Dutch value lands in the config, the screen
    // goes on rendering the English fallback, and the catalogue looks done.
    const orphans = Object.keys(NL_TRANSLATIONS)
        .filter(k => !Object.prototype.hasOwnProperty.call(GUI_DEFAULTS, k))
        .sort();
    assert.deepStrictEqual(orphans, [],
        'Dutch for keys that are in no English dictionary — a typo, or copy that was removed');
});

test('the scan really finds these screens — it is not reading an empty set', () => {
    // Guards the guard: a regex that stops matching, or a file that moved,
    // turns the test above into a test that passes over nothing.
    const named = keysTheScreensName();
    assert.ok(named.size > 25, `expected the overview to name plenty of keys, found ${named.size}`);
    assert.ok(named.has('solutions.card_health_unknown'), 'the card\'s "not checked" chip is not in the scan');
    assert.ok(named.has('solutions.card_runs_today_plural'), 'the derived plural half is not in the scan');
    assert.ok(named.has('solutions.tab_installed'), 'the tab strip is not in the scan');
});

test('the counted phrases are complete pairs', () => {
    // `nOf` reaches for `<key>_plural` at run time. A pair with only one half
    // renders a raw key the moment a count is not 1 — the one i18n bug that
    // shows up as machine text on a finished screen.
    const halves = Object.keys(GUI_DEFAULTS).filter(k => /^solutions\.install_count_/.test(k));
    const singles = halves.filter(k => !k.endsWith('_plural'));
    const missing = singles.filter(k => !halves.includes(`${k}_plural`));
    assert.deepStrictEqual(missing, [], 'counted phrases with no plural half');
    assert.ok(singles.length >= 7, `expected one phrase per countable kind, found ${singles.length}`);
});
