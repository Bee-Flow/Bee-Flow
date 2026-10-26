// @typecheck
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sessionUser } = require('./sessionUser');

test('returns the session user', () => {
    const user = { id: 'u1', email: 'a@example.com' };
    assert.equal(sessionUser({ session: { user } }), user);
});

test('a request without a session user is a 401, not a TypeError', () => {
    for (const req of [{ session: {} }, {}]) {
        assert.throws(() => sessionUser(req), { status: 401, code: 'unauthorized' });
    }
});
