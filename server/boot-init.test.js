const test = require('node:test');
const assert = require('node:assert/strict');

const { checkInitAdminPassword } = require('./boot-init');

test('INIT_ADMIN_PASSWORD: the template placeholder is refused', async () => {
    for (const pw of ['CHANGE_ME', 'change_me', 'CHANGE_ME_please_1234']) {
        const r = await checkInitAdminPassword(pw, 'admin');
        assert.equal(r.ok, false, pw);
        assert.equal(r.code, 'password_placeholder');
    }
});

test('INIT_ADMIN_PASSWORD: the administrator policy applies (length, deny-list, identity)', async () => {
    assert.equal((await checkInitAdminPassword('Short1', 'admin')).code, 'password_too_short');
    assert.equal((await checkInitAdminPassword('password1234', 'admin')).ok, false);
    assert.equal((await checkInitAdminPassword('admin-Wq8vT3nR', 'admin')).code, 'password_contains_identity');
});

test('INIT_ADMIN_PASSWORD: generated passwords pass', async () => {
    // selfhost.sh: 20 alphanumerics, or 24 hex characters without openssl.
    assert.deepEqual(await checkInitAdminPassword('q7RkV2mXz9LpT4wHc8Nd', 'admin'), { ok: true });
    assert.deepEqual(await checkInitAdminPassword('9f2c4e7a1b8d3f6e0a5c2b9d', 'admin'), { ok: true });
});

test('a refused INIT_ADMIN_PASSWORD stops the process with a non-zero code', () => {
    const { stopOnRefusedInitAdminPassword } = require('./boot-init');
    /** @type {number[]} */
    const codes = [];
    stopOnRefusedInitAdminPassword({ code: 'password_too_short', error: 'too short' }, (c) => { codes.push(c); });
    assert.deepEqual(codes, [1]);
});
