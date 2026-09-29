'use strict';

/**
 * Een VERWIJDERDE tabel moet de openbare snapshots wekken.
 *
 * De rijen van een gebonden tabel staan als statische `<table>` in de snapshot
 * onder `webpage-public-shares/<shareId>/` (services/webpageBfTable.js). Die
 * bytes werken zichzelf niet bij: alleen `notifyDatatableChanged` zet de
 * reconciler in beweging. Voor één gewiste rij deed `bumpAfterWrite` dat al —
 * voor de HELE tabel deed niemand het, en dat is nu juist de zwaarste
 * verwijdering die het product kent (`DELETE /api/datatables/:id`, en het
 * wissen van een account via `stores/user/users.js`). De namen en
 * e-mailadressen bleven dan anoniem leesbaar tot de eigenaar de pagina
 * toevallig opnieuw opsloeg.
 *
 * Gedrag, niet vorm: de tap wordt écht gelopen, met een nagebootste klok voor
 * de debounce, en de twee luisteraars zijn spionnen. `db.js` is de naad — de
 * gebruikelijke require.cache-truc — zodat er geen database aan te pas komt.
 *
 * Draaien: cd server && node --test --test-force-exit stores/datatableStore.deleteNotify.test.js
 */

const { test, mock } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Module = require('node:module');

function mockModule(absId, exports) {
    const p = require.resolve(absId);
    const m = new Module(p);
    m.exports = exports;
    m.loaded = true;
    require.cache[p] = m;
}

// ── De naad: één nep-client die vertelt wat er gevraagd is ──────────────────

const sql = [];
let deleteRowCount = 1;

const client = {
    query: async (text, params) => {
        sql.push({ text: String(text).replace(/\s+/g, ' ').trim(), params });
        if (/^SELECT model, model_version/i.test(String(text).trim())) {
            return {
                rows: [{
                    model: JSON.stringify({ modelVersion: 1, tables: [{ id: 'tbl_doomed', key: 'klanten' }] }),
                    model_version: 3,
                }],
            };
        }
        if (/^DELETE FROM datatables/i.test(String(text).trim())) return { rowCount: deleteRowCount };
        return { rows: [], rowCount: 1 };
    },
    release: () => { },
};

mockModule(path.join(__dirname, '..', 'db.js'), {
    pool: { query: async () => ({ rows: [] }), connect: async () => client },
    run: async () => ({ rows: [], rowCount: 0 }),
    getOne: async () => null,
    getAll: async () => [],
    exec: async () => ({ rows: [] }),
    getClient: async () => client,
    withTransaction: async (fn) => fn(client),
    makeStoreInit: () => async () => { },
    getRedis: () => null,
    redisHealthy: () => false,
    isSqlStateError: () => false,
});

// De twee luisteraars aan de tap.
const reconciled = [];
const armed = [];
let reconcilerThrows = false;
mockModule(path.join(__dirname, '..', 'core', 'webpages', 'webpageShareReconciler'), {
    onDatatableChanged: async (id) => {
        if (reconcilerThrows) throw new Error('snapshotopslag plat');
        reconciled.push(id);
        return 1;
    },
});
mockModule(path.join(__dirname, '..', 'jobs', 'kbSourceRefresh'), {
    onDatatableChanged: async (id) => { armed.push(id); },
});

const datatableStore = require('./datatableStore');

const SCOPE = { kind: 'org', id: 'org-1' };

/** Laat de gedebouncede tap aflopen zonder er vijf seconden op te wachten. */
async function runDebounce() {
    mock.timers.tick(5000);
    // De callback zet twee losse promise-ketens in gang; die hebben echte
    // microtask-beurten nodig, en setImmediate is bewust NIET nagebootst.
    for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
}

function reset() {
    sql.length = 0;
    reconciled.length = 0;
    armed.length = 0;
    deleteRowCount = 1;
    reconcilerThrows = false;
}

test('een verwijderde tabel wekt de reconciler die de openbare snapshot herschrijft', async (t) => {
    reset();
    mock.timers.enable({ apis: ['setTimeout'] });
    t.after(() => mock.timers.reset());

    const ok = await datatableStore.deleteDatatable('tbl_doomed', SCOPE);
    assert.strictEqual(ok, true);
    assert.ok(sql.some(q => /^DELETE FROM datatables/i.test(q.text)), 'de rij moet echt weg zijn');

    await runDebounce();
    assert.deepStrictEqual(reconciled, ['tbl_doomed'],
        'zonder deze melding blijven naam en e-mailadres op /w/<slug> staan tot de eigenaar toevallig opslaat');
    assert.deepStrictEqual(armed, ['tbl_doomed'],
        'de kennisbron-arm hangt aan dezelfde tap en moet even goed lopen');
});

test('een verwijdering die niets wist, wekt niemand', async (t) => {
    reset();
    deleteRowCount = 0;   // andere scope, of al weg
    mock.timers.enable({ apis: ['setTimeout'] });
    t.after(() => mock.timers.reset());

    const ok = await datatableStore.deleteDatatable('tbl_doomed', SCOPE);
    assert.strictEqual(ok, false);

    await runDebounce();
    assert.deepStrictEqual(reconciled, [],
        'er is niets gewist, dus er valt niets te herschrijven — anders herschrijft een 404 alle snapshots van een vreemde');
    assert.deepStrictEqual(armed, []);
});

test('valt de reconciler om, dan blijft de verwijdering geslaagd en loopt de andere luisteraar door', async (t) => {
    reset();
    reconcilerThrows = true;
    mock.timers.enable({ apis: ['setTimeout'] });
    t.after(() => mock.timers.reset());

    // De melding hangt achter een commit die al geslaagd is: hij mag het
    // antwoord van de verwijdering niet kunnen kantelen.
    const ok = await datatableStore.deleteDatatable('tbl_doomed', SCOPE);
    assert.strictEqual(ok, true);

    await runDebounce();
    assert.deepStrictEqual(reconciled, []);
    assert.deepStrictEqual(armed, ['tbl_doomed'],
        'twee luisteraars, twee eigen catches — de een mag de ander niet meenemen');
});
