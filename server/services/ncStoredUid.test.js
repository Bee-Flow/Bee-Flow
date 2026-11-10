'use strict';
/**
 * services/ncStoredUid.mts: is a stored Nextcloud uid still a live account
 * with a given e-mail address? The proxy call is passed in.
 *
 * Run: node --test server/services/ncStoredUid.test.js
 */
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const { storedUidIsLiveWithEmail, resetStoredUidCache, conflictCacheMs, conflictWaitMs } = require('./ncStoredUid.mts');
const { resetSightings, ADMIN_RIGHTS_MISSING } = require('./ncAccountState.mts');
const orgHealth = require('./orgHealth');
const log = require('../telemetry/log');

const ORG = { id: 'org-1', nc_admin_uid: 'root' };
const EMAIL = 'ann@example.org';
const record = (data) => ({ ocs: { data } });
let calls;
const answering = (body) => async (org, path, uid) => { calls.push({ org: org.id, path, uid }); return typeof body === 'function' ? body() : body; };

let health;
let warns;
const usual = { problem: orgHealth.problem, resolve: orgHealth.resolve, warn: log.warn };
after(() => { Object.assign(orgHealth, { problem: usual.problem, resolve: usual.resolve }); log.warn = usual.warn; });

beforeEach(() => {
    calls = [];
    health = { problems: [], resolved: [] };
    warns = [];
    orgHealth.problem = (code, opts) => { health.problems.push({ code, orgId: opts.orgId, source: opts.source, meta: opts.meta }); };
    orgHealth.resolve = (orgId, codes) => { health.resolved.push({ orgId, codes }); };
    log.warn = (m) => { warns.push(String(m)); };
    resetSightings();
    resetStoredUidCache();
    delete process.env.NEXTCLOUD_UID_CONFLICT_CACHE_SECONDS;
    delete process.env.NEXTCLOUD_UID_CONFLICT_WAIT_MS;
});

test('yes: the record is about the uid, enabled, and carries the address', async () => {
    const live = await storedUidIsLiveWithEmail(ORG, 'ann', EMAIL, answering(record({ id: 'ann', enabled: true, email: 'Ann@Example.org' })));
    assert.equal(live, true);
    assert.deepEqual(calls, [{ org: 'org-1', path: '/ocs/v2.php/cloud/users/ann?format=json', uid: 'root' }]);
});

test('the uid is encoded into the path', async () => {
    await storedUidIsLiveWithEmail(ORG, 'a b/c@d', EMAIL, answering(record({})));
    assert.equal(calls[0].path, '/ocs/v2.php/cloud/users/a%20b%2Fc%40d?format=json');
});

test('no: disabled, another address, no address, another uid, no enabled flag, other shapes', async () => {
    const answers = [
        record({ id: 'ann', enabled: false, email: EMAIL }),
        record({ id: 'ann', enabled: true, email: 'bob@example.org' }),
        record({ id: 'ann', enabled: true }),
        record({ id: 'ann', enabled: true, email: '' }),
        record({ id: 'bob', enabled: true, email: EMAIL }),
        record({ id: 'Ann', enabled: true, email: EMAIL }),
        record({ id: 'ann', email: EMAIL }),
        record({ id: 'ann', enabled: 'yes', email: EMAIL }),
        record([]), record(null), {}, null, undefined, 'text',
    ];
    for (const body of answers) {
        assert.equal(await storedUidIsLiveWithEmail(ORG, 'ann', EMAIL, answering(body)), false, JSON.stringify(body));
    }
});

test('no, and never a throw: a read that fails', async () => {
    const failing = async () => { throw Object.assign(new Error('NC proxy HTTP 404'), { status: 404 }); };
    assert.equal(await storedUidIsLiveWithEmail(ORG, 'ann', EMAIL, failing), false);
});

test('no, without a read: no organisation, no stored admin, no uid, no address', async () => {
    const fetchAs = answering(record({ id: 'ann', enabled: true, email: EMAIL }));
    assert.equal(await storedUidIsLiveWithEmail(null, 'ann', EMAIL, fetchAs), false);
    assert.equal(await storedUidIsLiveWithEmail({ nc_admin_uid: 'root' }, 'ann', EMAIL, fetchAs), false);
    assert.equal(await storedUidIsLiveWithEmail({ id: 'org-1' }, 'ann', EMAIL, fetchAs), false);
    assert.equal(await storedUidIsLiveWithEmail(ORG, '', EMAIL, fetchAs), false);
    assert.equal(await storedUidIsLiveWithEmail(ORG, 'ann', '', fetchAs), false);
    assert.deepEqual(calls, []);
});

test('a yes is remembered per organisation, uid and address; a no is not', async () => {
    const yes = answering(record({ id: 'ann', enabled: true, email: EMAIL }));
    assert.equal(await storedUidIsLiveWithEmail(ORG, 'ann', EMAIL, yes), true);
    assert.equal(await storedUidIsLiveWithEmail(ORG, 'ann', EMAIL, yes), true);
    assert.equal(calls.length, 1);
    // Another organisation, uid or address is its own question.
    await storedUidIsLiveWithEmail({ ...ORG, id: 'org-2' }, 'ann', EMAIL, yes);
    await storedUidIsLiveWithEmail(ORG, 'ann2', EMAIL, yes);
    await storedUidIsLiveWithEmail(ORG, 'ann', 'other@example.org', yes);
    assert.equal(calls.length, 4);

    resetStoredUidCache(); calls = [];
    const no = answering(record({ id: 'ann', enabled: false, email: EMAIL }));
    await storedUidIsLiveWithEmail(ORG, 'ann', EMAIL, no);
    await storedUidIsLiveWithEmail(ORG, 'ann', EMAIL, no);
    assert.equal(calls.length, 2);
});

test('NEXTCLOUD_UID_CONFLICT_CACHE_SECONDS: default 60, 0 remembers nothing', async () => {
    assert.equal(conflictCacheMs(), 60000);
    process.env.NEXTCLOUD_UID_CONFLICT_CACHE_SECONDS = '0';
    assert.equal(conflictCacheMs(), 0);
    const yes = answering(record({ id: 'ann', enabled: true, email: EMAIL }));
    await storedUidIsLiveWithEmail(ORG, 'ann', EMAIL, yes);
    await storedUidIsLiveWithEmail(ORG, 'ann', EMAIL, yes);
    assert.equal(calls.length, 2);
    process.env.NEXTCLOUD_UID_CONFLICT_CACHE_SECONDS = 'nonsense';
    assert.equal(conflictCacheMs(), 60000);
});

test('NEXTCLOUD_UID_CONFLICT_WAIT_MS: default 5000; past the wait the answer is no and nothing is remembered; 0 waits', async () => {
    assert.equal(conflictWaitMs(), 5000);
    process.env.NEXTCLOUD_UID_CONFLICT_WAIT_MS = '15';
    let release;
    const slow = answering(() => new Promise((resolve) => { release = () => resolve(record({ id: 'ann', enabled: true, email: EMAIL })); }));
    assert.equal(await storedUidIsLiveWithEmail(ORG, 'ann', EMAIL, slow), false);
    release();
    await new Promise((resolve) => setImmediate(resolve));
    const quick = answering(record({ id: 'ann', enabled: false, email: EMAIL }));
    assert.equal(await storedUidIsLiveWithEmail(ORG, 'ann', EMAIL, quick), false, 'the late yes was not remembered');

    process.env.NEXTCLOUD_UID_CONFLICT_WAIT_MS = '0';
    const delayed = answering(() => new Promise((resolve) => setTimeout(() => resolve(record({ id: 'ann', enabled: true, email: EMAIL })), 30)));
    assert.equal(await storedUidIsLiveWithEmail(ORG, 'ann', EMAIL, delayed), true);
});

// ── Nextcloud cannot say, and will not until someone acts ───────────────────

const problemOf = (orgId, reason) => ({ code: ADMIN_RIGHTS_MISSING, orgId, source: 'ncStoredUid', meta: { reason } });

test('a record without the enabled flag: no, and the organisation is told once that its stored admin lacks administrator rights', async () => {
    const noFlag = answering(record({ id: 'ann', email: EMAIL }));
    assert.equal(await storedUidIsLiveWithEmail(ORG, 'ann', EMAIL, noFlag), false);
    assert.equal(await storedUidIsLiveWithEmail(ORG, 'ann', EMAIL, noFlag), false);
    assert.equal(await storedUidIsLiveWithEmail(ORG, 'bea', EMAIL, answering(record({ id: 'bea', email: EMAIL }))), false);
    assert.deepEqual(health.problems, [problemOf('org-1', 'enabled_not_reported')]);
    assert.equal(warns.length, 1);
    assert.match(warns[0], /stored uid not checked for org org-1: .*no administrator rights/);
    assert.ok(!warns[0].includes(EMAIL) && !warns[0].includes('ann'), 'the line names no account');
    // Another organisation gets its own row.
    await storedUidIsLiveWithEmail({ ...ORG, id: 'org-2' }, 'ann', EMAIL, noFlag);
    assert.deepEqual(health.problems.map((p) => p.orgId), ['org-1', 'org-2']);
});

test('an organisation without a stored admin: no, without a read, and it is told once', async () => {
    const fetchAs = answering(record({ id: 'ann', enabled: true, email: EMAIL }));
    assert.equal(await storedUidIsLiveWithEmail({ id: 'org-3' }, 'ann', EMAIL, fetchAs), false);
    assert.equal(await storedUidIsLiveWithEmail({ id: 'org-3' }, 'ann', EMAIL, fetchAs), false);
    assert.deepEqual(calls, []);
    assert.deepEqual(health.problems, [problemOf('org-3', 'no_stored_admin')]);
    assert.equal(warns.length, 1);
});

test('answers about the account itself, a failed read and other shapes open nothing', async () => {
    const answers = [
        record({ id: 'ann', enabled: false, email: EMAIL }),
        record({ id: 'ann', enabled: true, email: 'bob@example.org' }),
        record({ id: 'bob', email: EMAIL }),
        record({ id: 'ann', enabled: 'yes', email: EMAIL }),
        record([]), record(null), {}, null,
    ];
    for (const body of answers) await storedUidIsLiveWithEmail(ORG, 'ann', EMAIL, answering(body));
    await storedUidIsLiveWithEmail(ORG, 'ann', EMAIL, async () => { throw new Error('NC proxy HTTP 503'); });
    assert.deepEqual(health.problems, []);
    assert.deepEqual(health.resolved, []);
});

test('once Nextcloud reports the flag again, what was reported is resolved, once', async () => {
    await storedUidIsLiveWithEmail(ORG, 'ann', EMAIL, answering(record({ id: 'ann', email: EMAIL })));
    assert.equal(health.problems.length, 1);
    const withFlag = answering(record({ id: 'ann', enabled: false, email: EMAIL }));
    await storedUidIsLiveWithEmail(ORG, 'ann', EMAIL, withFlag);
    await storedUidIsLiveWithEmail(ORG, 'ann', EMAIL, withFlag);
    assert.deepEqual(health.resolved, [{ orgId: 'org-1', codes: [ADMIN_RIGHTS_MISSING] }]);
    // And it is reported again when the flag goes missing again.
    await storedUidIsLiveWithEmail(ORG, 'ann', EMAIL, answering(record({ id: 'ann', email: EMAIL })));
    assert.equal(health.problems.length, 2);
});

test('the health code is in the catalogue as a warning', () => {
    const def = orgHealth.CODES[ADMIN_RIGHTS_MISSING];
    assert.equal(def.severity, 'warning');
    assert.equal(def.category, 'connector');
});
