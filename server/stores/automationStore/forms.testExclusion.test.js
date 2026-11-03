/**
 * A form's TEST LINK rows (automation_form_pages.is_test, formTestPageStore.mts)
 * never reach a production reader: the Forms directory and the counts
 * (listFormPagesForOrg), the per-automation list and the answers dashboard
 * (getFormPagesForAutomation), the provisioning of the production page
 * (ensureFormPage), rotation, and the submission counter (touchFormPage). The
 * test link itself: one working link per trigger, revoked = expired at once,
 * the reaper removes expired rows once no unclaimed upload hangs on them, and
 * a session remembers that it is a test.
 *
 * Against a real Postgres (PGlite behind db.js; the store runs its own
 * migrations). Run: cd server && node --test stores/automationStore/forms.testExclusion.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { usePglitePool } = require('../../testUtils/pglitePool');

const { pg, close } = usePglitePool();
const forms = require('./forms');
const { testLinkExpiresAt } = require('./formTestPageStore.mts');

before(async () => {
    await pg.exec(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, "organizationId" TEXT)`);
    await require('./core').initDB();
    await pg.exec(`INSERT INTO users (id, "organizationId") VALUES ('owner', 'org1'), ('tester', 'org1')`);
    await pg.exec(`INSERT INTO automations (id, user_id, organization_id, title, definition_json, is_active, is_draft)
                   VALUES ('au1', 'owner', 'org1', 'Intake', '{"trigger":{"id":"t","kind":"form","form":{"fields":[]}}}', TRUE, FALSE)`);
});
after(close);

test('production readers never see a test link; the test link is found by its own reader', async () => {
    const prod = await forms.ensureFormPage('au1', null);
    const link = await forms.createTestFormPage('au1', { issuedByUserId: 'tester', expiresAt: testLinkExpiresAt() });
    assert.notStrictEqual(link.id, prod.id);
    assert.strictEqual(link.isTest, true);
    assert.strictEqual(link.issuedByUserId, 'tester');
    assert.strictEqual(link.audience, 'restricted');
    assert.deepStrictEqual(link.sharedUserIds, ['tester'], 'by default only its maker');
    assert.ok(link.expiresAt);

    assert.deepStrictEqual((await forms.getFormPagesForAutomation('au1')).map((p) => p.id), [prod.id]);
    assert.deepStrictEqual((await forms.listFormPagesForOrg('org1', 'owner')).map((p) => p.id), [prod.id]);
    assert.strictEqual((await forms.ensureFormPage('au1', null)).id, prod.id, 'provisioning never picks the test row');
    assert.strictEqual(await forms.rotateFormPage(link.id, 'au1'), null, 'a test link is not rotated into a production page');

    await forms.touchFormPage(link.id);
    await forms.touchFormPage(prod.id);
    const counts = Object.fromEntries((await pg.query(`SELECT id, submissions FROM automation_form_pages`)).rows.map((r) => [r.id, Number(r.submissions)]));
    assert.strictEqual(counts[link.id], 0, 'a test is not a submission');
    assert.strictEqual(counts[prod.id], 1);

    assert.strictEqual((await forms.getTestFormPage('au1', null)).id, link.id);
    assert.strictEqual((await forms.getFormPage(link.id)).isTest, true);
    assert.strictEqual((await forms.getFormPage(prod.id)).isTest, false);
});

test('one working test link per trigger; revoking stops it at once; the reaper removes it once its uploads are gone', async () => {
    const first = await forms.getTestFormPage('au1', null);
    const second = await forms.createTestFormPage('au1', { issuedByUserId: 'owner', expiresAt: null });
    assert.notStrictEqual(second.id, first.id);
    assert.strictEqual((await forms.getTestFormPage('au1', null)).id, second.id);
    const firstRow = await forms.getFormPage(first.id);
    assert.ok(new Date(firstRow.expiresAt).getTime() <= Date.now(), 'the replaced link expired');

    // An unclaimed upload keeps the expired row until the upload reaper deleted its blob.
    const up = await forms.recordFormUpload(first.id, { storageKey: 'k1', filename: 'a.pdf', mimeType: 'application/pdf', size: 3 });
    await pg.exec(`UPDATE automation_form_pages SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = '${first.id}'`);
    assert.strictEqual(await forms.deleteExpiredTestFormPages(), 0);
    await forms.deleteFormUploads([up.id]);
    assert.strictEqual(await forms.deleteExpiredTestFormPages(), 1);
    assert.strictEqual(await forms.getFormPage(first.id), null);

    assert.strictEqual(await forms.revokeTestFormPages('au1', null), 1);
    assert.strictEqual(await forms.getTestFormPage('au1', null), null);
    assert.strictEqual(await forms.revokeTestFormPages('au1', null), 0);
    const prod = (await forms.getFormPagesForAutomation('au1'))[0];
    assert.strictEqual((await forms.getFormPage(prod.id)).expiresAt, null, 'the production page is never touched');
});

test('a session remembers that it is a test', async () => {
    const prod = (await forms.getFormPagesForAutomation('au1'))[0];
    const s = await forms.createFormSession(prod.id, 'au1', { isTest: true });
    assert.strictEqual(s.isTest, true);
    assert.strictEqual((await forms.getFormSession(s.id, prod.id)).isTest, true);
    const p = await forms.createFormSession(prod.id, 'au1');
    assert.strictEqual((await forms.getFormSession(p.id, prod.id)).isTest, false);
});

test('AUTOMATION_FORM_TEST_LINK_DAYS: 14 days by default, 0 = never', () => {
    const now = Date.UTC(2026, 10, 3);
    assert.strictEqual(testLinkExpiresAt(now, {}).getTime(), now + 14 * 86_400_000);
    assert.strictEqual(testLinkExpiresAt(now, { AUTOMATION_FORM_TEST_LINK_DAYS: '2' }).getTime(), now + 2 * 86_400_000);
    assert.strictEqual(testLinkExpiresAt(now, { AUTOMATION_FORM_TEST_LINK_DAYS: '0' }), null);
    assert.strictEqual(testLinkExpiresAt(now, { AUTOMATION_FORM_TEST_LINK_DAYS: 'soon' }).getTime(), now + 14 * 86_400_000);
});
