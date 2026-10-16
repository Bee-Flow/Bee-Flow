/**
 * meetingPrefsOptIn: which users have a live explicit "record" mark.
 * The db and the prefs store are injected through init(); the fake db applies the same
 * rule as the SQL so a changed query shows up here.
 *
 * Run: cd server && node --test stores/meetingPrefsOptIn.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const table = [];
const optIn = require('./meetingPrefsOptIn');
optIn.init({
    prefs: { PROVIDERS: ['talk', 'gmeet', 'teams'], initDB: async () => {} },
    getAll: async (sql, params) => {
        assert.match(sql.replace(/\s+/g, ' '), /record = TRUE AND \(id_kind = 'code' OR updated_at > NOW\(\) - INTERVAL '10 days'\)/);
        const floor = Date.now() - 10 * 86400_000;
        const ids = table.filter(r => r.provider === params[0] && r.user_id !== '' && r.record === true
            && (r.id_kind === 'code' || new Date(r.updated_at).getTime() > floor)).map(r => r.user_id);
        return Array.from(new Set(ids)).map(user_id => ({ user_id }));
    },
});
const ago = (days) => new Date(Date.now() - days * 86400_000).toISOString();
const row = (over) => ({ provider: 'teams', id_kind: 'event', user_id: 'u', record: true, updated_at: ago(1), ...over });

test('only personal record=true rows of that provider, series always, events for 10 days', async () => {
    table.push(
        row({ user_id: 'fresh' }),
        row({ user_id: 'stale', updated_at: ago(30) }),
        row({ user_id: 'series', id_kind: 'code', updated_at: ago(30) }),
        row({ user_id: 'no', record: false }),
        row({ user_id: '' }),
        row({ user_id: 'other', provider: 'gmeet' }),
    );
    assert.deepEqual((await optIn.listUsersWithRecordOptIn({ provider: 'teams' })).sort(), ['fresh', 'series']);
    assert.deepEqual(await optIn.listUsersWithRecordOptIn({ provider: 'nope' }), []);
});

test('hasLiveRecordOptIn applies the same rule to loaded rows', () => {
    const r = (o) => ({ userId: 'u', idKind: 'event', record: true, updatedAt: ago(1), ...o });
    assert.equal(optIn.hasLiveRecordOptIn([r({})]), true);
    assert.equal(optIn.hasLiveRecordOptIn([r({ updatedAt: ago(30) })]), false);
    assert.equal(optIn.hasLiveRecordOptIn([r({ updatedAt: ago(30), idKind: 'code' })]), true);
    assert.equal(optIn.hasLiveRecordOptIn([r({ userId: null })]), false);
    assert.equal(optIn.hasLiveRecordOptIn([r({ record: false })]), false);
    assert.equal(optIn.hasLiveRecordOptIn([]), false);
});
