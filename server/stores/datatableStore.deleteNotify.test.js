// @typecheck
'use strict';

/**
 * A DELETED table must wake the public snapshots.
 *
 * The rows of a bound table stand as a static `<table>` in the snapshot
 * under `webpage-public-shares/<shareId>/` (services/webpageBfTable.js). Those
 * bytes do not update themselves: only `notifyDatatableChanged` sets the
 * reconciler in motion. For one deleted row `bumpAfterWrite` already did that —
 * for the WHOLE table nobody did, and that is precisely the heaviest
 * deletion the product knows (`DELETE /api/datatables/:id`, and the wiping
 * of an account via `stores/user/users.js`). The names and
 * e-mail addresses then remained readable anonymously until the owner
 * happened to save the page again.
 *
 * Behaviour, not shape: the tap is really run, with a simulated clock for
 * the debounce, and the two listeners are spies. The table itself is a real
 * row on PGlite.
 *
 * Run: cd server && node --test stores/datatableStore.deleteNotify.test.js
 */

const { test, mock } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Module = require('node:module');
const { usePglitePool } = require('../testUtils/pglitePool');
const { ladderPglite } = require('../testUtils/pgliteTemplate');
const { insertRow } = require('../testUtils/pgliteSeed');

function mockModule(absId, exports) {
    const p = require.resolve(absId);
    const m = new Module(p);
    m.exports = exports;
    m.loaded = true;
    require.cache[p] = m;
}

// The table lives in a real database: the boot ladder's schema on PGlite
// behind db.js's pool (testUtils/pglitePool.js).
const { pg, close } = usePglitePool(ladderPglite());
test.after(close);
const tableExists = async (/** @type {string} */ id) => (await pg.query('SELECT 1 FROM datatables WHERE id = $1', [id])).rows.length === 1;
/** The doomed table, in `org`. @param {string} [org] */
async function seedTable(org = 'org-1') {
    await pg.query('DELETE FROM datatables WHERE id = $1', ['tbl_doomed']);
    await insertRow(pg, 'datatables', { id: 'tbl_doomed', key: 'klanten', name: 'Klanten', scope_kind: 'org', scope_id: org, owner_user_id: 'u1', organization_id: org });
}

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
// The tap knows no consumer; the jobs-side registrar wires the two listeners.
require('../jobs/datatableChangePorts');

const SCOPE = { kind: 'org', id: 'org-1' };

/** Laat de gedebouncede tap aflopen zonder er vijf seconden op te wachten. */
async function runDebounce() {
    mock.timers.tick(5000);
    // De callback zet twee losse promise-ketens in gang; die hebben echte
    // microtask-beurten nodig, en setImmediate is bewust NIET nagebootst.
    for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
}

async function reset(/** @type {string} */ org = 'org-1') {
    await seedTable(org);
    reconciled.length = 0;
    armed.length = 0;
    reconcilerThrows = false;
}

test('een verwijderde tabel wekt de reconciler die de openbare snapshot herschrijft', async (t) => {
    await reset();
    mock.timers.enable({ apis: ['setTimeout'] });
    t.after(() => mock.timers.reset());

    const ok = await datatableStore.deleteDatatable('tbl_doomed', SCOPE);
    assert.strictEqual(ok, true);
    assert.strictEqual(await tableExists('tbl_doomed'), false, 'de rij moet echt weg zijn');

    await runDebounce();
    assert.deepStrictEqual(reconciled, ['tbl_doomed'],
        'zonder deze melding blijven naam en e-mailadres op /w/<slug> staan tot de eigenaar toevallig opslaat');
    assert.deepStrictEqual(armed, ['tbl_doomed'],
        'de kennisbron-arm hangt aan dezelfde tap en moet even goed lopen');
});

test('een verwijdering die niets wist, wekt niemand', async (t) => {
    await reset('org-2');   // andere scope
    mock.timers.enable({ apis: ['setTimeout'] });
    t.after(() => mock.timers.reset());

    const ok = await datatableStore.deleteDatatable('tbl_doomed', SCOPE);
    assert.strictEqual(ok, false);
    assert.strictEqual(await tableExists('tbl_doomed'), true, 'de tabel van een ander blijft staan');

    await runDebounce();
    assert.deepStrictEqual(reconciled, [],
        'er is niets gewist, dus er valt niets te herschrijven — anders herschrijft een 404 alle snapshots van een vreemde');
    assert.deepStrictEqual(armed, []);
});

test('valt de reconciler om, dan blijft de verwijdering geslaagd en loopt de andere luisteraar door', async (t) => {
    await reset();
    reconcilerThrows = true;
    mock.timers.enable({ apis: ['setTimeout'] });
    t.after(() => mock.timers.reset());

    // The notice sits behind a commit that has already succeeded: it must not
    // be able to tilt the answer of the deletion.
    const ok = await datatableStore.deleteDatatable('tbl_doomed', SCOPE);
    assert.strictEqual(ok, true);

    await runDebounce();
    assert.deepStrictEqual(reconciled, []);
    assert.deepStrictEqual(armed, ['tbl_doomed'],
        'twee luisteraars, twee eigen catches — de een mag de ander niet meenemen');
});
