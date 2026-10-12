/**
 * automationUsageStore — de index "welke knop draait deze automation" (P4 deel C).
 *
 * Wat hier vastligt, in volgorde van hoe erg het is als het breekt:
 *
 *   1. DE EIGENDOMSGRENDEL ZIT IN DE INSERT. Een app mag alleen een automatisering
 *      van DEZELFDE eigenaar indexeren. `automationBridge` weigert bij
 *      `automation.userId !== app.userId`, dus een verwijzing over die grens
 *      kan niet draaien; hem tóch indexeren zou de automation-eigenaar de naam
 *      van andermans app tonen. En omdat de grendel in de INSERT zit, is een
 *      niet-lege lijst die NUL rijen schrijft de manier waarop dat zich meldt.
 *   2. DE DELETE IS OP TWEE KOLOMMEN. Delete-then-insert op
 *      `(consumer_kind, consumer_id)` — nooit op het id alleen, want dan zou
 *      een toekomstige tweede soort de rijen van de eerste kunnen wissen.
 *   3. HET automation_id ZIT IN DE SLEUTEL. Eén actie kan twee automatiseringen
 *      draaien (twee run_automation-stappen in dezelfde sequence). Zonder het
 *      automation-id in de PK overschrijft de tweede de eerste en ziet één van de
 *      twee automatiseringen zichzelf als ongebruikt.
 *   4. SCOPE EN EIGENAAR KOMEN VAN DE AUTOMATISERING, NIET VAN DE AANROEPER.
 *      `owner_user_id` en `organization_id` worden uit de `automations`-rij
 *      gelezen; anders zijn het twee feiten die uit elkaar kunnen lopen.
 *   5. EEN ONTBREKENDE studio_apps-TABEL GEEFT MINDER TITEL, NOOIT MINDER
 *      RIJEN. Op een verse installatie bestaat die tabel pas als iemand App
 *      Studio opent, en een JOIN naar een niet-bestaande relatie is een 500 op
 *      de capsule.
 *
 * DB-vrij: ../db wordt via require.cache vervangen. De nep-db is geen loze
 * recorder maar een mini-Postgres voor precies deze tabel: hij kent de
 * primaire sleutel, de `FROM automations`-grendel en ON CONFLICT DO UPDATE, en
 * hij WEIGERT elk statement dat hij niet herkent — zo valt een gewijzigde
 * vorm op in plaats van dat hij stil door glipt.
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
    // Niet door reset() gewist: de DDL draait bij module-load, dus vóór de
    // eerste test. Zou dit in `statements` zitten, dan was het bewijs weg.
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
    // De grendel MOET er staan, en de plaatshouders worden eruit gelezen in
    // plaats van geraden — zo faalt deze test als de grendel verdwijnt, en niet
    // als iemand de kolomvolgorde wijzigt.
    assert.match(sql, /FROM automations a/, 'de INSERT hoort uit `automations` te selecteren');
    const guard = sql.match(/WHERE a\.id = \$(\d+) AND a\.user_id = \$(\d+)/);
    assert.ok(guard, `de eigendomsgrendel ontbreekt in: ${sql}`);
    const automationId = params[Number(guard[1]) - 1];
    const ownerId = params[Number(guard[2]) - 1];

    const a = db.automations.find(r => r.id === automationId && r.user_id === ownerId);
    if (!a) return { rowCount: 0, rows: [] };   // bestaat niet, of is van iemand anders

    // De kolomvolgorde uit het statement zelf, zodat de test niet op een
    // vaste volgorde leunt. `a.*` komt van de automation-rij, `$n` van de params.
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
        // Een DELETE op alleen consumer_id (of op iets anders) mag NOOIT stil
        // slagen — dat is regel 2.
        throw new Error(`onverwachte DELETE-vorm — sleuteling veranderd: ${sql}`);
    }
    return { rowCount: before - db.rows.length, rows: [] };
}

function applySelect(sql, params) {
    // De dekkingsvraag: hoeveel apps zijn nog nooit geindexeerd?
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

// ── de dekkingsmarkering ─────────────────────────────────────────────
// `automation_usage_indexed` is de tabel die "leeg" en "nog nooit gekeken" uit
// elkaar houdt. Hij wordt in DEZELFDE transactie geschreven als de rijen zelf,
// en de purge haalt hem mee weg — die twee feiten worden hieronder getest, dus
// de nep-db moet ze echt uitvoeren en niet alleen slikken.
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

// De tabel bestaat op een verse installatie NIET; test 5 draait daarom eerst,
// want de probe onthoudt zijn antwoord zodra hij hem wél vindt.
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
    // En de aanroeper kan het zien: een niet-lege lijst die 0 schrijft.
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
    // De lock van _ddl.js is meegedraaid, onder de tag van DEZE store — dus
    // dit was echt de runDdl-weg en niet een losse exec ernaast.
    assert.deepEqual(db.locks, ['beeflow:ddl:automationUsageStore'],
        'de DDL hoort door runDdl te lopen, niet door een kale exec');
});

// ── het derde antwoord: "nog nooit gekeken" ──────────────────────────
//
// `automation_usage` kan alleen rijen tonen, en nul rijen betekent daar twee
// dingen tegelijk: "geen enkele knop draait deze automation" en "deze index is
// voor die app nog nooit gebouwd". Op de dag van uitrol is dat tweede waar voor
// élke bestaande app — de tabel wordt leeg aangelegd en vult zich pas als
// iemand een app opslaat — en dan leest elke automation-eigenaar "wordt nergens
// gebruikt" over knoppen die gewoon draaien.

test('een reconcile markeert de app als bekeken — ook een die niets aanzet', async () => {
    reset();
    db.apps.set(APP, 'Expenses');
    assert.deepEqual(await store.usageIndexCoverage(), { complete: false, pending: 1 });

    // Een LEGE lijst is een geldige uitslag: deze app zet echt niets aan.
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
