/**
 * A store write that touches two tables lands together or not at all (module "compliance"): custom-check import + framework stamp.
 * The core's cases: storeWrites.atomic.pg.test.js; the set-up: testUtils/refuseWrites.js.
 *
 * Run: cd server && node --require ./testUtils/registerFeatures.js --test stores/storeWrites.atomic.compliance.pg.test.js
 */

'use strict';

const { test, before } = require('node:test');
const assert = require('node:assert');
const { useRefusingPglite } = require('../testUtils/refuseWrites');

const { refuse, count, REFUSED, setUp } = useRefusingPglite();
const customFrameworkStore = require('./customFrameworkStore');

before(() => setUp([customFrameworkStore.initDB]));

test('upsertChecks: a failing framework stamp imports no check', async () => {
    const fw = await customFrameworkStore.createFramework('org-1', { code: 'RF', name: REFUSED });
    await refuse('compliance_custom_frameworks', 'BEFORE UPDATE', `NEW.name = '${REFUSED}'`);
    await assert.rejects(() => customFrameworkStore.upsertChecks('org-1', fw.id, [{ ref: 'A.1', title: 'One' }, { ref: 'A.2', title: 'Two' }]), /write refused/);
    assert.strictEqual(await count('SELECT COUNT(*)::int AS n FROM compliance_custom_checks WHERE framework_id = $1', [fw.id]), 0);
});
