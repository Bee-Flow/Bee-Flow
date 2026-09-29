/**
 * signupGuards — geo policy evaluation.
 *
 * configStore and serverGeoResolver are pre-mocked via the require cache so no
 * DB and no outbound geo lookup are needed.
 *
 * The point of interest here is the private-IP branch. It exists so dev and
 * self-hosted internal networks are never geo-blocked, but it doubles as this
 * policy's silent failure mode: behind a load balancer that does not carry the
 * client address through, every visitor arrives as an RFC1918 address and an
 * enabled allow/blocklist permits all of them while looking like it works.
 */

const test = require('node:test');
const assert = require('node:assert');

function mock(relPath, exports) {
    const resolved = require.resolve(relPath);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

mock('../stores/configStore', {
    getConfig: async () => null,
    setConfig: async () => {},
    getSecret: async () => '',
    setSecret: async () => {},
});

// signupGuards destructures geoFromIp at require time, so the behaviour has to
// be switchable from INSIDE this function — reassigning the property afterwards
// would not reach the captured reference.
let geoResult = null;
let geoThrows = false;
let geoCalls = [];
mock('../stores/serverGeoResolver', {
    geoFromIp: async (ip) => {
        geoCalls.push(ip);
        if (geoThrows) throw new Error('lookup exploded');
        return geoResult;
    },
    EU_EEA: new Set(),
});

const guards = require('./signupGuards');

const ALLOWLIST_NL = { geoMode: 'allowlist', geoCountries: ['NL'], geoBlockUnknown: true };
const BLOCKLIST_AF = { geoMode: 'blocklist', geoCountries: ['AF'], geoBlockUnknown: false };

test.beforeEach(() => { geoCalls = []; geoResult = null; geoThrows = false; });

test('geoMode off short-circuits without a lookup', async () => {
    const r = await guards.evaluateGeo('81.204.1.1', { geoMode: 'off', geoCountries: [] });
    assert.deepEqual(r, { allowed: true, country: null });
    assert.equal(geoCalls.length, 0);
});

test('allowlist permits a listed country and blocks an unlisted one', async () => {
    geoResult = { country_code: 'NL' };
    assert.equal((await guards.evaluateGeo('81.204.1.1', ALLOWLIST_NL)).allowed, true);
    geoResult = { country_code: 'DE' };
    assert.equal((await guards.evaluateGeo('81.204.1.1', ALLOWLIST_NL)).allowed, false);
});

test('blocklist blocks a listed country', async () => {
    geoResult = { country_code: 'AF' };
    assert.equal((await guards.evaluateGeo('81.204.1.1', BLOCKLIST_AF)).allowed, false);
    geoResult = { country_code: 'NL' };
    assert.equal((await guards.evaluateGeo('81.204.1.1', BLOCKLIST_AF)).allowed, true);
});

test('an unresolvable country honours geoBlockUnknown', async () => {
    geoResult = {};
    assert.equal((await guards.evaluateGeo('81.204.1.1', ALLOWLIST_NL)).allowed, false, 'blockUnknown: true → deny');
    assert.equal((await guards.evaluateGeo('81.204.1.1', BLOCKLIST_AF)).allowed, true, 'blockUnknown: false → allow');
});

// The regression that matters. 172.16.16.5 is what the Scaleway load balancer
// presents as the peer when PROXY protocol is off, so this was every visitor.
test('a load-balancer private IP is allowed through even with an allowlist active', async () => {
    const r = await guards.evaluateGeo('172.16.16.5', ALLOWLIST_NL);
    assert.deepEqual(r, { allowed: true, country: null });
    assert.equal(geoCalls.length, 0, 'no lookup is attempted for a private address');
});

test('isPrivateIp covers the ranges a proxy actually presents', async () => {
    for (const ip of ['172.16.16.5', '172.31.255.254', '10.0.0.1', '192.168.1.1', '127.0.0.1',
        '169.254.1.1', '::1', 'fd00::1', 'fe80::1', '', null]) {
        assert.equal(guards.isPrivateIp(ip), true, `${ip} should be treated as private/unknown`);
    }
    for (const ip of ['81.204.1.1', '8.8.8.8', '172.15.0.1', '172.32.0.1', '100.64.0.1']) {
        assert.equal(guards.isPrivateIp(ip), false, `${ip} should be treated as public`);
    }
});

test('a geo lookup failure fails OPEN rather than locking out signups', async () => {
    geoThrows = true;
    const r = await guards.evaluateGeo('81.204.1.1', ALLOWLIST_NL);
    assert.equal(geoCalls.length, 1, 'the lookup was genuinely attempted');
    assert.deepEqual(r, { allowed: true, country: null });
});

// ═══════════════════════════════════════════════════════════════════
// Login-time status gates — approval vs. verification
//
// Regression cover for the 2026-08-10 pentest finding. The two gates had a
// shared predicate, so the org-founder exemption from APPROVAL silently also
// exempted founders from EMAIL VERIFICATION. Anyone could sign up with an
// address they did not own, be made org_admin by accountProvisioning, and log
// in without ever proving the address — account squatting, and enabling the
// verification toggle would not have stopped it.
// ═══════════════════════════════════════════════════════════════════

const ORG_FOUNDER = { id: 'founder', role: 'user', orgRole: 'org_admin' };
const PLAIN_MEMBER = { id: 'member', role: 'user', orgRole: 'member' };
const SYSTEM_ADMIN = { id: 'root', role: 'admin', orgRole: '' };

test('an org founder skips APPROVAL — nobody exists to approve them', () => {
    assert.equal(guards.canSkipApproval(ORG_FOUNDER), true);
});

test('an org founder does NOT skip EMAIL VERIFICATION — the pentest hole', () => {
    assert.equal(
        guards.canSkipEmailVerification(ORG_FOUNDER), false,
        'a self-registered founder must prove the address before the account is usable',
    );
});

test('a plain member skips neither gate', () => {
    assert.equal(guards.canSkipApproval(PLAIN_MEMBER), false);
    assert.equal(guards.canSkipEmailVerification(PLAIN_MEMBER), false);
});

test('a system admin skips both', () => {
    assert.equal(guards.canSkipApproval(SYSTEM_ADMIN), true);
    assert.equal(guards.canSkipEmailVerification(SYSTEM_ADMIN), true);
});

test('the session isAdmin flag alone is enough for a system admin', () => {
    assert.equal(guards.canSkipEmailVerification({ id: 'x', role: 'user' }, true), true);
    assert.equal(guards.canSkipEmailVerification({ id: 'x', role: 'user' }, false), false);
});

test('the two gates are not the same predicate', () => {
    // If a refactor ever collapses them again, this fails immediately.
    assert.notEqual(
        guards.canSkipApproval(ORG_FOUNDER),
        guards.canSkipEmailVerification(ORG_FOUNDER),
        'approval and verification must diverge for an org founder',
    );
});

test('a missing or malformed user row skips nothing', () => {
    for (const bad of [null, undefined, {}, { role: 'user' }]) {
        assert.equal(guards.canSkipApproval(bad), false);
        assert.equal(guards.canSkipEmailVerification(bad), false);
    }
});
