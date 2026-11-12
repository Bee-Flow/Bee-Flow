/**
 * The daily budget of an organisation for the e-mailed one-time code
 * (ncVerificationDaily.mts), through ncBindings.js, against a real Postgres
 * (@electric-sql/pglite behind db.js, testUtils/pglitePool.js) with the real
 * schema; nothing mocked.
 *
 *   - attempts and sends are counted over every pending row of the
 *     organisation, so new rows do not start a new budget;
 *   - past the budget every attempt and send answers 'too_many' that day;
 *   - another organisation has its own budget; 0 means unlimited.
 *
 * Run: cd server && node --test stores/user/ncVerificationDaily.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';
process.env.NC_VERIFICATION_DAILY_ATTEMPTS = '20';
process.env.NC_VERIFICATION_DAILY_SENDS = '3';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { usePglitePool } = require('../../testUtils/pglitePool');

const { pg, close } = usePglitePool();
const { initDB } = require('./schema');
const nc = require('./ncBindings');
const { dailyCap, takeDailyNcVerification } = require('./ncVerificationDaily.mts');

let seq = 0;
before(async () => {
    await initDB();
    for (const id of ['org-daily-a', 'org-daily-b', 'org-daily-c']) {
        await pg.query(`INSERT INTO organizations (id, name) VALUES ($1, $2)`, [id, id]);
    }
});
after(close);

const row = (orgId) => nc.createPendingNcVerification({
    orgId, ncInstanceId: `inst-daily-${++seq}`, ncBaseUrl: 'https://cloud.example.test', ncAdminUid: 'admin', ncAdminEmail: 'admin@example.test',
}, { code: '424242' });

test('the 21st attempt of the day is refused, across rows of the organisation', async () => {
    const statuses = [];
    for (let r = 0; r < 5; r++) {
        const pending = await row('org-daily-a');
        for (let i = 0; i < 5; i++) statuses.push((await nc.verifyPendingNcCode(pending.id, '000000')).status);
    }
    assert.equal(statuses.filter((s) => s === 'invalid').length, 20);
    assert.ok(statuses.slice(20).every((s) => s === 'too_many'), statuses.join(','));
    // Even the right code, on a fresh row.
    const fresh = await row('org-daily-a');
    assert.equal((await nc.verifyPendingNcCode(fresh.id, '424242')).status, 'too_many');
    assert.equal((await pg.query(`SELECT attempts FROM nc_verification_daily WHERE org_id = 'org-daily-a'`)).rows[0].attempts, 20);
});

test('sends: resend, retarget and a counted send share the daily budget', async () => {
    const a = await row('org-daily-b');
    const b = await row('org-daily-b');
    assert.equal((await nc.resetNcVerificationCode(a.id, '111111')).status, 'ok');
    assert.equal((await nc.retargetNcVerification(b.id, { email: 'x@example.test', code: '222222' })).status, 'ok');
    assert.equal((await nc.countNcVerificationSend(a.id)).status, 'ok');
    assert.deepEqual(await nc.resetNcVerificationCode(b.id, '333333'), { status: 'too_many' });
    assert.deepEqual(await nc.countNcVerificationSend(b.id), { status: 'too_many' });
});

test('another organisation has its own budget; 0 is unlimited', async () => {
    assert.equal(await takeDailyNcVerification('org-daily-c', 'attempts'), true);
    process.env.NC_VERIFICATION_DAILY_ATTEMPTS = '0';
    try {
        assert.equal(dailyCap('attempts'), 0);
        for (let i = 0; i < 30; i++) assert.equal(await takeDailyNcVerification('org-daily-a', 'attempts'), true);
    } finally { process.env.NC_VERIFICATION_DAILY_ATTEMPTS = '20'; }
    delete process.env.NC_VERIFICATION_DAILY_SENDS;
    try { assert.equal(dailyCap('sends'), 20); } finally { process.env.NC_VERIFICATION_DAILY_SENDS = '3'; }
});
