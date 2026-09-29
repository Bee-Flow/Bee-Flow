/**
 * App-catalogue ordering.
 *
 * REGRESSION (2026-09-11): the builder used to FILTER this catalogue with a
 * substring matcher and `.slice(0, 8)`. On a Nextcloud org every app id
 * contains "nextcloud" and stop words match some description everywhere, so
 * every app matched and the slice kept the first eight in REGISTRY order.
 * `nextcloud-notifications` and `nextcloud-tables` were cut from an invoice
 * brief that named both, and a short reply ("ok", "fix it") matched nothing at
 * all — rendering the catalogue empty under the heading "the ONLY tools you may
 * propose" while the profile forced a tool call.
 *
 * The invariant these tests defend: RANKING ORDERS, IT NEVER GATES. If someone
 * later re-introduces relevance-based removal, the "nothing is ever dropped"
 * tests below fail — which is the point.
 *
 * Run: cd server && node --test --test-force-exit automation/builderPrompt/rankApps.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

// Stub the reranker before rankApps requires it.
const rerankPath = path.join(__dirname, '..', '..', 'core', 'rerank', 'llamaCppRerank.js');
let rerankImpl = async () => [];
require.cache[rerankPath] = {
    id: rerankPath, filename: rerankPath, loaded: true,
    exports: { rerankLlamaCpp: (...a) => rerankImpl(...a) },
};

const { rankAppsForMessage, APP_CAP } = require('./rankApps');

const app = (id, actions, available = true) => ({
    id, label: id, available,
    actions: actions.map(n => ({ name: n })),
});

// Mirrors the shape of the real org: one big app, then many small ones whose
// ids all share the "nextcloud-" prefix.
const CATALOG = {
    apps: [
        app('memory', ['memory_search', 'memory_write']),
        app('kb-ingest', ['knowledge_base_ingest']),
        app('nextcloud', ['nextcloud_list_files', 'nextcloud_read_file', 'nextcloud_create_spreadsheet']),
        app('nextcloud-calendar', ['nextcloud_calendar_list', 'nextcloud_calendar_create_event']),
        app('nextcloud-talk', ['nextcloud_talk_send_message']),
        app('nextcloud-notifications', ['nextcloud_notifications_send']),
        app('nextcloud-tables', ['nextcloud_tables_add_row']),
    ],
};
const ids = (cat) => cat.apps.map(a => a.id);

test('nothing is ever dropped — every permitted app survives ranking', async () => {
    rerankImpl = async () => [];
    const out = await rankAppsForMessage(CATALOG, 'sort my invoices', { steps: [] });
    assert.strictEqual(out.apps.length, CATALOG.apps.length);
    for (const a of CATALOG.apps) {
        assert.ok(ids(out).includes(a.id), `${a.id} must still be in the catalogue`);
    }
});

test('the apps the old filter cut are present for the invoice brief', async () => {
    // The exact regression: both of these were absent from the prompt while the
    // brief named them, and the model built with Calendar instead.
    rerankImpl = async () => [];
    const brief = 'Read the invoices in Nextcloud, add a row to the Invoices table and send a notification in Nextcloud.';
    const out = await rankAppsForMessage(CATALOG, brief, { steps: [] });
    assert.ok(ids(out).includes('nextcloud-notifications'), 'notifications app must be offered');
    assert.ok(ids(out).includes('nextcloud-tables'), 'tables app must be offered');
});

test('a short reply still yields the full catalogue, not an empty one', async () => {
    // "ok" / "yes" / "fix it" matched no token under the old filter, so the
    // prompt claimed the user had no integrations connected — on a turn where a
    // tool call is mandatory.
    rerankImpl = async () => [];
    for (const msg of ['ok', 'yes', 'fix it', '']) {
        const out = await rankAppsForMessage(CATALOG, msg, { steps: [] });
        assert.strictEqual(out.apps.length, CATALOG.apps.length, `"${msg}" must not empty the catalogue`);
    }
});

test('relevance decides ORDER', async () => {
    // Rank notifications first; it is last in registry order.
    rerankImpl = async (_q, docs) => {
        const i = docs.findIndex(d => /notifications/i.test(d));
        return [{ index: i, relevance_score: 0.9 }];
    };
    const out = await rankAppsForMessage(CATALOG, 'notify me', { steps: [] });
    assert.strictEqual(out.apps[0].id, 'nextcloud-notifications');
    assert.strictEqual(out.apps.length, CATALOG.apps.length, 'ordering must not shorten the list');
});

test('apps the draft already uses are pinned ahead of the ranking', async () => {
    // A hyphenated app id is the case the old draft-pin got wrong:
    // "nextcloud_notifications_send".split('_')[0] === "nextcloud", which never
    // equals the app id "nextcloud-notifications". Match on action names instead.
    rerankImpl = async (_q, docs) => docs.map((_, i) => ({ index: i, relevance_score: 1 - i / 100 }));
    const draft = { steps: [{ tool: 'nextcloud_notifications_send' }] };
    const out = await rankAppsForMessage(CATALOG, 'carry on', draft);
    assert.strictEqual(out.apps[0].id, 'nextcloud-notifications', 'an app the draft depends on must not drift down');
});

test('the trigger provider is pinned too', async () => {
    rerankImpl = async () => [];
    const draft = { steps: [], trigger: { appEvent: { provider: 'nextcloud-talk' } } };
    const out = await rankAppsForMessage(CATALOG, 'go on', draft);
    assert.strictEqual(out.apps[0].id, 'nextcloud-talk');
});

test('apps used inside a loop body are pinned as well', async () => {
    rerankImpl = async () => [];
    const draft = { steps: [{ type: 'loop', body: [{ tool: 'nextcloud_tables_add_row' }] }] };
    const out = await rankAppsForMessage(CATALOG, 'continue', draft);
    assert.strictEqual(out.apps[0].id, 'nextcloud-tables');
});

test('a reranker failure falls back to registry order instead of failing the build', async () => {
    for (const impl of [async () => { throw new Error('ECONNREFUSED'); }, async () => [], async () => null]) {
        rerankImpl = impl;
        const out = await rankAppsForMessage(CATALOG, 'anything', { steps: [] });
        assert.deepStrictEqual(ids(out), ids(CATALOG), 'registry order is the fallback');
    }
});

test('unavailable apps are the only ones removed', async () => {
    rerankImpl = async () => [];
    const cat = { apps: [...CATALOG.apps, app('gmail', ['gmail_search'], false)] };
    const out = await rankAppsForMessage(cat, 'mail me', { steps: [] });
    assert.ok(!ids(out).includes('gmail'), 'permission, not relevance, is what removes an app');
    assert.strictEqual(out.apps.length, CATALOG.apps.length);
});

test('an app the reranker omits keeps its place rather than vanishing', async () => {
    // A partial result must never be read as "the rest are irrelevant".
    rerankImpl = async () => [{ index: 2, relevance_score: 0.9 }];
    const out = await rankAppsForMessage(CATALOG, 'files', { steps: [] });
    assert.strictEqual(out.apps[0].id, 'nextcloud');
    assert.strictEqual(out.apps.length, CATALOG.apps.length, 'unranked apps stay in the catalogue');
});

test('the cap is a blow-up guard, far above any real catalogue', async () => {
    rerankImpl = async () => [];
    assert.ok(APP_CAP >= 40, 'a cap near the real app count would reintroduce silent dropping');
    const many = { apps: Array.from({ length: APP_CAP + 5 }, (_, i) => app(`app-${i}`, [`app_${i}_do`])) };
    const out = await rankAppsForMessage(many, 'x', { steps: [] });
    assert.strictEqual(out.apps.length, APP_CAP);
});

// ── Stored order replay (applyCatalogOrder / catalogOrderOf) ──────────────
//
// The ordered catalogue is the front of the prompt cache. rankAppsForMessage
// depends on THIS turn's message and on what the draft uses, so replaying it
// every turn changed the system prompt every turn. The order is computed once
// and replayed verbatim; these tests pin "verbatim" and "still never gates".

const { applyCatalogOrder, catalogOrderOf } = require('./rankApps');

test('catalogOrderOf is the id list of the catalogue as ordered', async () => {
    rerankImpl = async (_q, docs) => docs.map((_, i) => ({ index: docs.length - 1 - i, relevance_score: 1 })).reverse();
    const ranked = await rankAppsForMessage(CATALOG, 'x', { steps: [] });
    assert.deepStrictEqual(catalogOrderOf(ranked), ranked.apps.map(a => a.id));
    assert.deepStrictEqual(catalogOrderOf({ apps: [] }), []);
    assert.deepStrictEqual(catalogOrderOf(null), []);
});

test('a stored order is applied verbatim', () => {
    const order = ['nextcloud-tables', 'memory', 'nextcloud-notifications', 'nextcloud', 'nextcloud-talk', 'kb-ingest', 'nextcloud-calendar'];
    const out = applyCatalogOrder(CATALOG, order);
    assert.deepStrictEqual(ids(out), order);
});

test('an app not in the stored order is appended at the end, in registry order', () => {
    const order = ['nextcloud-tables', 'memory'];
    const out = applyCatalogOrder(CATALOG, order);
    assert.deepStrictEqual(ids(out), [
        'nextcloud-tables', 'memory',
        // the rest exactly as the registry lists them
        'kb-ingest', 'nextcloud', 'nextcloud-calendar', 'nextcloud-talk', 'nextcloud-notifications',
    ]);
    // A newly connected app shows up too — never silently invisible.
    const grown = { apps: [...CATALOG.apps, app('gmail', ['gmail_search'])] };
    assert.strictEqual(ids(applyCatalogOrder(grown, order)).at(-1), 'gmail');
});

test('an id that is no longer in the catalogue is dropped from the order, nothing else changes', () => {
    const order = ['gone-app', 'nextcloud-talk', 'also-gone', 'memory'];
    const out = applyCatalogOrder(CATALOG, order);
    assert.ok(!ids(out).includes('gone-app') && !ids(out).includes('also-gone'));
    assert.deepStrictEqual(ids(out).slice(0, 2), ['nextcloud-talk', 'memory']);
    assert.strictEqual(out.apps.length, CATALOG.apps.length, 'no usable app lost');
});

test('available:false is the only thing applyCatalogOrder removes', () => {
    const cat = { apps: [...CATALOG.apps, app('gmail', ['gmail_search'], false), app('empty', [])] };
    const out = applyCatalogOrder(cat, ['gmail', 'empty', 'memory']);
    assert.ok(!ids(out).includes('gmail'), 'a stored id cannot resurrect an app the user lost permission to');
    assert.ok(!ids(out).includes('empty'), 'an app with no actions is not rendered anywhere');
    assert.strictEqual(out.apps.length, CATALOG.apps.length);
});

test('applyCatalogOrder never calls the reranker', () => {
    rerankImpl = () => { throw new Error('reranker must not be consulted on a replay turn'); };
    const out = applyCatalogOrder(CATALOG, ids(CATALOG).reverse());
    assert.deepStrictEqual(ids(out), ids(CATALOG).reverse());
    rerankImpl = async () => [];
});

test('a draft with pinned tools does NOT reorder a replayed catalogue', () => {
    // The pin lives in rankAppsForMessage only. On a replay turn the draft has
    // grown since the order was stored; pinning here would move apps to the
    // front as steps are added — the per-turn prompt drift this replaces.
    const order = ids(CATALOG); // registry order: notifications second-to-last, tables last
    const out = applyCatalogOrder(CATALOG, order);
    assert.deepStrictEqual(ids(out), order);
    assert.strictEqual(out.apps.at(-2).id, 'nextcloud-notifications', 'stays where it was even though a draft using it would pin it first');
    assert.strictEqual(out.apps.at(-1).id, 'nextcloud-tables');
});

test('length invariant: usable apps in == apps out (capped at APP_CAP), duplicates in the order collapse', () => {
    const out = applyCatalogOrder(CATALOG, ['memory', 'memory', 'nextcloud']);
    assert.strictEqual(out.apps.length, CATALOG.apps.length);
    assert.strictEqual(new Set(ids(out)).size, out.apps.length, 'no app rendered twice');
    const many = { apps: Array.from({ length: APP_CAP + 5 }, (_, i) => app(`app-${i}`, [`app_${i}_do`])) };
    assert.strictEqual(applyCatalogOrder(many, []).apps.length, APP_CAP);
    assert.deepStrictEqual(applyCatalogOrder(null, ['x']), null, 'a missing catalogue passes through');
});

// ── The catalogue carries more than apps ─────────────────────────────────
//
// chatStream puts the user's datatable list on `catalog.datatables` before
// ordering, and both prompts render it as the "Datatables you may use" block.
// Both orderers rebuild the catalogue object; a `{ apps }` literal in either
// would silently drop the block and send the model back to inventing ids.

test('catalog.datatables survives ranking and replay untouched', async () => {
    rerankImpl = async () => [];
    const datatables = [{ id: 'tbl_1a2b3c', key: 'facturen', name: 'Facturen', canWrite: true, columns: [] }];
    const ranked = await rankAppsForMessage({ ...CATALOG, datatables }, 'sort my invoices', { steps: [] });
    assert.strictEqual(ranked.datatables, datatables, 'rankAppsForMessage keeps catalog.datatables');
    const replayed = applyCatalogOrder({ ...CATALOG, datatables }, ids(CATALOG));
    assert.strictEqual(replayed.datatables, datatables, 'applyCatalogOrder keeps catalog.datatables');
    // The two absent shapes mean different things to the renderer; neither
    // may be turned into the other on the way through.
    assert.strictEqual((await rankAppsForMessage({ ...CATALOG, datatables: null }, 'x', { steps: [] })).datatables, null);
    assert.ok(!('datatables' in applyCatalogOrder(CATALOG, [])), 'no key in → no key out');
});
