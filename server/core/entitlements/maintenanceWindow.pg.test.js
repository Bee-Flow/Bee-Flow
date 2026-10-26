// @typecheck strict
/**
 * The maintenance window against the REAL configStore, on a real Postgres
 * (@electric-sql/pglite behind db.js's pool, testUtils/pglitePool.js).
 *
 * The sibling maintenanceWindow.test.js stubs the store with a map that hands
 * back exactly the string announce() wrote. The real getConfig JSON-parses the
 * stored value and returns an OBJECT, which getActiveWindow then parsed a
 * second time: that threw, and every announced window read as "none" in
 * production. This suite runs the store's own SQL and cache, so a reader that
 * assumes the wrong shape fails here.
 *
 * Run: cd server && node --test core/entitlements/maintenanceWindow.pg.test.js
 */

'use strict';

// configStore opens a LISTEN socket to a real Postgres unless under test.
process.env.NODE_ENV = 'test';

const { test, after } = require('node:test');
const assert = require('node:assert');

const { usePglitePool } = require('../../testUtils/pglitePool');

const { close } = usePglitePool();
const configStore = require('../../stores/configStore');
const mw = require('./maintenanceWindow');

// getConfig and setConfig run the store's own schema init on first use.
after(close);

test('an announced window reads back as active through the real configStore', async () => {
    const win = /** @type {{ endsAt: string }} */ (await mw.announce({ etaSeconds: 120, reason: 'deploy', ref: 'abc123' }));
    // The store hands back the parsed object, not the string announce() wrote.
    const stored = await configStore.getConfig(mw.CONFIG_KEY);
    assert.strictEqual(typeof stored, 'object');

    const active = await mw.getActiveWindow();
    assert.ok(active, 'window should be active immediately after announcing');
    assert.strictEqual(active.ref, 'abc123');
    assert.strictEqual(active.endsAt, win.endsAt);
});

test('the window expires at its own endsAt through the real configStore', async () => {
    const win = /** @type {{ endsAt: string }} */ (await mw.announce({ etaSeconds: 60 }));
    assert.strictEqual(await mw.getActiveWindow(Date.parse(win.endsAt) + 1000), null);
});

test('clear takes the window down through the real configStore', async () => {
    await mw.announce({ etaSeconds: 600 });
    assert.ok(await mw.getActiveWindow());
    await mw.clear();
    assert.strictEqual(await mw.getActiveWindow(), null);
});
