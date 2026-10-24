/**
 * Every path that stores an app definition brings `automation_usage` up to date —
 * COUNTED, not listed.
 *
 * `reconcileAutomationUsage` is delete-then-insert on (consumer_kind,
 * consumer_id). A write path that skips the reconcile does not simply add nothing:
 * it leaves the rows of the PREVIOUS definition in place. An action that loses its
 * automation keeps the capsule "Gebruikt door 1 knop" hanging in the air, and one that
 * gets one never shows up in it — and the screen where you would see that is
 * exactly the screen that leans on that index.
 *
 * ── WHY COUNT AND NOT LIST ──────────────────────────────────────────
 *
 * That is the lesson of W5, literally: there the reconcile lived in the routes,
 * one file was named, and SEVEN of the eight save paths in that file quietly kept
 * the rows of the previous version. A list that says "this file does it" says
 * nothing about the eight handlers in it.
 *
 * Here there are TEN, spread over four files:
 *   routes/studioApps/ (folder)              4 — create, save definition,
 *                                                template upgrade, restore version
 *   projects/packaging/install/parts/apps.js 1 — an app from a Solution (create)
 *   projects/packaging/install/patch.js      1 — and afterwards filled with its definition
 *   projects/packaging/upgrade.js            1 — an app that replaces an upgrade
 *   appStudio/builderTools/persistence.js    3 — the AI builder (create + save + retry)
 *
 * They all go through THREE store functions, and THAT is where the reconcile
 * hangs — not in the routes. That is the second half of the W5 lesson: as long as
 * the writers themselves re-index, a NEW caller cannot open a gap, at most it can
 * be undocumented. The strong test below is therefore mechanical: it searches the
 * store for EVERY place that writes `studio_apps.definition`, derives the enclosing
 * function, and requires that function to be exported through its re-indexing
 * wrapper. A fourth writer that ever gets added will then turn red, not silent.
 *
 * Run: cd server && node --test --test-reporter=tap appStudio/automationUsage.savePaths.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SERVER = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(SERVER, rel), 'utf8');

/** A file, or a folder of route parts: then every non-test .js file in it, together. */
const readSite = (rel) => {
    const full = path.join(SERVER, rel);
    if (fs.statSync(full).isFile()) return fs.readFileSync(full, 'utf8');
    return fs.readdirSync(full).filter((n) => n.endsWith('.js') && !n.includes('.test.')).sort()
        .map((n) => fs.readFileSync(path.join(full, n), 'utf8')).join('\n');
};

const STORE = 'stores/studioAppStore.js';
// De store is sinds de splitsing een barrel: de schrijvers en hun wrappers
// staan in stores/studioApp/. De scans hieronder lezen de barrel (de exports)
// en die map samen, als één bron.
const STORE_DIR = 'stores/studioApp';
const readStore = () => `${read(STORE)}\n${readSite(STORE_DIR)}`;

/**
 * The call sites that write an app definition, per file, with the minimum that
 * must be there. COUNTED: naming one file would leave seven of the ten paths free,
 * exactly as with the web pages.
 */
const DEFINITION_WRITE_SITES = [
    // aanmaken · definitie opslaan · sjabloon-upgrade · versie terugzetten
    // (routes/studioApps/: de router is per resourcegroep gesplitst; de map telt samen)
    { file: 'routes/studioApps', atLeast: 4 },
    // een app uit een Oplossing: aangemaakt, en daarna met haar definitie gevuld
    { file: 'projects/packaging/install/parts/apps.js', atLeast: 1 },
    { file: 'projects/packaging/install/patch.js', atLeast: 1 },
    // an app that is REPLACED by a Solution upgrade
    { file: 'projects/packaging/upgrade.js', atLeast: 1 },
    // de AI-bouwer: create, save, en de save-na-conflict
    { file: 'appStudio/builderTools/persistence.js', atLeast: 3 },
];

/** Een aanroep van een van de drie definitieschrijvers. */
const WRITE_CALL = /\b(createStudioApp|saveDefinition|restoreVersion)\s*\(/g;

test('tien aanroepplekken bewaren een app-definitie, verdeeld over vier bestanden', () => {
    let total = 0;
    for (const { file, atLeast } of DEFINITION_WRITE_SITES) {
        const found = (readSite(file).match(WRITE_CALL) || []).length;
        assert.ok(found >= atLeast,
            `${file}: ${found} aanroep(en) die een definitie bewaren, verwacht minstens ${atLeast} — `
            + 'is er een save-pad verdwenen, of heet de storefunctie anders?');
        total += found;
    }
    assert.ok(total >= 10, `samen ${total} aanroepplekken, verwacht minstens 10`);
});

// ── de mechanische helft: welke storefuncties schrijven de definitie? ──

/**
 * Every place in the store that writes `studio_apps.definition`, with the
 * enclosing function name.
 *
 * Three forms, because there are three ways to touch that column:
 *   INSERT INTO studio_apps (… definition …)
 *   SET definition = $n::jsonb
 *   sets.push(`definition = …`)      — the dynamic SET builders
 * `published_definition` does not match here (`\\b` does not catch after an underscore).
 * That column is a COPY and has its own writer — `setStudioAppPublished` —
 * which since the P4 closing round ALSO re-indexes, because the reconciler builds the
 * UNION of draft and published: visitors run the published copy. See the
 * separate test further on.
 */
function definitionWritersIn(src) {
    const fnAt = [...src.matchAll(/async function (\w+)\s*\(/g)].map(m => ({ at: m.index, name: m[1] }));
    const enclosing = (at) => {
        let best = null;
        for (const f of fnAt) { if (f.at < at) best = f.name; else break; }
        return best;
    };

    const out = new Map();   // functienaam → [de statements die het bewijzen]
    const note = (at, what) => {
        const fn = enclosing(at);
        if (!fn) return;
        if (!out.has(fn)) out.set(fn, []);
        out.get(fn).push(what);
    };

    for (const m of src.matchAll(/INSERT INTO studio_apps\s*\(([^)]*)\)/g)) {
        if (/\bdefinition\b/.test(m[1])) note(m.index, 'INSERT');
    }
    for (const m of src.matchAll(/\bdefinition\s*=\s*\$\d+::jsonb/g)) note(m.index, 'SET');
    for (const m of src.matchAll(/sets\.push\(\s*`\s*definition\s*=/g)) note(m.index, 'dynamic SET');
    return out;
}

/**
 * The body of one function, from its `async function <name>(` to the next
 * function header. Crude but sufficient: the wrappers are all a few lines, and
 * the alternative (counting brackets) would only be able to break more here.
 */
function bodyOf(src, name) {
    const start = src.search(new RegExp(`async function ${name}\\s*\\(`));
    if (start === -1) return null;
    const rest = src.slice(start + 1);
    const next = rest.search(/\nasync function \w+\s*\(|\nmodule\.exports/);
    return next === -1 ? rest : rest.slice(0, next);
}

test('elke storefunctie die de definitie schrijft, wordt via haar herindexerende wrapper geexporteerd', () => {
    const src = readStore();
    const writers = definitionWritersIn(src);

    // The premise itself: if this scan finds nothing anymore, it is broken — and a
    // broken scan does not fail, it stays silent.
    assert.ok(writers.size >= 3,
        `de scan vond ${writers.size} definitieschrijver(s) in ${STORE}; verwacht minstens 3 `
        + '(createStudioApp, saveDefinition, restoreVersion)');

    // Deliberately source text, as the file header says: this is the mechanical
    // half that walks EVERY write place in the store, including one that no test
    // drives. The BEHAVIOUR behind it (does the wrapper really call the
    // reconciler?) is tested behaviourally in
    // stores/studioAppStore.test.js — guarded by the last test below.
    for (const [fn, proofs] of writers) {
        assert.match(src, new RegExp(`\\b${fn}:\\s*${fn}Indexed\\b`),
            `${STORE}: ${fn} schrijft studio_apps.definition (${proofs.join(', ')}) maar wordt niet als `
            + `\`${fn}: ${fn}Indexed\` geexporteerd — zonder wrapper houdt elk pad langs hem de rijen van de vorige versie`);
        assert.match(src, new RegExp(`async function ${fn}Indexed\\b`),
            `${STORE}: de wrapper ${fn}Indexed bestaat niet`);
    }

    // And EVERY wrapper really calls the reconciler too.
    //
    // This used to be one `assert.match` over the whole file, and that is
    // exactly one call too few to prove anything: with only the call in
    // `createStudioAppIndexed` the check stayed green while you could remove it from
    // `saveDefinitionIndexed` — the path that EVERY autosave of EVERY app takes.
    // Now per wrapper, on its own body.
    for (const fn of writers.keys()) {
        const body = bodyOf(src, `${fn}Indexed`);
        assert.ok(body, `${STORE}: de body van ${fn}Indexed is niet te vinden`);
        assert.match(body, /reindexAutomationUsage\(|reconcileAppAutomationUsageDetached\(/,
            `${STORE}: ${fn}Indexed herindexeert niet — zonder die aanroep blijven de rijen van de VORIGE `
            + 'definitie staan (de reconcile is delete-then-insert), en houdt een actie die haar automatisering '
            + 'kwijtraakt de capsule voor altijd in de lucht');
    }
    // The reconciler is called through one helper, not ten times separately.
    assert.match(src, /reconcileAppAutomationUsageDetached\(/,
        `${STORE}: de wrappers horen de automation-usage-reconciler aan te roepen`);
});

/**
 * The PUBLISHED definition is the fifth writer, and the index counts it.
 *
 * The reconciler builds the union of draft and published, because the question
 * the capsule answers ("who breaks if I throw this away") is about production,
 * and visitors run the published copy. Without a wrapper on
 * `setStudioAppPublished`, publishing and unpublishing do not change the index.
 */
test('de publish-schrijver gaat ook door een herindexerende wrapper', () => {
    // Bewust brontekst, zelfde reden als hierboven.
    const src = readStore();
    assert.match(src, /published_definition/, 'de scan is stuk als deze kolom niet meer bestaat');
    assert.match(src, /\bsetStudioAppPublished:\s*setStudioAppPublishedIndexed\b/,
        `${STORE}: setStudioAppPublished hoort als zijn herindexerende wrapper geexporteerd te worden`);
    const body = bodyOf(src, 'setStudioAppPublishedIndexed');
    assert.ok(body, `${STORE}: setStudioAppPublishedIndexed bestaat niet`);
    assert.match(body, /reindexAutomationUsage\(/,
        `${STORE}: setStudioAppPublishedIndexed herindexeert niet — dan blijft de index de draft-stand houden `
        + 'terwijl de LIVE app een andere definitie draait');
});

/**
 * And the BEHAVIOUR behind it — because everything above reads source files.
 *
 * The real calls are in stores/studioAppStore.test.js, with the in-memory Postgres
 * stand-in and the reconciler replaced by a counter. That is the test that turns red
 * if a wrapper exists but does nothing; this line makes sure it cannot quietly
 * disappear.
 */
test('de gedragstesten van de wrappers bestaan', () => {
    const behaviour = read('stores/studioAppStore.test.js');
    for (const fn of ['saveDefinition', 'createStudioApp', 'restoreVersion', 'setStudioAppPublished', 'deleteStudioApp']) {
        assert.match(behaviour, new RegExp(`store\\.${fn}\\(`),
            `stores/studioAppStore.test.js: er is geen echte aanroep van ${fn} die bewijst dat de wrapper herindexeert`);
    }
    assert.match(behaviour, /withReindexSpy/,
        'stores/studioAppStore.test.js: de teller die de reconciles opvangt is verdwenen');
});

test('beide kanten van de ontbrekende FK worden opgeruimd', () => {
    // There is no FK to `studio_apps` and none to `automations`, so neither deletion
    // cleans up after itself. If a row stays, it claims on behalf of a button or an
    // automation that no longer exists.
    // Deliberately source text, same reason as above — two files, neither of them a
    // test that already drives this behaviour.
    assert.match(readStore(), /purgeAppAutomationUsage\(/,
        `${STORE}: een verwijderde app hoort haar rijen mee te nemen`);
    assert.match(readStore(), /async function deleteStudioAppIndexed\b/,
        `${STORE}: de delete hoort door haar opruimende wrapper te gaan`);
    assert.match(read(STORE), /\bdeleteStudioApp:\s*deleteStudioAppIndexed\b/,
        `${STORE}: en die wrapper hoort de geexporteerde te zijn`);
    // Handoff 5: DELETE moves an automation into the trash; the final delete, and
    // this cleanup with it, is the trash purge.
    assert.match(read('jobs/automationTrashPurge.js'), /purgeUsageOfAutomation\(/,
        'jobs/automationTrashPurge.js: a purged automation takes its rows with it');
});

/** Elke .js-bron onder server/, minus dependencies, tests en vendored code. */
function* sources(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (['node_modules', '.git', 'vendor', 'dist', 'coverage'].includes(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { yield* sources(full); continue; }
        if (!entry.name.endsWith('.js') || /\.test\.js$/.test(entry.name)) continue;
        yield full;
    }
}

/**
 * The other direction, and the reason the list above can be trusted: whoever
 * CALLS the reconciler must be listed here. A second caller that ever gets added is
 * not an error — it is only undocumented, and then someone has to check whether its
 * neighbours do the same. Exactly as with the web pages.
 */
const RECONCILER_CALLERS = [
    // De backstop. De enige plek waar "de app is veranderd" en "de index is
    // achterhaald" hetzelfde feit zijn. Sinds de splitsing van de store staan
    // de wrappers in stores/studioApp/writers.js.
    'stores/studioApp/writers.js',
];
const AUTOMATION_PURGE_CALLERS = [
    'jobs/automationTrashPurge.js',   // an automation leaves the trash for good (handoff 5)
];

test('niets anders roept de app-reconciler aan zonder hier te staan', () => {
    const self = ['appStudio/automationUsageSync.js'];   // de definitie, geen aanroeper
    for (const file of sources(SERVER)) {
        const rel = path.relative(SERVER, file).split(path.sep).join('/');
        if (self.includes(rel)) continue;
        const src = fs.readFileSync(file, 'utf8');
        if (/reconcileAppAutomationUsageDetached\(|purgeAppAutomationUsage\(/.test(src)) {
            assert.ok(RECONCILER_CALLERS.includes(rel),
                `${rel} houdt automation_usage bij maar staat niet in RECONCILER_CALLERS — `
                + 'zet hem erbij, en controleer of zijn buren hetzelfde doen');
        }
    }
});

test('niets anders ruimt de automation-kant op zonder hier te staan', () => {
    const self = ['stores/automationUsageStore.js'];     // de definitie, geen aanroeper
    for (const file of sources(SERVER)) {
        const rel = path.relative(SERVER, file).split(path.sep).join('/');
        if (self.includes(rel)) continue;
        if (!/purgeUsageOfAutomation\(/.test(fs.readFileSync(file, 'utf8'))) continue;
        assert.ok(AUTOMATION_PURGE_CALLERS.includes(rel),
            `${rel} ruimt automation_usage op maar staat niet in AUTOMATION_PURGE_CALLERS`);
    }
});
