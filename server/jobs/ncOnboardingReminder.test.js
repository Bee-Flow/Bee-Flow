/**
 * Unit tests for the NC onboarding-incomplete reminder job.
 *
 * All stores are stubbed via require.cache (no DB): userStore (org list +
 * audit spy), configStore (in-memory marker map), notificationStore
 * (delivery spy, failure toggle) and db (org-admin lookup).
 *
 * Verifies eligibility (bound + incomplete + >3d), the 7-day configStore
 * dedup marker (only advanced after a real delivery), per-admin fan-out,
 * the metadata-only audit row, and the never-throws contract.
 *
 * Run: node --test server/jobs/ncOnboardingReminder.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

process.env.NODE_ENV = 'test';

function mock(request, exports) {
    const p = require.resolve(request);
    require.cache[p] = new Module(p);
    require.cache[p].exports = exports;
    require.cache[p].loaded = true;
}

const NOW = Date.parse('2026-07-23T12:00:00Z');
const daysAgo = (n) => new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString();

// ── State + stubs ───────────────────────────────────────────────────────────
const state = {
    orgs: [],
    adminsByOrg: {},
    config: new Map(),
    notifications: [],
    audits: [],
    orgListThrows: false,
    notifyThrows: false,
};
function reset() {
    state.orgs = [];
    state.adminsByOrg = {};
    state.config = new Map();
    state.notifications = [];
    state.audits = [];
    state.orgListThrows = false;
    state.notifyThrows = false;
}

mock('../stores/userStore', {
    getAllOrganizations: async () => {
        if (state.orgListThrows) throw new Error('db down');
        return state.orgs;
    },
    logAccessAudit: async (...args) => { state.audits.push(args); },
});
mock('../stores/configStore', {
    getConfig: async (key) => (state.config.has(key) ? state.config.get(key) : null),
    setConfig: async (key, value) => { state.config.set(key, value); },
});
mock('../stores/notificationStore', {
    createNotification: async (n) => {
        if (state.notifyThrows) throw new Error('notify down');
        state.notifications.push(n);
        return { id: 'n' + state.notifications.length };
    },
});
mock('../db', {
    getAll: async (sql, params) => state.adminsByOrg[params[0]] || [],
});

const { run, _isEligible, MARKER_PREFIX } = require('./ncOnboardingReminder');

const ncOrg = (over = {}) => ({
    id: 'org-1',
    name: 'Stalled BV',
    nc_instance_id: 'inst-1',
    nc_onboarding_completed_at: null,
    nc_provisioned_at: daysAgo(5),
    ...over,
});

test.beforeEach(reset);

test('eligible org: notifies every admin, writes audit, sets the dedup marker', async () => {
    state.orgs = [ncOrg()];
    state.adminsByOrg['org-1'] = [{ id: 'a1' }, { id: 'a2' }];

    const res = await run({ now: NOW });
    assert.equal(res.notified, 1);
    assert.equal(state.notifications.length, 2);
    assert.deepEqual(state.notifications.map(n => n.userId).sort(), ['a1', 'a2']);
    const n = state.notifications[0];
    assert.equal(n.category, 'urgent');
    assert.ok(n.message.includes('5 days ago'));
    assert.ok(n.message.includes('Stalled BV'));
    assert.equal(n.link, '/app');

    // Metadata-only audit row with the exact contract shape.
    assert.equal(state.audits.length, 1);
    const [action, targetType, targetId, changedBy, oldV, newV, orgId] = state.audits[0];
    assert.equal(action, 'nc_onboarding_reminder_sent');
    assert.equal(targetType, 'organization');
    assert.equal(targetId, 'org-1');
    assert.equal(changedBy, 'system:onboarding_reminder');
    assert.equal(oldV, null);
    assert.deepEqual(newV, { daysSinceProvision: 5 });
    assert.equal(orgId, 'org-1');

    // Marker advanced to "now".
    assert.equal(state.config.get(`${MARKER_PREFIX}org-1`), new Date(NOW).toISOString());
});

test('dedup: marker < 7 days old skips; >= 7 days re-notifies', async () => {
    state.orgs = [ncOrg()];
    state.adminsByOrg['org-1'] = [{ id: 'a1' }];

    state.config.set(`${MARKER_PREFIX}org-1`, daysAgo(2));
    let res = await run({ now: NOW });
    assert.equal(res.notified, 0);
    assert.equal(res.skipped, 1);
    assert.equal(state.notifications.length, 0);

    state.config.set(`${MARKER_PREFIX}org-1`, daysAgo(8));
    res = await run({ now: NOW });
    assert.equal(res.notified, 1);
    assert.equal(state.notifications.length, 1);
});

test('not eligible: too fresh, completed, unbound, or never provisioned', async () => {
    state.orgs = [
        ncOrg({ id: 'fresh', nc_provisioned_at: daysAgo(1) }),
        ncOrg({ id: 'done', nc_onboarding_completed_at: daysAgo(1) }),
        ncOrg({ id: 'unbound', nc_instance_id: null }),
        ncOrg({ id: 'noprov', nc_provisioned_at: null }),
    ];
    state.adminsByOrg = { fresh: [{ id: 'a' }], done: [{ id: 'a' }], unbound: [{ id: 'a' }], noprov: [{ id: 'a' }] };
    const res = await run({ now: NOW });
    assert.equal(res.checked, 0);
    assert.equal(state.notifications.length, 0);
    assert.equal(state.audits.length, 0);
});

test('_isEligible boundary: exactly 3 days is NOT eligible, just over is', () => {
    assert.equal(_isEligible(ncOrg({ nc_provisioned_at: daysAgo(3) }), NOW), false);
    assert.equal(_isEligible(ncOrg({ nc_provisioned_at: new Date(NOW - (3 * 24 * 60 * 60 * 1000 + 1000)).toISOString() }), NOW), true);
});

test('org without admins: skipped, marker NOT set (retry next tick)', async () => {
    state.orgs = [ncOrg()];
    state.adminsByOrg['org-1'] = [];
    const res = await run({ now: NOW });
    assert.equal(res.notified, 0);
    assert.equal(res.skipped, 1);
    assert.equal(state.config.has(`${MARKER_PREFIX}org-1`), false);
});

test('delivery failure: run resolves, no audit, marker NOT set', async () => {
    state.orgs = [ncOrg()];
    state.adminsByOrg['org-1'] = [{ id: 'a1' }];
    state.notifyThrows = true;
    const res = await run({ now: NOW });
    assert.equal(res.notified, 0);
    assert.equal(res.errors, 1);
    assert.equal(state.audits.length, 0);
    assert.equal(state.config.has(`${MARKER_PREFIX}org-1`), false);
});

test('org-list failure: run resolves without throwing', async () => {
    state.orgListThrows = true;
    const res = await run({ now: NOW });
    assert.deepEqual(res, { checked: 0, notified: 0, skipped: 0, errors: 0 });
});
