/**
 * Every path that saves a CONSUMER of a datatable has to reconcile the
 * dependents index — listed here, per consumer kind.
 *
 * reconcileUsageFor is delete-then-insert keyed on (consumer_kind, id), so a
 * save path that skips it does not merely fail to add rows: it leaves the
 * PREVIOUS definition's rows standing, and three surfaces read that index
 * (the used-by panel, the "also used by N others" hint, and the guard that
 * refuses a column drop). For automations that lesson was learned the hard way —
 * see the datatableUsageSync.js header. For apps and webpages it is written
 * down here BEFORE their reconcilers land, so the tracks that add them
 * (App Studio: the `app` kind; Webpages: the `webpage` kind) extend this list
 * rather than discover the rule.
 *
 * Two guards:
 *   1. every kind in datatableStore.CONSUMER_KINDS has an entry, and every
 *      file an entry names really calls the reconciler;
 *   2. a kind that is WIRED anywhere in the server (some file calls
 *      syncUsageFor / reconcileUsageFor with that kind) must list that file —
 *      a reconciler added on one save path and forgotten on the other three
 *      is exactly the failure this file exists to catch.
 *
 * Run: cd server && node --test --test-force-exit automation/usageSync.savePaths.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SERVER = path.resolve(__dirname, '..');
// Een module mag een MAP zijn (`dir/foo.js` → `dir/foo/index.js` met zusters
// ernaast). Dat is nog steeds één module, dus lees hem als één tekst: anders
// zou een opgesplitst save-pad hier stilletjes gelden als "doet de aanroep
// niet", precies de storing die dit bestand moet vangen.
const read = (rel) => {
    const p = path.join(SERVER, rel);
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
        return fs.readdirSync(p)
            .filter(f => f.endsWith('.js') && !f.endsWith('.test.js'))
            .map(f => fs.readFileSync(path.join(p, f), 'utf8'))
            .join('\n');
    }
    // Of een FACADE: `dir/foo.js` blijft een bestand (een store MOET dat
    // blijven, migrateDb registreert hem op pad) met zijn onderdelen in
    // `dir/foo/`. Dat is nog steeds één module, dus lees de map erbij —
    // anders zou een opgesplitste store hier stilletjes gelden als "noemt
    // die soort niet".
    const parts = p.replace(/\.js$/, '');
    const facade = fs.readFileSync(p, 'utf8');
    if (!fs.existsSync(parts) || !fs.statSync(parts).isDirectory()) return facade;
    return [facade, ...fs.readdirSync(parts)
        .filter(f => f.endsWith('.js') && !f.endsWith('.test.js'))
        .map(f => fs.readFileSync(path.join(parts, f), 'utf8'))].join('\n');
};

// The kinds, read from the store's own list — not restated here, so a kind
// added there without an entry below fails the first guard.
const STORE_SRC = read('stores/datatableStore.js');
const CONSUMER_KINDS = JSON.parse(
    STORE_SRC.match(/const CONSUMER_KINDS = Object\.freeze\((\[[^\]]*\])\)/)[1].replace(/'/g, '"'),
);

/**
 * Per kind: the files that persist a definition of that consumer (`sync`) and
 * the files that delete one (`purge`), each with the call the file must make.
 * An empty list is allowed ONLY while nothing in the server wires that kind.
 */
const SAVE_PATHS = {
    automation: {
        sync: {
            call: /syncDatatableUsage\(/,
            files: [
                'routes/automation/crud.js',              // create, import, update
                'routes/automation/versions.js',          // restore a version
                'routes/automation/actions.js',           // duplicate (handoff 5)
                'routes/step.js',                         // reusable Steps
                'automation/builderTools/persistence.js', // the MCP builder
                'automation/goLive.js',                   // a deploy's converge (convergeAfterPublish)
            ],
        },
        purge: {
            call: /purgeDatatableUsage\(/,
            // Handoff 5: an automation is purged from the trash, not by DELETE.
            files: ['jobs/automationTrashPurge.js', 'routes/step.js'],
        },
    },
    // App Studio table bindings (`model.tables[].source.kind === 'datatable'`).
    // Filled in by the track that lands the reconciler on the app save paths.
    app: {
        sync: { call: /syncUsageFor\(\s*'app'/, files: [] },
        purge: { call: /purgeUsageFor\(\s*'app'/, files: [] },
    },
    /**
     * A webpage that reaches a datatable (W5).
     *
     * Two ways, and the index is the UNION of both: the `bf-table` / `bf-stat`
     * elements the page's own files carry, and the `bridge_grants.tables`
     * bindings that are the gate `window.beeflowTables` runs through. Its
     * reconciler is `core/webpages/webpageUsageSync.reconcileWebpageUsage`,
     * which reads BOTH and hands over every table the page still reaches — so
     * adding one and removing one are both syncs, and the only true purge is
     * deleting the whole page.
     *
     * Listed here are the paths that persist a page's CODE or its bindings.
     * `POST /:id/assets` is deliberately absent: it stores binaries
     * (`is_text=false`) and readPageCode never reads those, so it cannot change
     * what the page binds.
     *
     * `stores/webpageStore.js` is the BACKSTOP and the reason the list below
     * can be trusted: the reconcile hangs off the four store functions that
     * really change a page's code, so a save path that never heard of this file
     * is still covered. The routes stay listed because a reader looking for
     * "where does a page get saved" must find them, and because the fourth test
     * below pins that the backstop itself is wired.
     */
    webpage: {
        sync: {
            call: /reconcileWebpageUsage/,
            files: [
                'stores/webpageStore.js',        // the backstop: writeSlot / extra files / restore
                'routes/webpages',               // create, update, files, move, clone, restore, publish
                'routes/ai/webpageChat.js',      // the AI arm — slots AND extra files
                'routes/webpagesAudience.js',    // the only writer of bridge_grants.tables
                'projects/packaging/install.js', // a page installed from a Solution
                'projects/packaging/upgrade.js', // a page REPLACED by a Solution upgrade
                'modules/hostApi.js',            // a page a module publishes
            ],
        },
        purge: { call: /purgeWebpageUsage\(/, files: ['routes/webpages'] },
    },
    /**
     * A knowledge base with a `datatable` source (K8).
     *
     * The consumer is the KNOWLEDGE BASE, not the source: that is what a
     * person opens from the table's used-by tab and what they are warned about
     * before deleting the table. The source id rides in `step_id`.
     *
     * Its reconciler is `core/kb/sources/datatable.reconcileUsage`, which
     * lists the base's remaining datatable sources and hands them all over —
     * so adding a source and REMOVING one are both syncs, and the only true
     * purge is deleting the whole knowledge base.
     */
    kb: {
        sync: { call: /reconcileUsage\(/, files: ['routes/knowledgeBases/sources.js'] },
        purge: { call: /purgeUsageFor\(\s*'kb'/, files: ['routes/knowledgeBases/detail.js'] },
    },
};

test('every consumer kind the store knows has a save-path entry', () => {
    assert.ok(CONSUMER_KINDS.length >= 3, 'the store\'s list was not found');
    for (const kind of CONSUMER_KINDS) {
        assert.ok(SAVE_PATHS[kind], `consumer kind "${kind}" has no save-path entry here`);
    }
    for (const kind of Object.keys(SAVE_PATHS)) {
        assert.ok(CONSUMER_KINDS.includes(kind), `"${kind}" is listed here but is not a consumer kind the store accepts`);
    }
});

test('every listed file really makes the call', () => {
    for (const [kind, { sync, purge }] of Object.entries(SAVE_PATHS)) {
        for (const f of sync.files) assert.match(read(f), sync.call, `${f} must reconcile ${kind} usage`);
        for (const f of purge.files) assert.match(read(f), purge.call, `${f} must purge ${kind} usage`);
    }
    // create AND import AND update, in the one file that owns all three.
    assert.ok((read('routes/automation/crud.js').match(/syncDatatableUsage\(/g) || []).length >= 3,
        'create, import and update each persist an automation definition');
    // EIGHT webpage save paths live in ONE module (routes/webpages/, gesplitst
    // per bronnengroep): create, update, put an extra file, delete one, move
    // one, clone, restore a version, publish. Listing the module once would let
    // seven of them silently leave the previous version's rows standing, so the
    // count is pinned — a path that loses its call fails here rather than in a
    // used-by list nobody reads.
    assert.ok((read('routes/webpages').match(/reconcileWebpageUsageDetached\(/g) || []).length >= 8,
        'every webpage save path in routes/webpages/ reconciles the index');
});

/**
 * The guard above only bites one way: it asks whether a file that ALREADY
 * reconciles is listed. A save path that never calls the reconciler at all is
 * invisible to it — which is exactly how the Solution UPGRADE path, the
 * ordinary assistant chat, the tool dispatcher and the automation-builder chat
 * each rewrote a page's html/js slot with nothing keeping the index in step.
 *
 * So this is the other direction, for webpages: the store's four code-changing
 * writers must carry the reconcile themselves. As long as they do, a new
 * caller cannot open a new hole — it can only fail to be documented.
 */
test('the webpage store reconciles from its own writers, so a new caller cannot open a hole', () => {
    const src = read('stores/webpageStore.js');
    for (const fn of ['writeSlot', 'upsertExtraFile', 'deleteExtraFile', 'restoreSlotFromVersion']) {
        assert.match(src, new RegExp(`${fn}:\\s*${fn}Indexed`),
            `webpageStore.${fn} must be exported through its reindexing wrapper`);
    }
    assert.match(src, /reconcileWebpageUsageDetached\(/,
        'the wrappers must call the webpage usage reconciler');
    // A binary asset cannot change what the page BINDS (readPageCode skips
    // is_text=false), so it deliberately stays unwrapped — pinned so that
    // "wrap them all" does not creep in as a needless scan per upload.
    assert.match(src, /upsertBinaryExtraFile,/,
        'upsertBinaryExtraFile stays unwrapped — binaries cannot change a binding');
});

/** Every .js source under server/, minus dependencies, tests and vendored code. */
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
 * Een module die hierboven als MAP is opgeschreven (`routes/webpages`) dekt al
 * haar zusterbestanden: wie `routes/webpages/crud.js` vindt, heeft de module
 * gevonden die de lijst noemt. Alleen naar een map die voor DEZE soort ook
 * echt als module in de lijst staat, zodat een nieuw bestand in een map die
 * niemand noemt gewoon blijft opvallen.
 */
function moduleOf(kind, rel) {
    const listed = new Set([...SAVE_PATHS[kind].sync.files, ...SAVE_PATHS[kind].purge.files]);
    const dir = rel.replace(/\/[^/]+$/, '');
    return listed.has(dir) ? dir : rel;
}

test('a kind that is wired anywhere lists that file — no half-covered consumer', () => {
    const wired = new Map(Object.keys(SAVE_PATHS).map(k => [k, new Set()]));
    for (const file of sources(SERVER)) {
        const rel = path.relative(SERVER, file).split(path.sep).join('/');
        // The modules that DEFINE an entry point are not callers of it.
        // `core/kb/sources/datatable.js` is the knowledge-base reconciler
        // itself, the same category as datatableUsageSync for automations.
        if (rel === 'automation/datatableUsageSync.js'
            // De store is een facade met zijn onderdelen in
            // stores/datatableStore/ — dezelfde module, dezelfde vrijstelling.
            || rel === 'stores/datatableStore.js'
            || rel.startsWith('stores/datatableStore/')
            || rel === 'core/kb/sources/datatable.js'
            // The webpage reconciler itself, same category: it DEFINES
            // reconcileWebpageUsage / purgeWebpageUsage, it does not call them
            // from a save path.
            || rel === 'core/webpages/webpageUsageSync.js') continue;
        const src = fs.readFileSync(file, 'utf8');
        for (const [kind, { sync, purge }] of Object.entries(SAVE_PATHS)) {
            if (sync.call.test(src) || purge.call.test(src)) wired.get(kind).add(moduleOf(kind, rel));
        }
    }
    for (const [kind, files] of wired) {
        const listed = new Set([...SAVE_PATHS[kind].sync.files, ...SAVE_PATHS[kind].purge.files]);
        for (const f of files) {
            assert.ok(listed.has(f),
                `${f} reconciles "${kind}" usage but is not in SAVE_PATHS.${kind} — list it, and check the sibling save paths do the same`);
        }
    }
});

// ── the same rule for KNOWLEDGE-BASE sources ────────────────────────────
//
// `core/kb/kbSourceSync.syncKbSources` is the same shape of reconcile: a
// definition in, the `automation` sources of the bases it writes to brought in
// step. So it has the same failure mode, and it is sharper here — a stale
// source does not just fail to appear in a list, it CLAIMS a knowledge base is
// being fed by an automation that stopped writing to it. Somebody reads that list
// to decide whether the base is current.
//
// Deliberately the SAME file list as the datatable sync: both reconcile from a
// definition, so any path that persists one and skips either is wrong.
const KB_SOURCE_SAVE_PATHS = [
    'routes/automation/crud.js',              // create, import, update
    'routes/automation/versions.js',          // restore a version
    'routes/automation/actions.js',           // duplicate (handoff 5)
    'routes/step.js',                         // reusable Steps
    'automation/builderTools/persistence.js', // the MCP builder
    'automation/goLive.js',                   // a deploy's converge (convergeAfterPublish)
    // Provisions the resolved-tickets→KB automation from the Support settings
    // panel, straight through the store — and it is the one automation whose
    // whole purpose is to write to a knowledge base.
    'routes/supportInbox.js',
];

test('every automation save path also reconciles its knowledge-base sources', () => {
    for (const f of KB_SOURCE_SAVE_PATHS) {
        assert.match(read(f), /syncKbSources\(/, `${f} must reconcile the automation's knowledge-base sources`);
    }
    assert.ok((read('routes/automation/crud.js').match(/syncKbSources\(/g) || []).length >= 3,
        'create, import and update each persist an automation definition');
});

test('nothing else calls syncKbSources without being listed', () => {
    for (const file of sources(SERVER)) {
        const rel = path.relative(SERVER, file).split(path.sep).join('/');
        if (rel === 'core/kb/kbSourceSync.js') continue; // the definition, not a caller
        if (!/syncKbSources\(/.test(fs.readFileSync(file, 'utf8'))) continue;
        assert.ok(KB_SOURCE_SAVE_PATHS.includes(rel),
            `${rel} reconciles knowledge-base sources but is not listed — check the sibling save paths do the same`);
    }
});
