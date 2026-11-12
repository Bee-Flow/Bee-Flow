/**
 * Email-code verification for binding a Nextcloud instance (ncBindings.js),
 * against a real Postgres (@electric-sql/pglite behind db.js,
 * testUtils/pglitePool.js) with the real users schema; nothing mocked.
 *
 * The leak this pins shut: every new code (resend, retarget, re-bootstrap)
 * resets the per-code attempt counter, so a held pendingId used to buy five
 * fresh guesses at a 6-digit code per resend, without end. Now each pending row
 * has lifetime budgets that a new code does not reset:
 *   - at most NC_VERIFICATION_MAX_CODE_SENDS codes sent (resend + retarget);
 *   - at most NC_VERIFICATION_MAX_TOTAL_ATTEMPTS guesses;
 *   - a row with a spent budget keeps its code and expiry on re-bootstrap, so it
 *     runs out; only then does a bootstrap start over with fresh counters.
 * The normal path (request a code, mistype once, enter it) is unchanged.
 *
 * And which code is accepted at all:
 *   - a code is accepted only after it was sent (resend or retarget);
 *   - a code is accepted on a pending row only: once the row is approved it
 *     answers 'expired', whatever the code;
 *   - a bootstrap for a live row whose code was sent leaves that row as it is.
 *
 * Run: cd server && node --test stores/user/ncBindings.verification.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';
// The per-organisation daily budget has its own file (ncVerificationDaily.test.js).
process.env.NC_VERIFICATION_DAILY_ATTEMPTS = '0';
process.env.NC_VERIFICATION_DAILY_SENDS = '0';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { usePglitePool } = require('../../testUtils/pglitePool');

const { pg, close } = usePglitePool();
const { initDB } = require('./schema');
const nc = require('./ncBindings');

const ORG = 'org-nc-verify';
const RIGHT = '424242';
const WRONG = '000000';
let seq = 0;

before(async () => {
    await initDB();
    await pg.query(`INSERT INTO organizations (id, name) VALUES ($1, $2)`, [ORG, 'Acme']);
});
after(close);

function bootstrapData(ncInstanceId) {
    return {
        orgId: ORG,
        ncInstanceId,
        ncBaseUrl: 'https://cloud.example.test',
        ncAdminUid: 'admin',
        ncAdminEmail: 'admin@example.test',
        verificationEmail: 'admin@example.test',
    };
}

const freshInstance = () => `nc-instance-${++seq}`;
const rawRow = async (id) => (await pg.query(`SELECT * FROM pending_nc_bindings WHERE id = $1`, [id])).rows[0];

test('resend can no longer buy unlimited guesses: per pendingId the guesses and the sends are capped', async () => {
    const pending = await nc.createPendingNcVerification(bootstrapData(freshInstance()), { code: RIGHT });

    let wrongGuesses = 0;
    let resends = 0;
    let lastResend = null;
    // An attacker who holds the pendingId: burn every guess, ask for a new code, repeat.
    for (let round = 0; round < 50; round++) {
        for (let i = 0; i < nc.NC_VERIFICATION_MAX_ATTEMPTS; i++) {
            const r = await nc.verifyPendingNcCode(pending.id, WRONG);
            if (r.status === 'invalid') wrongGuesses++;
        }
        lastResend = await nc.resetNcVerificationCode(pending.id, RIGHT);
        if (lastResend?.status !== 'ok') break;
        resends++;
    }

    assert.equal(resends, nc.NC_VERIFICATION_MAX_CODE_SENDS);
    assert.deepEqual(lastResend, { status: 'too_many' });
    assert.ok(wrongGuesses <= nc.NC_VERIFICATION_MAX_TOTAL_ATTEMPTS,
        `${wrongGuesses} guesses evaluated, cap is ${nc.NC_VERIFICATION_MAX_TOTAL_ATTEMPTS}`);
    // The budget is spent: even the right code is refused now.
    assert.equal((await nc.verifyPendingNcCode(pending.id, RIGHT)).status, 'too_many');
});

test('retarget counts as a code send and stops at the same cap', async () => {
    const pending = await nc.createPendingNcVerification(bootstrapData(freshInstance()), { code: RIGHT });
    for (let i = 0; i < nc.NC_VERIFICATION_MAX_CODE_SENDS; i++) {
        const r = i % 2
            ? await nc.resetNcVerificationCode(pending.id, RIGHT)
            : await nc.retargetNcVerification(pending.id, { email: 'other@example.test', code: RIGHT });
        assert.equal(r.status, 'ok');
    }
    assert.deepEqual(
        await nc.retargetNcVerification(pending.id, { email: 'other@example.test', code: RIGHT }),
        { status: 'too_many' },
    );
    assert.deepEqual(await nc.resetNcVerificationCode(pending.id, RIGHT), { status: 'too_many' });
    assert.equal((await rawRow(pending.id)).verification_code_sends, nc.NC_VERIFICATION_MAX_CODE_SENDS);
});

test('re-bootstrap mints a new code but does not reset the lifetime guess budget', async () => {
    const instance = freshInstance();
    const first = await nc.createPendingNcVerification(bootstrapData(instance), { code: RIGHT });
    let wrongGuesses = 0;
    for (let round = 0; round < 20; round++) {
        await nc.createPendingNcVerification(bootstrapData(instance), { code: RIGHT });
        for (let i = 0; i < nc.NC_VERIFICATION_MAX_ATTEMPTS; i++) {
            if ((await nc.verifyPendingNcCode(first.id, WRONG)).status === 'invalid') wrongGuesses++;
        }
    }
    assert.equal(wrongGuesses, nc.NC_VERIFICATION_MAX_TOTAL_ATTEMPTS);

    // Spent row: a further bootstrap keeps its expiry (no endless extension) and its code.
    const before = await rawRow(first.id);
    const again = await nc.createPendingNcVerification(bootstrapData(instance), { code: '111111' });
    assert.equal(again.id, first.id);
    const afterRow = await rawRow(first.id);
    assert.equal(new Date(afterRow.expires_at).getTime(), new Date(before.expires_at).getTime());
    assert.equal(afterRow.verification_code_hash, before.verification_code_hash);
    assert.equal((await nc.verifyPendingNcCode(first.id, RIGHT)).status, 'too_many');
});

test('once a spent row has run out, a new bootstrap starts over with fresh counters', async () => {
    const instance = freshInstance();
    const pending = await nc.createPendingNcVerification(bootstrapData(instance), { code: RIGHT });
    await pg.query(
        `UPDATE pending_nc_bindings
            SET verification_attempts_total = $2, verification_code_sends = $3,
                expires_at = NOW() - INTERVAL '1 minute'
          WHERE id = $1`,
        [pending.id, nc.NC_VERIFICATION_MAX_TOTAL_ATTEMPTS, nc.NC_VERIFICATION_MAX_CODE_SENDS],
    );
    const fresh = await nc.createPendingNcVerification(bootstrapData(instance), { code: '111111' });
    assert.ok(new Date(fresh.expiresAt).getTime() > Date.now());
    assert.equal(fresh.verificationAttemptsTotal, 0);
    assert.equal(fresh.verificationCodeSends, 0);
    assert.equal((await nc.resetNcVerificationCode(fresh.id, RIGHT)).status, 'ok');
    assert.equal((await nc.verifyPendingNcCode(fresh.id, RIGHT)).status, 'ok');
});

test('the normal path is unchanged: request a code, mistype once, enter it', async () => {
    const pending = await nc.createPendingNcVerification(bootstrapData(freshInstance()), { code: '999999' });
    const sent = await nc.retargetNcVerification(pending.id, { email: 'Setup@Example.test', uid: 'setup', code: RIGHT });
    assert.equal(sent.status, 'ok');
    assert.equal(sent.status === 'ok' && sent.row.verificationEmail, 'setup@example.test');

    assert.deepEqual(await nc.verifyPendingNcCode(pending.id, WRONG),
        { status: 'invalid', attemptsLeft: nc.NC_VERIFICATION_MAX_ATTEMPTS - 1 });
    const resent = await nc.resetNcVerificationCode(pending.id, RIGHT);
    assert.equal(resent.status, 'ok');
    // A new code resets the per-code counter, as before.
    assert.deepEqual(await nc.verifyPendingNcCode(pending.id, WRONG),
        { status: 'invalid', attemptsLeft: nc.NC_VERIFICATION_MAX_ATTEMPTS - 1 });
    const ok = await nc.verifyPendingNcCode(pending.id, RIGHT);
    assert.equal(ok.status, 'ok');
});

test('send paths on a row that is not a pending verification say so', async () => {
    assert.deepEqual(await nc.resetNcVerificationCode('no-such-id', RIGHT), { status: 'not_eligible' });
    assert.deepEqual(await nc.retargetNcVerification('no-such-id', { email: 'a@b.test', code: RIGHT }), { status: 'not_eligible' });
    const pending = await nc.createPendingNcVerification(bootstrapData(freshInstance()), { code: RIGHT });
    await nc.markPendingNcBindingApproved(pending.id, null);
    assert.deepEqual(await nc.resetNcVerificationCode(pending.id, RIGHT), { status: 'not_eligible' });
});

// ── Which code is accepted ───────────────────────────────────────────

test('a code is accepted only after it was sent: the one a bootstrap stores answers invalid and counts as an attempt', async () => {
    const pending = await nc.createPendingNcVerification(bootstrapData(freshInstance()), { code: RIGHT });

    assert.deepEqual(await nc.verifyPendingNcCode(pending.id, RIGHT),
        { status: 'invalid', attemptsLeft: nc.NC_VERIFICATION_MAX_ATTEMPTS - 1 });
    assert.equal((await rawRow(pending.id)).verification_attempts_total, 1);

    assert.equal((await nc.resetNcVerificationCode(pending.id, RIGHT)).status, 'ok');
    assert.equal((await nc.verifyPendingNcCode(pending.id, RIGHT)).status, 'ok');
});

test('a code is accepted on a pending row only: on an approved row the right code and a wrong one both answer expired', async () => {
    const pending = await nc.createPendingNcVerification(bootstrapData(freshInstance()), { code: '999999' });
    assert.equal((await nc.resetNcVerificationCode(pending.id, RIGHT)).status, 'ok');
    assert.equal((await nc.verifyPendingNcCode(pending.id, RIGHT)).status, 'ok');
    await nc.markPendingNcBindingApproved(pending.id, null);
    const before = await rawRow(pending.id);

    assert.deepEqual(await nc.verifyPendingNcCode(pending.id, RIGHT), { status: 'expired' });
    assert.deepEqual(await nc.verifyPendingNcCode(pending.id, WRONG), { status: 'expired' });
    // Also long after the approval, and nothing on the row moves.
    await pg.query(`UPDATE pending_nc_bindings SET expires_at = NOW() - INTERVAL '30 days' WHERE id = $1`, [pending.id]);
    assert.deepEqual(await nc.verifyPendingNcCode(pending.id, RIGHT), { status: 'expired' });
    const afterRow = await rawRow(pending.id);
    assert.equal(afterRow.status, 'approved');
    assert.equal(afterRow.verification_attempts_total, before.verification_attempts_total);
});

test('a bootstrap for a live row whose code was sent leaves the row as it is, and the sent code still works', async () => {
    const instance = freshInstance();
    const pending = await nc.createPendingNcVerification(bootstrapData(instance), { code: '999999' });
    const sent = await nc.retargetNcVerification(pending.id, { email: 'setup@example.test', uid: 'setup', code: RIGHT });
    assert.equal(sent.status, 'ok');
    const before = await rawRow(pending.id);

    const again = await nc.createPendingNcVerification({
        ...bootstrapData(instance),
        ncBaseUrl: 'https://other.example.test',
        ncAdminUid: 'someone',
        ncAdminEmail: 'someone@example.test',
        verificationEmail: 'someone@example.test',
        connectorCallbackUrl: 'https://other.example.test/callback',
    }, { code: '111111' });

    assert.equal(again.id, pending.id);
    assert.deepEqual(await rawRow(pending.id), before);
    assert.equal((await nc.verifyPendingNcCode(pending.id, '111111')).status, 'invalid');
    const ok = await nc.verifyPendingNcCode(pending.id, RIGHT);
    assert.equal(ok.status, 'ok');
    assert.equal(ok.status === 'ok' && ok.row.ncAdminEmail, 'setup@example.test');
    assert.equal(ok.status === 'ok' && ok.row.ncBaseUrl, 'https://cloud.example.test');
});

test('a bootstrap for a row whose code was not sent yet takes the new connection data', async () => {
    const instance = freshInstance();
    const pending = await nc.createPendingNcVerification(bootstrapData(instance), { code: '999999' });

    const again = await nc.createPendingNcVerification({
        ...bootstrapData(instance), ncBaseUrl: 'https://moved.example.test', ncAdminEmail: 'second@example.test', verificationEmail: 'second@example.test',
    }, { code: '111111' });

    assert.equal(again.id, pending.id);
    assert.equal(again.ncBaseUrl, 'https://moved.example.test');
    assert.equal(again.verificationEmail, 'second@example.test');
    assert.equal(again.verificationCodeSends, 0);
});
