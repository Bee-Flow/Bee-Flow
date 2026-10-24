/**
 * The writer of `automation_usage` for a STUDIO APP (P4 part C).
 *
 * What is fixed here is not "it writes rows", but the three ways in which a
 * reconciler on a shared index silently goes wrong — the same three as for W5,
 * because it is the same shape:
 *
 *   1. WIPING ON A FAILED SCAN. `reconcileAutomationUsage` is delete-then-insert: an
 *      empty list is not "nothing found" but an instruction to throw everything away.
 *      If the app row or its definition cannot be read, then NOTHING may be written —
 *      otherwise the capsule would read "is used nowhere" after one glitch, and that is
 *      exactly the sentence on which someone deletes an automation that switches on a
 *      button in production.
 *   2. A KEY THAT MOVES ALONG. `ref_id` is half the primary key. A sequence step has no
 *      id, so its POSITION would be the only other key — and a position shifts as soon
 *      as someone puts a step above it. The ACTION is the key.
 *   3. A DELETED APP THAT LEAVES ROWS BEHIND. There is no FK to `studio_apps`, so only
 *      an explicit purge cleans them up — and a pass that no longer finds the app must
 *      not write anyway, even if it was already reading when the purge came by.
 *
 * Plus the reason why the index is broader than "what you can press": an action that
 * hangs off an automation but off no button at all DOES count, with `wired:false`. One
 * row too many makes a deletion louder, one row too few makes it silent.
 *
 * Run: cd server && node --test --test-reporter=tap appStudio/automationUsageSync.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const refs = require('./automationRefs');
const sync = require('./automationUsageSync');
const { collectReferencedActions } = require('./validate/nodes');

const APP = 'app_1';
const OWNER = 'u_owner';
const RID = 'auto_1';

// ── gereedschap ───────────────────────────────────────────────────────

function silentLog() {
    const lines = { warn: [], log: [] };
    return { warn: (m) => lines.warn.push(String(m)), log: (m) => lines.log.push(String(m)), lines };
}

/** An app store that knows one row. `row: null` = the app does not exist. */
function appStore(row) {
    return { getStudioApp: async () => (typeof row === 'function' ? row() : row) };
}

/** Een indexstore die noteert wat er gebeurde. */
function fakeStore({ written = null } = {}) {
    const calls = { reconcile: [], purge: [] };
    return {
        calls,
        reconcileAutomationUsage: async (kind, id, owner, entries) => {
            calls.reconcile.push({ kind, id, owner, entries });
            return typeof written === 'number' ? written : entries.length;
        },
        purgeUsageForConsumer: async (kind, id) => { calls.purge.push({ kind, id }); return 1; },
    };
}

/** Een minimale, CANONIEKE definitie: screens is er altijd. */
function def({ actions = {}, screens = [] } = {}) {
    return { schemaVersion: 3, screens, actions };
}

/** Eén scherm met één knop die `actionId` aanzet. */
function screenWithButton(actionId, { screenId = 'scr_home', nodeId = 'cmp_btn', label = 'Send invoice' } = {}) {
    return {
        id: screenId,
        sections: [{ id: 'sec_1', children: [{ id: nodeId, type: 'button', props: { label }, onClick: actionId }] }],
    };
}

// ── de pure verzamelaar ───────────────────────────────────────────────

test('een v1 run_automation-actie levert één rij, met de knop erbij', () => {
    const d = def({
        actions: { act_aaaa: { kind: 'run_automation', automationId: RID } },
        screens: [screenWithButton('act_aaaa')],
    });
    const { entries, unset } = refs.collectAutomationRefs(d);
    assert.strictEqual(unset, 0);
    assert.deepStrictEqual(entries, [{
        automationId: RID, refId: 'act:act_aaaa', actionId: 'act_aaaa',
        screenId: 'scr_home', nodeId: 'cmp_btn', label: 'Send invoice', wired: true,
    }]);
});

test('een run_automation DIEP in een sequence telt mee — steps, then, else en cases', () => {
    const d = def({
        actions: {
            act_seq: {
                kind: 'sequence',
                steps: [
                    { kind: 'condition', then: [{ kind: 'run_automation', automationId: 'auto_then' }],
                        else: [{ kind: 'loop', steps: [{ kind: 'run_automation', automationId: 'auto_loop' }] }] },
                    { kind: 'switch', cases: [{ value: 'x', steps: [{ kind: 'run_automation', automationId: 'auto_case' }] }] },
                ],
            },
        },
        screens: [screenWithButton('act_seq')],
    });
    const ids = refs.collectAutomationRefs(d).entries.map(e => e.automationId).sort();
    assert.deepStrictEqual(ids, ['auto_case', 'auto_loop', 'auto_then']);
});

test('dezelfde automation twee keer in één actie is ÉÉN rij; twee automatiseringen zijn er twee', () => {
    const d = def({
        actions: {
            act_seq: {
                kind: 'sequence',
                steps: [
                    { kind: 'run_automation', automationId: 'auto_a' },
                    { kind: 'run_automation', automationId: 'auto_a' },
                    { kind: 'run_automation', automationId: 'auto_b' },
                ],
            },
        },
        screens: [screenWithButton('act_seq')],
    });
    const rows = refs.collectAutomationRefs(d).entries;
    assert.strictEqual(rows.length, 2);
    // Regel 2: dezelfde actie, dus dezelfde ref — de automatisering maakt het verschil.
    assert.deepStrictEqual(rows.map(r => r.refId), ['act:act_seq', 'act:act_seq']);
    assert.deepStrictEqual(rows.map(r => r.automationId), ['auto_a', 'auto_b']);
});

test('regel 2: de sleutel schuift NIET op als er een stap boven wordt gezet', () => {
    const before = def({
        actions: { act_seq: { kind: 'sequence', steps: [{ kind: 'run_automation', automationId: RID }] } },
        screens: [screenWithButton('act_seq')],
    });
    const after = def({
        actions: {
            act_seq: {
                kind: 'sequence',
                steps: [{ kind: 'toast', message: 'hoi' }, { kind: 'toast', message: 'nog een' },
                    { kind: 'run_automation', automationId: RID }],
            },
        },
        screens: [screenWithButton('act_seq')],
    });
    assert.strictEqual(
        refs.collectAutomationRefs(before).entries[0].refId,
        refs.collectAutomationRefs(after).entries[0].refId,
        'een positie als sleutel zou hier twee verschillende rijen opleveren',
    );
});

test('een actie zonder knop telt mee, maar zegt dat ze onbedraad is', () => {
    const d = def({ actions: { act_los: { kind: 'run_automation', automationId: RID } }, screens: [] });
    const [row] = refs.collectAutomationRefs(d).entries;
    assert.strictEqual(row.wired, false);
    assert.strictEqual(row.label, null);
    assert.strictEqual(row.nodeId, null);
});

test('een run_automation zonder gekozen automatisering is geen gebruik, maar wordt wel geteld', () => {
    const d = def({
        actions: {
            act_leeg: { kind: 'run_automation', automationId: null },
            act_ok: { kind: 'run_automation', automationId: RID },
        },
        screens: [screenWithButton('act_ok')],
    });
    const { entries, unset } = refs.collectAutomationRefs(d);
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(unset, 1);
});

test('een definitie die geen definitie is levert een lege lijst en gooit niet', () => {
    for (const bad of [null, undefined, 'nee', 42, []]) {
        assert.deepStrictEqual(refs.collectAutomationRefs(bad), { entries: [], unset: 0 });
    }
});

/**
 * The two walks over the screens — `collectReferencedActions` (the validator, which gives
 * only ids) and `collectActionSites` (this module, which finds the button for it) — must
 * know the same vocabulary. This fixture contains EVERY wiring shape that the validator
 * knows; if one drops out, that is visible here immediately instead of as an empty capsule.
 */
test('de knoppenloop kent exact dezelfde bedradingsvormen als de validator', () => {
    const screens = [{
        id: 'scr_all',
        sections: [{
            id: 'sec_1',
            children: [
                { id: 'c1', type: 'button', onClick: 'act_click' },
                { id: 'c2', type: 'form', onSubmit: 'act_submit' },
                { id: 'c3', type: 'table', onRowClick: 'act_row', props: {
                    rowActions: [{ actionId: 'act_rowactions' }],
                    bulkActions: [{ actionId: 'act_bulk' }],
                    toolbarActions: [{ actionId: 'act_toolbar' }],
                    addRowActionId: 'act_addrow',
                    columns: [{ key: 'x', actionId: 'act_column' }],
                } },
                { id: 'c4', type: 'list', props: { itemActions: [{ actionId: 'act_item' }] }, children: [
                    { id: 'c5', type: 'select', onChange: 'act_change' },
                    { id: 'c6', type: 'board', onCardMove: 'act_move' },
                    { id: 'c7', type: 'approval', onDecided: 'act_decided' },
                    { id: 'c8', type: 'table', onRowSelect: 'act_select' },
                ] },
            ],
        }],
    }];
    const mine = [...refs.collectActionSites(screens).keys()].sort();
    const validator = [...collectReferencedActions(screens)].sort();
    assert.deepStrictEqual(mine, validator);
    assert.ok(mine.length >= 12, 'de fixture hoort elke vorm te dekken');
});

/**
 * THE SECOND WALK — AND THAT ONE WAS COMPARED NOWHERE.
 *
 * The test above compares the SCREEN walk. The STEPS walk (`automationsInAction`) has its
 * own mirror: `containsStepKind` in appStudio/validate/stepKindChecks.js. That one had five
 * entries — `steps`, `then`, `else`, `cases[].steps` and `default` — and the scan here had
 * four: an automation that stood only in the `default` branch of a switch ran fine (browser:
 * `execSteps(hit ? hit.steps : step.default)`; server: actionSequence.js) and never came
 * into the index. The capsule then said "No app button runs this automation yet" on exactly
 * the screen where someone decides to delete it.
 *
 * Hence two proofs side by side: the shape (which fields the recursion descends into, read
 * from the source) and the behaviour (a fixture with an automation in EVERY branch).
 */
test('de stappen-loop daalt in exact dezelfde takken af als containsStepKind', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const readSrc = (rel) => fs.readFileSync(path.resolve(__dirname, rel), 'utf8');
    // The fields that a recursive CALL receives as argument. Matched on the call, not on every
    // `step.<field>` in the window: a comment line that NAMES a branch would otherwise keep
    // the comparison green after the call itself has been removed.
    const branchesOf = (src, fnName, callee) => {
        const i = src.indexOf(fnName);
        assert.notStrictEqual(i, -1, `${fnName} niet gevonden — de scan is stuk`);
        const body = src.slice(i, i + 1600);
        const re = new RegExp(`${callee}\\(\\s*(?:s|step|c)\\.(\\w+)`, 'g');
        const found = new Set([...body.matchAll(re)].map(m => m[1]));
        assert.ok(found.size >= 4, `${callee}: de scan vond maar ${found.size} tak(ken) — hij is stuk, niet groen`);
        return found;
    };
    const mine = branchesOf(readSrc('./automationRefs.js'), 'const walkSteps =', 'walkSteps');
    const validator = branchesOf(readSrc('./validate/stepKindChecks.js'), 'function containsStepKind', 'containsStepKind');
    assert.deepStrictEqual([...mine].sort(), [...validator].sort(),
        'automationRefs.walkSteps en validate/stepKindChecks.containsStepKind moeten dezelfde takken aflopen — '
        + 'een tak die de ene wel kent en de andere niet is een automatisering die draait en niet in de index staat');
    assert.ok(mine.has('default'), 'de default-tak van een switch wordt echt uitgevoerd, dus hij telt mee');
});

test('een automatisering in ELKE taksoort belandt in de index', () => {
    const action = {
        kind: 'sequence',
        steps: [
            { kind: 'run_automation', automationId: 'a_top' },
            { kind: 'condition', then: [{ kind: 'run_automation', automationId: 'a_then' }],
              else: [{ kind: 'run_automation', automationId: 'a_else' }] },
            { kind: 'switch',
              cases: [{ value: 'x', steps: [{ kind: 'run_automation', automationId: 'a_case' }] }],
              default: [{ kind: 'run_automation', automationId: 'a_default' }] },
            { kind: 'for_each', steps: [{ kind: 'run_automation', automationId: 'a_nested' }] },
        ],
    };
    assert.deepStrictEqual(refs.automationsInAction(action).ids.sort(),
        ['a_case', 'a_default', 'a_else', 'a_nested', 'a_then', 'a_top']);
    const { entries } = refs.collectAutomationRefs({ screens: [], actions: { act_1: action } });
    assert.deepStrictEqual(entries.map(e => e.automationId).sort(),
        ['a_case', 'a_default', 'a_else', 'a_nested', 'a_then', 'a_top']);
});

// ── regel 1: een mislukte scan wist niets ─────────────────────────────

test('een app-rij die niet te lezen is laat de index staan en zegt het luid', async () => {
    const log = silentLog();
    const store = fakeStore();
    const out = await sync.reconcileAppAutomationUsage(APP, {
        log,
        automationUsageStore: store,
        studioAppStore: { getStudioApp: async () => { throw new Error('pool timeout'); } },
    });
    assert.deepStrictEqual({ ok: out.ok, reason: out.reason, written: out.written },
        { ok: false, reason: 'unreadable-app', written: 0 });
    assert.deepStrictEqual(store.calls.reconcile, [], 'er mag niets zijn geschreven');
    assert.deepStrictEqual(store.calls.purge, [], 'en al helemaal niets zijn opgeruimd');
    assert.match(log.lines.warn.join('\n'), /left as-is/);
});

test('een definitie die geen canonieke definitie is laat de index staan', async () => {
    // The store parses with a `{}` fallback, so unreadable and empty look identical to the
    // caller. Only the SHAPE can tell them apart.
    for (const definition of [{}, null, 'kapot', [], { actions: {} }]) {
        const log = silentLog();
        const store = fakeStore();
        const out = await sync.reconcileAppAutomationUsage(APP, {
            log, automationUsageStore: store, studioAppStore: appStore({ id: APP, userId: OWNER, definition }),
        });
        assert.strictEqual(out.reason, 'unreadable-definition', `${JSON.stringify(definition)} hoort onleesbaar te heten`);
        assert.strictEqual(out.ok, false);
        assert.deepStrictEqual(store.calls.reconcile, []);
    }
});

test('een ECHT lege app wist haar rijen wel — dat is geen mislukte scan', async () => {
    const store = fakeStore();
    const out = await sync.reconcileAppAutomationUsage(APP, {
        log: silentLog(), automationUsageStore: store,
        studioAppStore: appStore({ id: APP, userId: OWNER, definition: def() }),
    });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(store.calls.reconcile.length, 1);
    assert.deepStrictEqual(store.calls.reconcile[0].entries, []);
});

test('een app zonder eigenaar laat de index staan — een ongegrendelde INSERT bestaat niet', async () => {
    const store = fakeStore();
    const out = await sync.reconcileAppAutomationUsage(APP, {
        log: silentLog(), automationUsageStore: store,
        studioAppStore: appStore({ id: APP, userId: null, definition: def() }),
    });
    assert.strictEqual(out.reason, 'no-owner');
    assert.deepStrictEqual(store.calls.reconcile, []);
});

test('entries maar NUL geschreven rijen is geen succes — de automatisering is weg of van iemand anders', async () => {
    const log = silentLog();
    const store = fakeStore({ written: 0 });
    const out = await sync.reconcileAppAutomationUsage(APP, {
        log, automationUsageStore: store,
        studioAppStore: appStore({
            id: APP, userId: OWNER,
            definition: def({
                actions: { act_aaaa: { kind: 'run_automation', automationId: RID } },
                screens: [screenWithButton('act_aaaa')],
            }),
        }),
    });
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.reason, 'not-indexed');
    assert.match(log.lines.warn.join('\n'), /nothing indexed/);
});

test('een reconcile die zelf omvalt laat de index staan en gooit niet', async () => {
    const log = silentLog();
    const out = await sync.reconcileAppAutomationUsage(APP, {
        log,
        automationUsageStore: {
            reconcileAutomationUsage: async () => { throw new Error('deadlock'); },
            purgeUsageForConsumer: async () => 0,
        },
        studioAppStore: appStore({ id: APP, userId: OWNER, definition: def() }),
    });
    assert.deepStrictEqual({ ok: out.ok, reason: out.reason }, { ok: false, reason: 'failed' });
});

// ── de eigenaar komt van de APP ───────────────────────────────────────

test('de eigenaar waarmee wordt geindexeerd is die van de APP, niet die van de sessie', async () => {
    const store = fakeStore();
    await sync.reconcileAppAutomationUsage(APP, {
        log: silentLog(), automationUsageStore: store,
        studioAppStore: appStore({
            id: APP, userId: 'u_app_owner',
            definition: def({
                actions: { act_aaaa: { kind: 'run_automation', automationId: RID } },
                screens: [screenWithButton('act_aaaa')],
            }),
        }),
    });
    assert.strictEqual(store.calls.reconcile[0].owner, 'u_app_owner');
    assert.strictEqual(store.calls.reconcile[0].kind, 'app');
    assert.strictEqual(store.calls.reconcile[0].id, APP);
});

// ── regel 3: een verwijderde app laat niets achter ────────────────────

test('een verdwenen app wordt opgeruimd, niet leeggeschreven', async () => {
    const store = fakeStore();
    const out = await sync.reconcileAppAutomationUsage(APP, {
        log: silentLog(), automationUsageStore: store, studioAppStore: appStore(null),
    });
    assert.deepStrictEqual({ ok: out.ok, reason: out.reason }, { ok: true, reason: 'no-app' });
    assert.deepStrictEqual(store.calls.purge, [{ kind: 'app', id: APP }]);
    assert.deepStrictEqual(store.calls.reconcile, []);
});

test('een purge tijdens een lopende pass laat die pass NIET meer schrijven', async () => {
    const log = silentLog();
    const store = fakeStore();
    let released;
    const gate = new Promise((r) => { released = r; });
    const appId = 'app_race';

    const running = sync.reconcileAppAutomationUsage(appId, {
        log,
        automationUsageStore: store,
        // De lees blijft hangen tot de purge langs is geweest — precies het
        // venster waarin `cancelPendingReconcile` niets meer kan.
        studioAppStore: {
            getStudioApp: async () => {
                await gate;
                return { id: appId, userId: OWNER, definition: def({
                    actions: { act_a: { kind: 'run_automation', automationId: RID } },
                    screens: [screenWithButton('act_a')],
                }) };
            },
        },
    });
    await sync.purgeAppAutomationUsage(appId, { automationUsageStore: store });
    released();
    const out = await running;

    assert.deepStrictEqual({ ok: out.ok, reason: out.reason }, { ok: false, reason: 'superseded' });
    assert.deepStrictEqual(store.calls.reconcile, [], 'de pass mag de zojuist gewiste rijen niet terugzetten');
    assert.deepStrictEqual(store.calls.purge, [{ kind: 'app', id: appId }]);
});

test('een purge die omvalt laat de verwijdering staan in plaats van hem te laten mislukken', async () => {
    const log = silentLog();
    const n = await sync.purgeAppAutomationUsage('app_boem', {
        log, automationUsageStore: { purgeUsageForConsumer: async () => { throw new Error('weg'); } },
    });
    assert.strictEqual(n, 0);
    assert.match(log.lines.warn.join('\n'), /purge failed/);
});

// ── regel 2 (de andere helft): hij hangt ERNAAST ──────────────────────

test('het detached pad wacht niet, gooit niet, en dekt een reeks saves met één pass', async () => {
    const store = fakeStore();
    const app = { id: 'app_debounce', userId: OWNER, definition: def() };
    const deps = { delayMs: 5, log: silentLog(), automationUsageStore: store, studioAppStore: appStore(app) };

    // Vier saves binnen het venster.
    for (let i = 0; i < 4; i++) assert.strictEqual(sync.reconcileAppAutomationUsageDetached('app_debounce', deps), undefined);
    assert.deepStrictEqual(store.calls.reconcile, [], 'nog niets — hij hangt ernaast');
    await new Promise(r => setTimeout(r, 40));
    assert.strictEqual(store.calls.reconcile.length, 1, 'één pass voor de hele reeks');

    // And after it fires, a new save simply sets a new timer.
    sync.reconcileAppAutomationUsageDetached('app_debounce', deps);
    await new Promise(r => setTimeout(r, 40));
    assert.strictEqual(store.calls.reconcile.length, 2);
});

test('een wachtende pass wordt door de purge afgezegd', async () => {
    const store = fakeStore();
    const deps = { delayMs: 20, log: silentLog(), automationUsageStore: store, studioAppStore: appStore({ id: 'app_cancel', userId: OWNER, definition: def() }) };
    sync.reconcileAppAutomationUsageDetached('app_cancel', deps);
    assert.strictEqual(sync.cancelPendingReconcile('app_cancel'), true);
    await new Promise(r => setTimeout(r, 50));
    assert.deepStrictEqual(store.calls.reconcile, []);
});

test('zonder id doet niets iets', async () => {
    const store = fakeStore();
    assert.strictEqual(sync.reconcileAppAutomationUsageDetached('', { automationUsageStore: store }), undefined);
    assert.strictEqual(await sync.purgeAppAutomationUsage('', { automationUsageStore: store }), 0);
    const out = await sync.reconcileAppAutomationUsage('', { log: silentLog(), automationUsageStore: store });
    assert.strictEqual(out.reason, 'no-id');
    assert.deepStrictEqual(store.calls, { reconcile: [], purge: [] });
});

// ── the UNION of draft and published ─────────────────────────────────
//
// The question the capsule answers is "who breaks if I throw this away", and that is
// about PRODUCTION. Visitors run the PUBLISHED copy (routes/studioAppsRun.js), the author
// edits the working definition. Indexing only the draft goes wrong at exactly one moment,
// and that is the most dangerous one there is: the owner takes the button off the screen
// in the middle of a redesign, does not publish yet, the autosave re-indexes — and from that
// moment the capsule says with full certainty "No app button runs this automation yet" while
// the LIVE app still has that button.

// Own name: the helpers at the top of this file are already called `screenWithButton`, and a
// second function declaration with the same name OVERWRITES the first for the whole file —
// including the tests that already lean on it.
const unionDef = (actionId, automationId, label = null) => ({
    schemaVersion: 2,
    screens: [{
        id: 'scr_1',
        sections: [{ id: 'sec_1', children: [{ id: `cmp_${actionId}`, type: 'button', ...(label ? { props: { label } } : {}), onClick: actionId }] }],
    }],
    actions: { [actionId]: { kind: 'run_automation', automationId } },
});

test('een knop die alleen nog GEPUBLICEERD bestaat telt gewoon mee', async () => {
    const store = fakeStore();
    const out = await sync.reconcileAppAutomationUsage(APP, {
        log: silentLog(),
        automationUsageStore: store,
        studioAppStore: appStore({
            id: APP, userId: OWNER,
            // De auteur heeft de knop net uit de draft gehaald…
            definition: { schemaVersion: 2, screens: [], actions: {} },
            // …but the live app still runs it.
            publishedDefinition: unionDef('act_live', 'auto_live'),
        }),
    });
    assert.strictEqual(out.ok, true);
    assert.deepStrictEqual(out.entries.map(e => e.automationId), ['auto_live'],
        'de gepubliceerde knop hoort de verwijdering luidruchtig te houden');
});

test('een knop die alleen in de DRAFT bestaat telt ook mee — hij is er straks', async () => {
    const store = fakeStore();
    const out = await sync.reconcileAppAutomationUsage(APP, {
        log: silentLog(),
        automationUsageStore: store,
        studioAppStore: appStore({
            id: APP, userId: OWNER,
            definition: unionDef('act_new', 'auto_new'),
            publishedDefinition: { schemaVersion: 2, screens: [], actions: {} },
        }),
    });
    assert.deepStrictEqual(out.entries.map(e => e.automationId), ['auto_new']);
});

test('dezelfde knop in beide helften is EEN rij, met het adres uit de draft', async () => {
    const store = fakeStore();
    const draft = unionDef('act_same', 'auto_same', 'Nieuwe naam');
    const published = unionDef('act_same', 'auto_same', 'Oude naam');
    const out = await sync.reconcileAppAutomationUsage(APP, {
        log: silentLog(),
        automationUsageStore: store,
        studioAppStore: appStore({ id: APP, userId: OWNER, definition: draft, publishedDefinition: published }),
    });
    assert.strictEqual(out.entries.length, 1, 'een dubbele sleutel hoort een rij te blijven');
    assert.strictEqual(out.entries[0].label, 'Nieuwe naam',
        'het label dat de auteur op zijn scherm ziet staan wint');
});

test('een app die nooit is gepubliceerd werkt onveranderd — geen kopie is geen probleem', async () => {
    for (const publishedDefinition of [null, undefined]) {
        const store = fakeStore();
        const out = await sync.reconcileAppAutomationUsage(APP, {
            log: silentLog(),
            automationUsageStore: store,
            studioAppStore: appStore({ id: APP, userId: OWNER, definition: unionDef('act_a', 'auto_a'), publishedDefinition }),
        });
        assert.strictEqual(out.ok, true);
        assert.deepStrictEqual(out.entries.map(e => e.automationId), ['auto_a']);
    }
});

test('een ONLEESBARE gepubliceerde kopie laat de index staan — niet half indexeren', async () => {
    const store = fakeStore();
    const out = await sync.reconcileAppAutomationUsage(APP, {
        log: silentLog(),
        automationUsageStore: store,
        studioAppStore: appStore({
            id: APP, userId: OWNER,
            definition: unionDef('act_a', 'auto_a'),
            publishedDefinition: 'kapot',
        }),
    });
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.reason, 'unreadable-definition');
    assert.deepStrictEqual(store.calls.reconcile, [], 'er mag niets zijn geschreven');
});

// ── de backfill ──────────────────────────────────────────────────────

test('de backfill indexeert de apps die nog nooit zijn bekeken, in stukjes', async () => {
    const store = fakeStore();
    const seen = [];
    store.listUnindexedApps = async (limit) => { seen.push(limit); return ['app_a', 'app_b']; };
    const apps = {
        app_a: { id: 'app_a', userId: OWNER, definition: unionDef('act_a', 'auto_a') },
        app_b: { id: 'app_b', userId: OWNER, definition: unionDef('act_b', 'auto_b') },
    };
    const out = await sync.backfillAutomationUsage({
        log: silentLog(),
        limit: 2,
        automationUsageStore: store,
        studioAppStore: { getStudioApp: async (id) => apps[id] || null },
    });
    assert.deepStrictEqual({ ok: out.ok, indexed: out.indexed, failed: out.failed }, { ok: true, indexed: 2, failed: 0 });
    assert.deepStrictEqual(seen, [2]);
    assert.deepStrictEqual(store.calls.reconcile.map(c => c.id), ['app_a', 'app_b']);
});

test('een app die de backfill niet kan lezen wordt overgeslagen, niet leeggemaakt', async () => {
    const store = fakeStore();
    store.listUnindexedApps = async () => ['app_bad'];
    const out = await sync.backfillAutomationUsage({
        log: silentLog(),
        automationUsageStore: store,
        studioAppStore: { getStudioApp: async () => { throw new Error('pool timeout'); } },
    });
    assert.deepStrictEqual({ indexed: out.indexed, failed: out.failed }, { indexed: 0, failed: 1 });
    assert.deepStrictEqual(store.calls.reconcile, [], 'niets geschreven — de volgende pass probeert het opnieuw');
});
