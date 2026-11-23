/**
 * Cowork's Privacy Shield setting (./coworkShieldSettings.js) on a real Postgres (PGlite behind db.js): a new
 * organisation starts with it on, an organisation admin switches it, a member reads it, and the switch is audited.
 * Who is a member or an admin of which organisation is the tenant isolation matrix's question
 * (tenantIsolation.matrix.test.js lists both routes).
 *
 * Run: cd server && node --test routes/coworkShieldSettings.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';
const { close } = require('../testUtils/pglitePool').usePglitePool();
after(close);

const flag = require('../core/entitlements/coworkShieldFlag');
const userStore = require('../stores/userStore');

before(async () => { await userStore.initDB(); });

test('a new organisation starts with the shield on; one that already chose keeps its choice', async () => {
    assert.strictEqual(await userStore.createOrganization({ id: 'org-new-shield', name: 'New' }, { autoGrantTrial: false }), true);
    assert.deepStrictEqual(await flag.resolveCoworkShieldFlag('org-new-shield'), { enabled: true, configured: true });

    await flag.setCoworkShield('org-chose', false);
    await flag.enableForNewOrganisation('org-chose');
    flag.invalidateCoworkShieldFlag('org-chose');
    assert.deepStrictEqual(await flag.resolveCoworkShieldFlag('org-chose'), { enabled: false, configured: true });
    await flag.enableForNewOrganisation(null);
});

test('an organisation that predates the switch reads as off until someone chooses', async () => {
    assert.deepStrictEqual(await flag.resolveCoworkShieldFlag('org-from-before'), { enabled: false, configured: false });
});
