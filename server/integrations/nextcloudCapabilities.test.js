// @typecheck
/**
 * nextcloudCapabilities.mts: one capabilities read per user, shared by the
 * Talk recording probe and by tool assembly, and three answers per tool
 * family. Only "the read succeeded and the app, one that publishes a
 * capability, is not in it" reads as absent.
 *
 * Run: cd server && node --test integrations/nextcloudCapabilities.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

/** @type {{ status: number, body: unknown, fetches: number, uid: string, baseUrl: string, connected: boolean, throws: boolean, hold: Promise<void> | null }} */
const fx = { status: 200, body: null, fetches: 0, uid: 'alice', baseUrl: 'https://cloud.example.test', connected: true, throws: false, hold: null };

// The real nextcloudClient (it pulls the database in at load) over a recording
// pool; only its `resolveAuth` is replaced, which the module reads at call time.
require('../testUtils/routeHarness').recordDb();
const ncClient = require('./nextcloudClient');
const realResolveAuth = ncClient.resolveAuth;
test.after(() => { ncClient.resolveAuth = realResolveAuth; });
ncClient.resolveAuth = /** @type {any} */ (async () => {
    if (!fx.connected) throw new Error('Nextcloud not connected.');
    return {
        baseUrl: fx.baseUrl,
        uid: fx.uid,
        fetch: async (/** @type {string} */ url) => {
            fx.fetches++;
            assert.ok(url.endsWith('/ocs/v2.php/cloud/capabilities?format=json'));
            if (fx.hold) await fx.hold;
            if (fx.throws) throw new Error('fetch failed');
            return {
                ok: fx.status >= 200 && fx.status < 300,
                status: fx.status,
                text: async () => (typeof fx.body === 'string' ? fx.body : JSON.stringify(fx.body)),
            };
        },
    };
});

const {
    readNextcloudCapabilities, familyPresence, nextcloudFamilyPresence, _resetCapabilitiesCache,
} = require('./nextcloudCapabilities.mts');

/** @param {Record<string, unknown>} apps */
const answer = (apps) => ({ ocs: { meta: { status: 'ok' }, data: { version: { major: 34 }, capabilities: { core: { pollinterval: 60 }, dav: {}, ...apps } } } });

const FAMILIES_WITH_CAPABILITY = {
    'nextcloud-deck': 'deck',
    'nextcloud-talk': 'spreed',
    'nextcloud-notes': 'notes',
    'nextcloud-activity': 'activity',
    'nextcloud-tables': 'tables',
    'nextcloud-forms': 'forms',
    'nextcloud-teams': 'circles',
};
const FAMILIES_WITHOUT = ['nextcloud', 'nextcloud-calendar', 'nextcloud-contacts', 'nextcloud-tasks',
    'nextcloud-mail', 'nextcloud-notifications', 'nextcloud-status'];

test.beforeEach(() => {
    _resetCapabilitiesCache();
    Object.assign(fx, { status: 200, body: answer({}), fetches: 0, uid: 'alice', baseUrl: 'https://cloud.example.test', connected: true, throws: false, hold: null });
    delete process.env.NEXTCLOUD_CAPABILITIES_CACHE_SECONDS;
    delete process.env.NEXTCLOUD_CAPABILITIES_WAIT_MS;
});

test('present: the app capability is in a successful read', async () => {
    fx.body = answer({ deck: { version: '1.15.0' }, spreed: { features: [] }, notes: {}, activity: {}, tables: {}, forms: {}, circles: {} });
    const presence = await nextcloudFamilyPresence({}, 'u1');
    for (const family of Object.keys(FAMILIES_WITH_CAPABILITY)) assert.strictEqual(presence(family), 'present', family);
});

test('absent: the read succeeded and the app capability is not in it', async () => {
    fx.body = answer({ deck: { version: '1.15.0' } });
    const presence = await nextcloudFamilyPresence({}, 'u1');
    assert.strictEqual(presence('nextcloud-deck'), 'present');
    for (const family of Object.keys(FAMILIES_WITH_CAPABILITY)) {
        if (family !== 'nextcloud-deck') assert.strictEqual(presence(family), 'absent', family);
    }
});

test('unknown: Mail and the families without a capability to look for, whatever the read says', async () => {
    fx.body = answer({});
    const presence = await nextcloudFamilyPresence({}, 'u1');
    for (const family of FAMILIES_WITHOUT) assert.strictEqual(presence(family), 'unknown', family);
    assert.strictEqual(presence('not-a-family'), 'unknown');
});

test('a failed read is unknown for every family', async () => {
    for (const status of [401, 404, 500, 503]) {
        _resetCapabilitiesCache();
        fx.status = status;
        const read = await readNextcloudCapabilities({}, 'u1');
        assert.deepStrictEqual(read, { ok: false, capabilities: null }, String(status));
        for (const family of [...Object.keys(FAMILIES_WITH_CAPABILITY), ...FAMILIES_WITHOUT]) {
            assert.strictEqual(familyPresence(read, family), 'unknown', `${status} ${family}`);
        }
    }
});

test('a thrown request and a missing connection are unknown, and are not cached', async () => {
    fx.throws = true;
    let presence = await nextcloudFamilyPresence({}, 'u1');
    assert.strictEqual(presence('nextcloud-deck'), 'unknown');
    fx.throws = false;
    fx.body = answer({ deck: {} });
    presence = await nextcloudFamilyPresence({}, 'u1');
    assert.strictEqual(presence('nextcloud-deck'), 'present');
    assert.strictEqual(fx.fetches, 2);

    _resetCapabilitiesCache();
    fx.connected = false;
    presence = await nextcloudFamilyPresence({}, 'u1');
    assert.strictEqual(presence('nextcloud-forms'), 'unknown');
    assert.strictEqual(fx.fetches, 2, 'no request without a connection');
});

test('an answer that is not a capabilities document is unknown', async () => {
    for (const body of ['<html>Sign in</html>', { ocs: { data: {} } }, { ocs: { data: { capabilities: [] } } }, { ocs: { data: { capabilities: { deck: {} } } } }]) {
        _resetCapabilitiesCache();
        fx.body = body;
        const presence = await nextcloudFamilyPresence({}, 'u1');
        assert.strictEqual(presence('nextcloud-forms'), 'unknown', JSON.stringify(body));
    }
    assert.strictEqual(familyPresence(null, 'nextcloud-deck'), 'unknown');
});

test('a successful read is cached per user for ten minutes', async (t) => {
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    t.after(() => { Date.now = realNow; });

    fx.body = answer({ deck: {} });
    await readNextcloudCapabilities({}, 'u1');
    now += 9 * 60_000;
    fx.body = answer({});
    assert.strictEqual(familyPresence(await readNextcloudCapabilities({}, 'u1'), 'nextcloud-deck'), 'present');
    assert.strictEqual(fx.fetches, 1);

    fx.uid = 'bob';
    assert.strictEqual(familyPresence(await readNextcloudCapabilities({}, 'u2'), 'nextcloud-deck'), 'absent');
    assert.strictEqual(fx.fetches, 2, 'another user is asked separately');

    fx.uid = 'alice';
    now += 2 * 60_000;
    assert.strictEqual(familyPresence(await readNextcloudCapabilities({}, 'u1'), 'nextcloud-deck'), 'absent');
    assert.strictEqual(fx.fetches, 3, 'asked again after ten minutes');
});

test('a failed read is held for thirty seconds only', async (t) => {
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    t.after(() => { Date.now = realNow; });

    fx.status = 503;
    await readNextcloudCapabilities({}, 'u1');
    now += 10_000;
    await readNextcloudCapabilities({}, 'u1');
    assert.strictEqual(fx.fetches, 1);
    fx.status = 200;
    fx.body = answer({ notes: {} });
    now += 25_000;
    assert.strictEqual(familyPresence(await readNextcloudCapabilities({}, 'u1'), 'nextcloud-notes'), 'present');
    assert.strictEqual(fx.fetches, 2);
});

test('the cache time is configurable; 0 reads every time', async (t) => {
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    t.after(() => { Date.now = realNow; });

    process.env.NEXTCLOUD_CAPABILITIES_CACHE_SECONDS = '60';
    await readNextcloudCapabilities({}, 'u1');
    now += 61_000;
    await readNextcloudCapabilities({}, 'u1');
    assert.strictEqual(fx.fetches, 2);

    process.env.NEXTCLOUD_CAPABILITIES_CACHE_SECONDS = '0';
    _resetCapabilitiesCache();
    await readNextcloudCapabilities({}, 'u1');
    await readNextcloudCapabilities({}, 'u1');
    assert.strictEqual(fx.fetches, 4);
    fx.status = 503;
    await readNextcloudCapabilities({}, 'u1');
    await readNextcloudCapabilities({}, 'u1');
    assert.strictEqual(fx.fetches, 6, 'a failed read is not held either');
});

test('callers at the same moment share one request', async () => {
    /** @type {() => void} */
    let release = () => {};
    fx.hold = new Promise((resolve) => { release = resolve; });
    fx.body = answer({ tables: {} });
    const both = Promise.all([readNextcloudCapabilities({}, 'u1'), readNextcloudCapabilities({}, 'u1')]);
    await new Promise((resolve) => setImmediate(resolve));
    release();
    const [a, b] = await both;
    assert.strictEqual(fx.fetches, 1);
    assert.strictEqual(a, b);
});

test('a slow read is unknown for this call and answers the next one from the cache', async () => {
    process.env.NEXTCLOUD_CAPABILITIES_WAIT_MS = '20';
    /** @type {() => void} */
    let release = () => {};
    fx.hold = new Promise((resolve) => { release = resolve; });
    fx.body = answer({ deck: {} });
    const slow = await nextcloudFamilyPresence({}, 'u1');
    assert.strictEqual(slow('nextcloud-forms'), 'unknown');
    release();
    fx.hold = null;
    await new Promise((resolve) => setTimeout(resolve, 10));
    const next = await nextcloudFamilyPresence({}, 'u1');
    assert.strictEqual(next('nextcloud-forms'), 'absent');
    assert.strictEqual(next('nextcloud-deck'), 'present');
    assert.strictEqual(fx.fetches, 1);
});
