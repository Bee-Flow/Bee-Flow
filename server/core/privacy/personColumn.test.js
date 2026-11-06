'use strict';
/**
 * The person column of the Quality lists: pseudonymous by default, the same
 * label as the Adoption tab, names only after an audit row that was written.
 *
 * Run: cd server && node --test core/privacy/personColumn.test.js
 */

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'x'.repeat(40);

const test = require('node:test');
const assert = require('node:assert/strict');
const pseudonym = require('./pseudonym');
const { withPersonColumn } = require('./personColumn');
const { QUALITY_REVEAL_ACTION } = require('../../stores/adoption/audit');

const SECRET = process.env.SESSION_SECRET;

function makeDeps({ failAudit = false } = {}) {
    const calls = { audit: [], lookups: [] };
    return {
        calls,
        deps: {
            pseudonym,
            db: { run: async (sql, params) => { if (failAudit) throw new Error('db down'); calls.audit.push({ sql, params }); } },
            userStore: {
                getUserAvatarsByIds: async (ids) => {
                    calls.lookups.push(ids);
                    return [{ id: 'u1', username: 'kim', displayName: 'Kim Jansen', avatarType: 'emoji', avatar: '🐝' }];
                },
            },
        },
    };
}

const ROWS = () => [{ id: 'a', user_id: 'u1', x: 1 }, { id: 'b', user_id: null, x: 2 }, { id: 'c', user_id: 'u1', x: 3 }];

test('by default a row carries the Adoption pseudonym and no user id', async () => {
    const { deps, calls } = makeDeps();
    const out = await withPersonColumn(ROWS(), { orgId: 'o1', actorId: 'admin', reveal: false }, deps);
    assert.deepEqual(out[0].person, {
        id: pseudonym.pseudonymId('u1', 'o1', SECRET),
        name: pseudonym.pseudonymFor('u1', 'o1', SECRET),
    });
    assert.match(out[0].person.name, /^Member · [A-Z2-9]{4}$/);
    assert.equal(out[2].person.name, out[0].person.name);
    assert.equal(out[1].person, null);
    for (const r of out) assert.equal('user_id' in r, false);
    assert.equal(out[0].x, 1);
    assert.equal(calls.audit.length, 0);
    assert.equal(calls.lookups.length, 0);
});

test('the label is scoped to the organisation', async () => {
    const { deps } = makeDeps();
    const a = await withPersonColumn([{ user_id: 'u1' }], { orgId: 'o1', actorId: 'admin', reveal: false }, deps);
    const b = await withPersonColumn([{ user_id: 'u1' }], { orgId: 'o2', actorId: 'admin', reveal: false }, deps);
    assert.notEqual(a[0].person.id, b[0].person.id);
});

test('a reveal writes the audit row first, then names the people', async () => {
    const { deps, calls } = makeDeps();
    const out = await withPersonColumn(ROWS(), { orgId: 'o1', actorId: 'admin', reveal: true, startDate: 's', endDate: 'e' }, deps);
    assert.equal(calls.audit.length, 1);
    const [, action, orgId, actorId, payload] = calls.audit[0].params;
    assert.equal(action, QUALITY_REVEAL_ACTION);
    assert.equal(action, 'usage_quality_people_revealed');
    assert.equal(orgId, 'o1');
    assert.equal(actorId, 'admin');
    assert.deepEqual(JSON.parse(payload), { startDate: 's', endDate: 'e', group: null, limit: 3 });
    assert.deepEqual(calls.lookups, [['u1']]);
    assert.deepEqual(out[0].person, { id: 'u1', name: 'Kim Jansen', avatar: '🐝', avatarType: 'emoji' });
    assert.equal(out[1].person, null);
    for (const r of out) assert.equal('user_id' in r, false);
});

test('a failed audit write refuses with 503 audit_unavailable and looks nobody up', async () => {
    const { deps, calls } = makeDeps({ failAudit: true });
    await assert.rejects(
        withPersonColumn(ROWS(), { orgId: 'o1', actorId: 'admin', reveal: true }, deps),
        (err) => err.status === 503 && err.code === 'audit_unavailable' && !/Kim|u1/.test(err.message),
    );
    assert.equal(calls.lookups.length, 0);
});

test('an unknown user keeps the id as its name rather than inventing one', async () => {
    const { deps } = makeDeps();
    const out = await withPersonColumn([{ user_id: 'gone' }], { orgId: 'o1', actorId: 'admin', reveal: true }, deps);
    assert.deepEqual(out[0].person, { id: 'gone', name: 'gone' });
});

test('an oversized avatar is not sent inline', async () => {
    const { deps } = makeDeps();
    deps.userStore.getUserAvatarsByIds = async () => [{ id: 'u1', displayName: 'Kim', avatar: 'x'.repeat(5000) }];
    const out = await withPersonColumn([{ user_id: 'u1' }], { orgId: 'o1', actorId: 'admin', reveal: true }, deps);
    assert.equal('avatar' in out[0].person, false);
});
