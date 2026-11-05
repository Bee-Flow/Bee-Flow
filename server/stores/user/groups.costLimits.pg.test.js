// @typecheck strict
/**
 * groups.getCostLimitInputs, the read behind the self-hosted monthly AI budget,
 * against a real Postgres (pglite): the user's own limit plus the per-member
 * limits of the groups they belong to (groups without a limit are left out).
 *
 * Run: cd server && node --test stores/user/groups.costLimits.pg.test.js
 */

process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const { usePglitePool } = require('../../testUtils/pglitePool');

const { pg, close } = usePglitePool();
const groups = require('./groups');

before(async () => {
    await pg.exec(`
        CREATE TABLE users (id TEXT PRIMARY KEY, groups TEXT DEFAULT '[]', monthly_cost_limit REAL);
        CREATE TABLE groups (id TEXT PRIMARY KEY, per_user_cost_limit REAL);
        INSERT INTO groups (id, per_user_cost_limit) VALUES ('small', 10), ('big', 40.5), ('none', NULL), ('other', 99);
        INSERT INTO users (id, groups, monthly_cost_limit) VALUES
            ('own', '["small","none"]', 7.5),
            ('member', '["small","big","none"]', NULL),
            ('loner', '[]', NULL);
    `);
});
after(() => close());

test('returns the own limit and the limits of the user\'s groups only', async () => {
    assert.deepEqual(await groups.getCostLimitInputs('own'), { userLimit: 7.5, groupLimits: [10] });
    const member = await groups.getCostLimitInputs('member');
    assert.equal(member.userLimit, null);
    assert.deepEqual([...member.groupLimits].sort((a, b) => a - b), [10, 40.5]);
});

test('a user without groups has no group limits, an unknown user has no limits', async () => {
    assert.deepEqual(await groups.getCostLimitInputs('loner'), { userLimit: null, groupLimits: [] });
    assert.deepEqual(await groups.getCostLimitInputs('nobody'), { userLimit: null, groupLimits: [] });
});
