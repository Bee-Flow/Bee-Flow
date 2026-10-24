/**
 * automationUsageStore — the index "which button runs this automation" (P4 part C).
 *
 * What is fixed here, in order of how bad it is if it breaks:
 *
 *   1. THE OWNERSHIP LOCK IS IN THE INSERT. An app may only index an automation of the
 *      SAME owner. `automationBridge` refuses when `automation.userId !== app.userId`,
 *      so a reference across that boundary cannot run; indexing it anyway would show the
 *      automation's owner the name of someone else's app. And because the lock sits in the INSERT, a
 *      non-empty list that writes ZERO rows is how that shows itself.
 *   2. THE DELETE IS ON TWO COLUMNS. Delete-then-insert on
 *      `(consumer_kind, consumer_id)` — never on the id alone, because then a
 *      future second kind could wipe the rows of the first.
 *   3. THE automation_id IS IN THE KEY. One action can run two automations
 *      (two run_automation steps in the same sequence). Without the automation id in the PK
 *      the second overwrites the first and one of the two automations sees
 *      itself as unused.
 *   4. SCOPE AND OWNER COME FROM THE AUTOMATION, NOT FROM THE CALLER.
 *      `owner_user_id` and `organization_id` are read from the `automations` row;
 *      otherwise they are two facts that can drift apart.
 *   5. A MISSING studio_apps TABLE GIVES FEWER TITLES, NEVER FEWER ROWS. On a fresh
 *      installation that table only exists once someone opens App
 *      Studio, and a JOIN to a non-existent relation is a 500 on
 *      the capsule.
 *
 * DB-free: ../db is replaced via require.cache. The fake db is not a blank
 * recorder but a mini Postgres for exactly this table: it knows the
 * primary key, the `FROM automations` lock and ON CONFLICT DO UPDATE, and
 * it REFUSES every statement it does not recognise — so a changed
 * shape shows up instead of slipping through silently.
 *
 * Run: cd server && node --test --test-reporter=tap stores/automationUsageStore.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

process.env.NODE_ENV = 'test';

// ── nep-Postgres voor automation_usage ───────────────────────────────

const PK = ['consumer_kind', 'consumer_id', 'ref_id', 'automation_id'];

const db = {
    ddl: [],
    // Not wiped by reset(): the DDL runs at module load, so before the
    // first test. Were this in `statements`, the evidence would be gone.
    locks: [],
    statements: [],
    rows: [],           // automation_usage
    indexed: [],        // automation_usage_indexed: { consumer_kind, consumer_id }
    automations: [],    // { id, user_id, organization_id }
    apps: new Map(),    // studio_apps: id → name
    hasAppsTable: true,
};

const norm = (sql) => String(sql).replace(/\s+/g, ' ').trim();
const pkOf = (row) => JSON.stringify(PK.map(c => row[c]));

function reset() {
    db.statements.length = 0;
    db.rows.length = 0;
    db.indexed.length = 0;
    db.automations.length = 0;
    db.apps.clear();
}

function applyInsert(sql, params) {
    // The lock MUST be there, and the placeholders are read out of it instead of
    // guessed — so this test fails if the lock disappears, and not
    // if someone changes the column order.
    assert.match(sql, /FROM automations a/, 'de INSERT hoort uit `automations` te selecteren');
    const guard = sql.match(/WHERE a\.id = \$(\d+) AND a\.user_id = \$(\d+)/);
    assert.ok(guard, `de eigendomsgrendel ontbreekt in: ${sql}`);
    const automationId = params[Number(guard[1]) - 1];
    const ownerId = params[Number(guard[2]) - 1];

    const a = db.automations.find(r => r.id === automationId && r.user_id === ownerId);
    if (!a) return { rowCount: 0, rows: [] };   // bestaat niet, of is van iemand anders

    // The column order from the statement itself, so the test does not lean on a
    // fixed order. `a.*` comes from the automation row, `$n` from the params.
    const cols = sql.match(/INSERT INTO automation_usage\s*\(([^)]+)\)/)[1].split(',').map(s => s.trim());
    const vals = sql.match(/SELECT (.+?) FROM automations/)[1].split(',').map(s => s.trim());
    assert.equal(cols.length, vals.length, 'kolommen en waarden lopen niet gelijk op');
    const row = {};
    cols.forEach((col, i) => {
        const v = vals[i];
        const ph = v.match(/^\$(\d+)/);
        if (ph) row[col] = params[Number(ph[1]) - 1];
        else if (v === 'a.id') row[col] = a.id;
        else if (v === 'a.user_id') row[col] = a.user_id;
        else if (v === 'a.organization_id') row[col] = a.organization_id ?? null;
        else throw new Error(`onbekende SELECT-uitdrukking: ${v}`);
    });
    row.updated_at = new Date().toISOString();

    const existing = db.rows.find(r => pkOf(r) === pkOf(row));
    if (!existing) { db.rows.push(row); return { rowCount: 1, rows: [] }; }
    const setPart = sql.match(/DO UPDATE SET (.+)$/);
    if (!setPart) throw new Error(`onbekende ON CONFLICT-vorm: ${sql}`);
    for (const assign of setPart[1].split(',')) {
        const [lhs, rhs] = assign.split('=').map(s => s.trim());
        if (/^EXCLUDED\./i.test(rhs)) existing[lhs] = row[rhs.split('.')[1]];
        else if (/^NOW\(\)$/i.test(rhs)) existing[lhs] = new Date().toISOString();
    }
    return { rowCount: 1, rows: [] };
}

function applyDelete(sql, params) {
    const before = db.rows.length;
    if (/WHERE consumer_kind = \$1 AND consumer_id = \$2/.test(sql)) {
        db.rows = db.rows.filter(r => !(r.consumer_kind === params[0] && r.consumer_id === params[1]));
    } else if (/WHERE automation_id = \$1$/.test(sql)) {
        db.rows = db.rows.filter(r => r.automation_id !== params[0]);
    } else {
        // A DELETE on consumer_id alone (or on something else) must NEVER succeed
        // silently — that is rule 2.
        throw new Error(`onverwachte DELETE-vorm — sleuteling veranderd: ${sql}`);
    }
    return { rowCount: before - db.rows.length, rows: [] };
}

function applySelect(sql, params) {
    // The coverage question: how many apps have never been indexed?
    if (/FROM studio_apps a/.test(sql) && /automation_usage_indexed/.test(sql)) {
        const unindexed = [...db.apps.keys()]
            .filter(id => !db.indexed.some(r => r.consumer_kind === 'app' && r.consumer_id === id));
        if (/COUNT\(\*\)::int AS pending/.test(sql)) return [{ pending: unindexed.length }];
        return unindexed.map(id => ({ id }));
    }
    if (/FROM automation_usage u/.test(sql)) {
        assert.match(sql, /WHERE u\.automation_id = \$1/, 'de lees hoort op automation_id te filteren');
        const joins = /LEFT JOIN studio_apps/.test(sql);
        return db.rows
            .filter(r => r.automation_id === params[0])
            .map(r => ({ ...r, ...(joins ? { app_title: db.apps.get(r.consumer_id) || null } : {}) }));
    }
    if (/FROM automation_usage/.test(sql) && /GROUP BY automation_id/.test(sql)) {
        const ids = params[0];
        const counts = new Map();
        for (const r of db.rows) {
            if (!ids.includes(r.automation_id)) continue;
            counts.set(r.automation_id, (counts.get(r.automation_id) || 0) + 1);
        }
        return [...counts].map(([automation_id, refs]) => ({ automation_id, refs }));
    }
    throw new Error(`onverwachte SELECT: ${sql}`);
}

// ── the coverage marker ──────────────────────────────────────────────
// `automation_usage_indexed` is the table that keeps "empty" and "never looked at" apart.
// It is written in the SAME transaction as the rows themselves, and the purge removes it
// too — those two facts are tested below, so the fake db must actually execute them and not just swallow them.
function applyIndexedInsert(sql, params) {
    const [kind, id] = params;
    const hit = db.indexed.find(r => r.consumer_kind === kind && r.consumer_id === id);
    if (hit) { hit.indexed_at = new Date().toISOString(); return { rowCount: 1, rows: [] }; }
    db.indexed.push({ consumer_kind: kind, consumer_id: id, indexed_at: new Date().toISOString() });
    return { rowCount: 1, rows: [] };
}

function applyIndexedDelete(sql, params) {
    const before = db.indexed.length;
    if (!/WHERE consumer_kind = \$1 AND consumer_id = \$2/.test(sql)) {
        throw new Error(`onverwachte DELETE-vorm op de markering: ${sql}`);
    }
    db.indexed = db.indexed.filter(r => !(r.consumer_kind === params[0] && r.consumer_id === params[1]));
    return { rowCount: before - db.indexed.length, rows: [] };
}

function dispatch(sql, params = []) {
    const s = norm(sql);
    db.statements.push({ sql: s, params });
    if (/^(SAVEPOINT|RELEASE|ROLLBACK|BEGIN|COMMIT|SET LOCAL)/i.test(s)) return { rowCount: 0, rows: [] };
    if (/^SELECT pg_advisory_xact_lock/i.test(s)) { db.locks.push(params[0]); return { rowCount: 0, rows: [] }; }
    if (/^CREATE (TABLE|INDEX|UNIQUE)/i.test(s)) { db.ddl.push(s); return { rowCount: 0, rows: [] }; }
    // De markeringstabel eerst: haar naam begint met dezelfde woorden.
    if (/^DELETE FROM automation_usage_indexed/i.test(s)) return applyIndexedDelete(s, params);
    if (/^INSERT INTO automation_usage_indexed/i.test(s)) return applyIndexedInsert(s, params);
    if (/^DELETE FROM automation_usage/i.test(s)) return applyDelete(s, params);
    if (/^INSERT INTO automation_usage/i.test(s)) return applyInsert(s, params);
    if (/^SELECT/i.test(s) && /automation_usage/.test(s)) return { rowCount: 0, rows: applySelect(s, params) };
    throw new Error(`onverwacht statement: ${s}`);
}

const dbPath = require.resolve(path.join(__dirname, '..', 'db.js'));
require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: {
        exec: async (sql) => { dispatch(sql); },
        run: async (sql, params = []) => dispatch(sql, params),
        getAll: async (sql, params = []) => dispatch(sql, params).rows,
        getOne: async (sql, params = []) => {
            const s = norm(sql);
            if (/to_regclass\('studio_apps'\)/.test(s)) return { apps: db.hasAppsTable };
            return dispatch(s, params).rows[0] || null;
        },
        withTransaction: async (fn) => fn({ query: async (sql, params) => dispatch(sql, params) }),
        isSqlStateError: (e) => typeof e?.code === 'string' && !!e?.severity,
        makeStoreInit: (tag, fn) => {
            let p = null;
            return () => {
                if (!p) p = Promise.resolve().then(fn).catch((e) => { p = null; throw e; });
                return p;
            };
        },
    },
};

// The table does NOT exist on a fresh installation; test 5 therefore runs first,
// because the probe remembers its answer as soon as it does find it.
db.hasAppsTable = false;

const store = require('./automationUsageStore');

const APP = 'app_1';
const OWNER = 'u_owner';
const ORG = 'org_1';
const RID = 'auto_1';

function automation(id = RID, userId = OWNER, organizationId = ORG) {
    return { id, user_id: userId, organization_id: organizationId };
}

function entry(over = {}) {
    return {
        automationId: RID,
        refId: 'act:act_aaaa',
        screenId: 'scr_home',
        nodeId: 'cmp_btn',
        label: 'Send invoice',
        wired: true,
        ...over,
    };
}

// ── 5 (eerst, zie hierboven) ─────────────────────────────────────────

test('zonder studio_apps-tabel komen de rijen terug zonder titel, niet zonder rijen', async () => {
    reset();
    db.automations.push(automation());
    await store.reconcileAutomationUsage('app', APP, OWNER, [entry()]);
    const rows = await store.listUsageOfAutomation(RID);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].consumerTitle, null);
    assert.ok(!db.statements.some(s => /LEFT JOIN studio_apps/.test(s.sql)),
        'zonder de tabel hoort er geen JOIN in het statement te staan');
    db.hasAppsTable = true;   // vanaf hier bestaat hij wél
});

// ── 1: de eigendomsgrendel ───────────────────────────────────────────

test('een automatisering van een ANDERE eigenaar wordt niet geindexeerd, en dat is zichtbaar', async () => {
    reset();
    db.automations.push(automation(RID, 'u_iemand_anders'));
    const written = await store.reconcileAutomationUsage('app', APP, OWNER, [entry()]);
    assert.equal(written, 0, 'niets geschreven');
    assert.equal(db.rows.length, 0);
    // And the caller can see it: a non-empty list that writes 0.
    assert.deepEqual(await store.listUsageOfAutomation(RID), []);
});

test('een automatisering die niet meer bestaat wordt niet geindexeerd', async () => {
    reset();
    const written = await store.reconcileAutomationUsage('app', APP, OWNER, [entry()]);
    assert.equal(written, 0);
});

test('een automatisering van dezelfde eigenaar wordt wel geindexeerd', async () => {
    reset();
    db.automations.push(automation());
    db.apps.set(APP, 'Facturatie');
    const written = await store.reconcileAutomationUsage('app', APP, OWNER, [entry()]);
    assert.equal(written, 1);
    const rows = await store.listUsageOfAutomation(RID);
    assert.equal(rows.length, 1);
    assert.deepEqual(
        { kind: rows[0].consumerKind, id: rows[0].consumerId, title: rows[0].consumerTitle, action: rows[0].actionId, label: rows[0].label, wired: rows[0].wired },
        { kind: 'app', id: APP, title: 'Facturatie', action: 'act_aaaa', label: 'Send invoice', wired: true },
    );
});

// ── 4: eigenaar en organisatie komen van de AUTOMATISERING ──────────────────

test('owner_user_id en organization_id komen van de automatisering, niet van de aanroeper', async () => {
    reset();
    db.automations.push(automation(RID, OWNER, 'org_van_de_automation'));
    await store.reconcileAutomationUsage('app', APP, OWNER, [entry()]);
    assert.equal(db.rows[0].owner_user_id, OWNER);
    assert.equal(db.rows[0].organization_id, 'org_van_de_automation');
    const rows = await store.listUsageOfAutomation(RID);
    assert.equal(rows[0].organizationId, 'org_van_de_automation');
});

// ── 3: het automation-id zit in de sleutel ──────────────────────────────

test('een actie die twee automatiseringen draait levert twee rijen, niet een overschreven rij', async () => {
    reset();
    db.automations.push(automation('auto_a'), automation('auto_b'));
    const written = await store.reconcileAutomationUsage('app', APP, OWNER, [
        entry({ automationId: 'auto_a', refId: 'act:act_same' }),
        entry({ automationId: 'auto_b', refId: 'act:act_same' }),
    ]);
    assert.equal(written, 2);
    assert.equal((await store.listUsageOfAutomation('auto_a')).length, 1);
    assert.equal((await store.listUsageOfAutomation('auto_b')).length, 1);
});

// ── 2: delete-then-insert, op TWEE kolommen ──────────────────────────

test('reconcile vervangt precies de rijen van deze app en laat andere apps staan', async () => {
    reset();
    db.automations.push(automation());
    await store.reconcileAutomationUsage('app', APP, OWNER, [entry({ refId: 'act:act_oud' })]);
    await store.reconcileAutomationUsage('app', 'app_2', OWNER, [entry({ refId: 'act:act_van_app2' })]);
    await store.reconcileAutomationUsage('app', APP, OWNER, [entry({ refId: 'act:act_nieuw' })]);

    const refs = (await store.listUsageOfAutomation(RID)).map(r => `${r.consumerId}/${r.refId}`).sort();
    assert.deepEqual(refs, ['app_1/act:act_nieuw', 'app_2/act:act_van_app2'],
        'de oude rij van app_1 is weg, die van app_2 staat er nog');
    // En de DELETE noemde beide kolommen (de fake gooit anders al).
    assert.ok(db.statements.some(s => /^DELETE FROM automation_usage WHERE consumer_kind = \$1 AND consumer_id = \$2/.test(s.sql)));
});

test('een lege lijst wist de rijen van deze app — de reconciler moet dus weten wat hij doet', async () => {
    reset();
    db.automations.push(automation());
    await store.reconcileAutomationUsage('app', APP, OWNER, [entry()]);
    assert.equal(db.rows.length, 1);
    const written = await store.reconcileAutomationUsage('app', APP, OWNER, []);
    assert.equal(written, 0);
    assert.equal(db.rows.length, 0);
});

test('een tweede reconcile met dezelfde sleutel schrijft geen tweede rij maar werkt hem bij', async () => {
    reset();
    db.automations.push(automation());
    await store.reconcileAutomationUsage('app', APP, OWNER, [entry({ label: 'Oud' })]);
    await store.reconcileAutomationUsage('app', APP, OWNER, [entry({ label: 'Nieuw', wired: false })]);
    assert.equal(db.rows.length, 1);
    const rows = await store.listUsageOfAutomation(RID);
    assert.equal(rows[0].label, 'Nieuw');
    assert.equal(rows[0].wired, false);
});

// ── purge, beide kanten van de ontbrekende FK ────────────────────────

test('purgeUsageForConsumer haalt alleen de rijen van die app weg', async () => {
    reset();
    db.automations.push(automation());
    await store.reconcileAutomationUsage('app', APP, OWNER, [entry()]);
    await store.reconcileAutomationUsage('app', 'app_2', OWNER, [entry()]);
    assert.equal(await store.purgeUsageForConsumer('app', APP), 1);
    assert.deepEqual((await store.listUsageOfAutomation(RID)).map(r => r.consumerId), ['app_2']);
});

test('purgeUsageOfAutomation haalt de rijen van die automatisering weg, over apps heen', async () => {
    reset();
    db.automations.push(automation('auto_a'), automation('auto_b'));
    await store.reconcileAutomationUsage('app', APP, OWNER, [
        entry({ automationId: 'auto_a', refId: 'act:a' }),
        entry({ automationId: 'auto_b', refId: 'act:b' }),
    ]);
    assert.equal(await store.purgeUsageOfAutomation('auto_a'), 1);
    assert.deepEqual((await store.listUsageOfAutomation('auto_a')), []);
    assert.equal((await store.listUsageOfAutomation('auto_b')).length, 1);
});

// ── invoerhygiene ────────────────────────────────────────────────────

test('een onbekende consumerKind gooit in plaats van stil niets te doen', async () => {
    reset();
    await assert.rejects(() => store.reconcileAutomationUsage('webpage', APP, OWNER, []), /consumerKind/);
    await assert.rejects(() => store.purgeUsageForConsumer('kb', APP), /consumerKind/);
});

test('reconcile zonder eigenaar gooit — een ongegrendelde INSERT mag niet bestaan', async () => {
    reset();
    await assert.rejects(() => store.reconcileAutomationUsage('app', APP, null, [entry()]), /ownerUserId/);
    await assert.rejects(() => store.reconcileAutomationUsage('app', '', OWNER, [entry()]), /consumerId/);
});

test('entries zonder automation-id of zonder ref worden overgeslagen, niet geschreven', async () => {
    reset();
    db.automations.push(automation());
    const written = await store.reconcileAutomationUsage('app', APP, OWNER, [
        entry({ automationId: '' }),
        entry({ refId: null }),
        null,
        entry(),
    ]);
    assert.equal(written, 1);
});

// ── telling ──────────────────────────────────────────────────────────

test('countUsageOfAutomations geeft 0 voor een automatisering die nergens in staat', async () => {
    reset();
    db.automations.push(automation('auto_a'));
    await store.reconcileAutomationUsage('app', APP, OWNER, [
        entry({ automationId: 'auto_a', refId: 'act:1' }),
        entry({ automationId: 'auto_a', refId: 'act:2' }),
    ]);
    const counts = await store.countUsageOfAutomations(['auto_a', 'auto_leeg']);
    assert.equal(counts.get('auto_a'), 2);
    assert.equal(counts.get('auto_leeg'), 0);
    assert.deepEqual(await store.countUsageOfAutomations([]), new Map());
});

// ── de ladder ────────────────────────────────────────────────────────

test('de tabel en haar indexen komen uit de runDdl-ladder van deze store', () => {
    const all = db.ddl.join('\n');
    assert.match(all, /CREATE TABLE IF NOT EXISTS automation_usage/);
    assert.match(all, /PRIMARY KEY \(consumer_kind, consumer_id, ref_id, automation_id\)/);
    assert.match(all, /CREATE INDEX IF NOT EXISTS idx_automation_usage_automation/);
    assert.match(all, /CREATE INDEX IF NOT EXISTS idx_automation_usage_consumer/);
    assert.match(all, /CREATE TABLE IF NOT EXISTS automation_usage_indexed/);
    assert.match(all, /PRIMARY KEY \(consumer_kind, consumer_id\)/);
    // The lock of _ddl.js was run along too, under the tag of THIS store — so
    // this really was the runDdl path and not a loose exec beside it.
    assert.deepEqual(db.locks, ['beeflow:ddl:automationUsageStore'],
        'de DDL hoort door runDdl te lopen, niet door een kale exec');
});

// ── the third answer: "never looked at" ──────────────────────────────
//
// `automation_usage` can only show rows, and zero rows there means two
// things at once: "no button at all runs this automation" and "this index has
// never been built for that app yet". On the day of rollout the second is true for
// EVERY existing app — the table is created empty and only fills when
// someone saves an app — and then every automation owner reads "used nowhere"
// about buttons that do run.

test('een reconcile markeert de app als bekeken — ook een die niets aanzet', async () => {
    reset();
    db.apps.set(APP, 'Expenses');
    assert.deepEqual(await store.usageIndexCoverage(), { complete: false, pending: 1 });

    // An EMPTY list is a valid outcome: this app really switches nothing on.
    await store.reconcileAutomationUsage('app', APP, OWNER, []);
    assert.deepEqual(await store.usageIndexCoverage(), { complete: true, pending: 0 });
    assert.deepEqual(await store.listUnindexedApps(10), []);
});

test('de markering wordt in dezelfde transactie geschreven als de rijen', async () => {
    reset();
    db.apps.set(APP, 'Expenses');
    db.automations.push(automation());
    await store.reconcileAutomationUsage('app', APP, OWNER, [entry()]);
    const order = db.statements.map(x => x.sql);
    const del = order.findIndex(x => /^DELETE FROM automation_usage WHERE/.test(x));
    const mark = order.findIndex(x => /^INSERT INTO automation_usage_indexed/.test(x));
    assert.ok(del !== -1 && mark !== -1, 'beide statements horen te zijn gedraaid');
    assert.ok(mark > del, 'de markering hoort NA de rijen te komen, in dezelfde pass');
});

test('een app die nog nooit is bekeken staat op de werklijst van de backfill', async () => {
    reset();
    db.apps.set('app_a', 'A');
    db.apps.set('app_b', 'B');
    await store.reconcileAutomationUsage('app', 'app_a', OWNER, []);
    assert.deepEqual(await store.listUnindexedApps(10), ['app_b']);
    assert.deepEqual(await store.usageIndexCoverage(), { complete: false, pending: 1 });
});

test('een verwijderde app verliest ook haar markering — hij is niet bekeken, hij is er niet', async () => {
    reset();
    db.apps.set(APP, 'Expenses');
    db.automations.push(automation());
    await store.reconcileAutomationUsage('app', APP, OWNER, [entry()]);
    assert.equal((await store.usageIndexCoverage()).pending, 0);
    await store.purgeUsageForConsumer('app', APP);
    assert.deepEqual(db.indexed, [], 'de markering hoort mee te verdwijnen');
});
