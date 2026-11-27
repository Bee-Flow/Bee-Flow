/**
 * A store write that touches two tables lands together or not at all (module "automation"): usage rows + the "indexed" marker.
 * The core's cases: storeWrites.atomic.pg.test.js; the set-up: testUtils/refuseWrites.js.
 *
 * Run: cd server && node --require ./testUtils/registerFeatures.js --test stores/storeWrites.atomic.automation.pg.test.js
 */

'use strict';

const { test, before } = require('node:test');
const assert = require('node:assert');
const { useRefusingPglite } = require('../testUtils/refuseWrites');

const { pg, refuse, count, REFUSED, setUp } = useRefusingPglite();
const usageStore = require('./automationUsageStore');

before(() => setUp([usageStore.initDB]));

test('purgeUsageForConsumer: a failing marker delete keeps the usage rows', async () => {
    for (const id of [REFUSED, 'app-ok']) {
        await pg.query(`INSERT INTO automation_usage (automation_id, consumer_kind, consumer_id, ref_id, owner_user_id) VALUES ('a1', 'app', $1, 'r1', 'u1')`, [id]);
        await pg.query(`INSERT INTO automation_usage_indexed (consumer_kind, consumer_id) VALUES ('app', $1)`, [id]);
    }
    await refuse('automation_usage_indexed', 'BEFORE DELETE', `OLD.consumer_id = '${REFUSED}'`);
    await assert.rejects(() => usageStore.purgeUsageForConsumer('app', REFUSED), /write refused/);
    assert.strictEqual(await count(`SELECT COUNT(*)::int AS n FROM automation_usage WHERE consumer_id = $1`, [REFUSED]), 1);
    assert.strictEqual(await usageStore.purgeUsageForConsumer('app', 'app-ok'), 1);
    assert.strictEqual(await count(`SELECT COUNT(*)::int AS n FROM automation_usage_indexed WHERE consumer_id = 'app-ok'`), 0);
});
