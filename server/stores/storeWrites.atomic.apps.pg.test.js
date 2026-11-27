/**
 * A store write that touches two tables lands together or not at all (module "apps"): app dataset + its cache.
 * The core's cases: storeWrites.atomic.pg.test.js; the set-up: testUtils/refuseWrites.js.
 *
 * Run: cd server && node --require ./testUtils/registerFeatures.js --test stores/storeWrites.atomic.apps.pg.test.js
 */

'use strict';

const { test, before } = require('node:test');
const assert = require('node:assert');
const { useRefusingPglite } = require('../testUtils/refuseWrites');

const { pg, refuse, count, REFUSED, setUp } = useRefusingPglite();
const studioAppData = require('./studioAppDataStore');
const { initDB: initStudioApps } = require('./studioApp/schema');

before(() => setUp([initStudioApps, () => studioAppData.ready]));

test('deleteDataset: a failing dataset delete keeps its cache', async () => {
    await pg.query(`INSERT INTO studio_apps (id, user_id) VALUES ('app-1', 'u1')`);
    await pg.query(`INSERT INTO studio_app_datasets (id, app_id, owner_user_id, name) VALUES ('ds-1', 'app-1', 'u1', $1)`, [REFUSED]);
    await pg.query(`INSERT INTO studio_app_dataset_cache (id, dataset_id, viewer_scope_key, params_hash) VALUES ('c-1', 'ds-1', 'v', 'h')`);
    await refuse('studio_app_datasets', 'BEFORE DELETE', `OLD.name = '${REFUSED}'`);
    await assert.rejects(() => studioAppData.deleteDataset('ds-1', 'app-1', 'u1'), /write refused/);
    assert.strictEqual(await count(`SELECT COUNT(*)::int AS n FROM studio_app_dataset_cache WHERE dataset_id = 'ds-1'`), 1);
});
