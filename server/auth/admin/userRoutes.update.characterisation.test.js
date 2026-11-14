// @typecheck
'use strict';

/**
 * Characterisation (golden) test for PUT /users/:id, through the router: for
 * every request the status, the body and every effect in the order it
 * happened (the stored update, the audit row, ended sessions, the permission
 * and user-existence caches, the password hash, the key reset or re-wrap, the
 * log lines). The requests reach every branch of the handler: refused fields,
 * the operator account, the role allow-list, the fields only a platform admin
 * writes, a move between organisations, the last organisation admin (before
 * and after the write), the own-demotion confirmation, the last platform
 * admin, a password reset and a password change, and a user that is not there.
 *
 * No module mocking: the router is served by testUtils/routeHarness, and the
 * functions it calls through module objects are swapped with testUtils/swaps
 * (the ones userRoutes and its guards destructure at load, before they are
 * required). The org-admin gate, the role guards and the password policy are
 * the real ones.
 *
 * Regenerate the golden file ONLY for an intended behaviour change:
 *   UPDATE_GOLDEN=1 node --require ./testUtils/registerFeatures.js --test auth/admin/userRoutes.update.characterisation.test.js
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const h = require('../../testUtils/routeHarness');
const { makeSwaps } = require('../../testUtils/swaps');
const { PLATFORM_OPERATOR_ID } = require('../platformOperator');

const GOLDEN = path.join(__dirname, 'userRoutes.update.characterisation.golden.json');

const db = h.recordDb();
const permissions = require('../permissions');
const encryption = require('../encryption');
const limits = require('../../core/entitlements/limits');
const sessionCache = require('../sessionCache');
const userStore = require('../../stores/userStore');
const passwords = require('../passwordHash');
const log = require('../../telemetry/log');
const swaps = makeSwaps();

/** @typedef {Record<string, any>} Row */
/** @type {{ users: Row[], groups: Row[], roles: Row[], events: unknown[], onUpdate: ((id: string, updates: Row) => void) | null, failGetUser: boolean, rewrap: 'ok' | 'refuse' | 'throw', rolesFail: boolean }} */
const fx = { users: [], groups: [], roles: [], events: [], onUpdate: null, failGetUser: false, rewrap: 'ok', rolesFail: false };
const copy = (/** @type {unknown} */ v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const event = (/** @type {string} */ kind, /** @type {unknown[]} */ ...args) => { fx.events.push([kind, ...args.map(copy)]); };

/** @type {import('express').RequestHandler} */
const needsSession = (req, res, next) => (req.session && req.session.isAuthenticated && req.session.user
    ? next()
    : res.status(401).json({ error: 'Not authenticated' }));
swaps.swap(permissions, 'requireAuth', needsSession);
swaps.swap(permissions, 'loadConfig', async () => ({ admin: { username: PLATFORM_OPERATOR_ID, passwordHash: 'set' } }));
swaps.swap(permissions, 'invalidatePermissionCache', async (/** @type {string} */ id) => { event('invalidatePermissionCache', id); });
swaps.swap(permissions, 'invalidateUserExistenceCache', async (/** @type {string} */ id) => { event('invalidateUserExistenceCache', id); });
swaps.swap(encryption, 'rewrapUserDEKCompat', async (/** @type {string} */ id, /** @type {string} */ oldPassword, /** @type {string} */ password) => {
    event('rewrapUserDEKCompat', id, oldPassword, password);
    if (fx.rewrap === 'throw') throw new Error('rewrap exploded');
    return { success: fx.rewrap === 'ok' };
});
swaps.swap(encryption, 'adminResetUser', async (/** @type {string} */ id) => { event('adminResetUser', id); });
swaps.swap(limits, 'checkResourceLimits', async () => null);
swaps.swap(sessionCache, 'bustSessionsForUser', async (/** @type {string} */ id, /** @type {Record<string, unknown>} */ opts) => { event('bustSessionsForUser', id, Object.keys(opts)); return 0; });
swaps.swap(passwords, 'hash', async (/** @type {string} */ password) => { event('hash', password); return `hash(${password})`; });
for (const level of /** @type {const} */ (['info', 'warn', 'error'])) {
    swaps.swap(log, level, (/** @type {unknown[]} */ ...args) => { event(`log.${level}`, ...args.map((a) => (a instanceof Error ? a.message : a))); });
}

const api = h.serve('/', require('./userRoutes'), { user: { id: 'nobody', role: 'user' } });

test.before(async () => {
    await db.settle();
    swaps.swap(userStore, 'getUser', async (/** @type {string} */ id) => {
        if (fx.failGetUser) throw new Error('getUser exploded');
        return copy(fx.users.find((u) => u.id === id) || null);
    });
    swaps.swap(userStore, 'getAllUsers', async () => copy(fx.users));
    swaps.swap(userStore, 'getAllGroups', async () => copy(fx.groups));
    swaps.swap(userStore, 'getAllRoles', async () => { if (fx.rolesFail) throw new Error('roles exploded'); return copy(fx.roles); });
    swaps.swap(userStore, 'getAllOrganizations', async () => [{ id: 'orgA', name: 'Acme' }, { id: 'orgB', name: 'Beta' }]);
    swaps.swap(userStore, 'updateUser', async (/** @type {string} */ id, /** @type {Row} */ updates) => {
        event('updateUser', id, updates);
        const row = fx.users.find((u) => u.id === id);
        if (!row) return false;
        for (const [k, v] of Object.entries(updates)) if (v !== undefined) row[k] = v;
        if (fx.onUpdate) { const hook = fx.onUpdate; fx.onUpdate = null; hook(id, updates); }
        return true;
    });
    swaps.swap(userStore, 'logAccessAudit', async (/** @type {unknown[]} */ ...args) => { event('logAccessAudit', ...args); });
});
test.after(async () => {
    swaps.restore();
    await api.close();
});

function resetFx() {
    fx.groups = [{ id: 'g_a', name: 'Team A', organizationId: 'orgA' }, { id: 'g_b', name: 'Team B', organizationId: 'orgB' }];
    fx.roles = [{ id: 'auditor', name: 'Auditor' }];
    fx.users = [
        { id: PLATFORM_OPERATOR_ID, username: PLATFORM_OPERATOR_ID, role: 'admin', status: 'active' },
        { id: 'ann', username: 'ann', role: 'admin', status: 'active', email: 'ann@example.test' },
        { id: 'jan', username: 'jan', role: 'user', organizationId: 'orgA', groups: ['g_a'], orgRole: 'org_admin', status: 'active', email: 'jan@example.test' },
        { id: 'kim', username: 'kim', role: 'user', organizationId: 'orgA', groups: ['g_a'], orgRole: 'org_admin', status: 'active' },
        { id: 'eva', username: 'eva', role: 'user', organizationId: 'orgA', groups: ['g_a'], orgRole: 'member', status: 'active', email: 'eva@example.test' },
        { id: 'bob', username: 'bob', role: 'user', organizationId: 'orgB', groups: ['g_b'], orgRole: 'org_admin', status: 'active' },
        { id: 'bea', username: 'bea', role: 'user', organizationId: 'orgB', groups: ['g_b'], orgRole: 'member', status: 'active' },
        { id: 'sol', username: 'sol', role: 'user', organizationId: '', groups: [], orgRole: '', status: 'active' },
    ];
    fx.events = [];
    fx.onUpdate = null;
    fx.failGetUser = false;
    fx.rewrap = 'ok';
    fx.rolesFail = false;
    db.reset();
}

const user = (/** @type {string} */ id) => /** @type {Row} */ (fx.users.find((u) => u.id === id));
const ANN = { id: 'ann', role: 'admin' };
const JAN = { id: 'jan', role: 'user' };
const BOB = { id: 'bob', role: 'user' };
const EVA = { id: 'eva', role: 'user' };
const STRONG = 'Correct-Horse-Battery-42';
/** Long enough for a member, too short for an account with administrative reach. */
const MEMBER_ONLY = 'Tr0ub4d&3x';
/** Kim also administers orgB, through a group there. */
const kimAdministersOrgB = () => { fx.groups.push({ id: 'g_b_admins', name: 'Admins B', organizationId: 'orgB', roles: ['org_admin'] }); user('kim').groups = ['g_a', 'g_b_admins']; };

/**
 * @typedef {{ as: Row | null, id: string, body?: unknown, setup?: () => void }} Case
 * @type {Record<string, Case>}
 */
const CASES = {
    // The gate in front of the handler.
    noSession: { as: null, id: 'eva', body: { displayName: 'x' } },
    memberCaller: { as: EVA, id: 'kim', body: { displayName: 'x' } },
    otherOrgAdmin: { as: BOB, id: 'eva', body: { displayName: 'x' } },
    orgAdminOnPlatformAdmin: { as: JAN, id: 'ann', body: { displayName: 'x' } },
    orgAdminAssignsAdminRole: { as: JAN, id: 'eva', body: { role: 'admin' } },
    orgAdminMovesUser: { as: JAN, id: 'eva', body: { organizationId: 'orgB' } },
    orgAdminForeignGroup: { as: JAN, id: 'eva', body: { groups: ['g_a', 'g_b'] } },
    orgAdminUnknownTarget: { as: JAN, id: 'ghost', body: { displayName: 'x' } },
    // Refused bodies.
    unknownField: { as: ANN, id: 'eva', body: { isAdmin: true, displayName: 'x', nope: 1 } },
    badCostLimit: { as: ANN, id: 'eva', body: { monthlyCostLimit: 'lots' } },
    badImageLimits: { as: ANN, id: 'eva', body: { imageLimits: { perDay: 5 } } },
    unknownBeforeCostLimit: { as: ANN, id: 'eva', body: { nope: 1, monthlyCostLimit: 'lots', imageLimits: 'x' } },
    costBeforeImageLimits: { as: ANN, id: 'eva', body: { monthlyCostLimit: 'lots', imageLimits: 'x' } },
    noBody: { as: ANN, id: 'eva' },
    emptyBody: { as: ANN, id: 'eva', body: {} },
    // The operator account and the role allow-list.
    operatorDowngrade: { as: ANN, id: PLATFORM_OPERATOR_ID, body: { role: 'user' } },
    operatorKeepsRole: { as: ANN, id: PLATFORM_OPERATOR_ID, body: { role: 'admin', displayName: 'Operator' } },
    operatorUnknownRole: { as: ANN, id: PLATFORM_OPERATOR_ID, body: { role: 'root' } },
    operatorSuspended: { as: ANN, id: PLATFORM_OPERATOR_ID, body: { status: 'suspended' } },
    unknownRole: { as: ANN, id: 'eva', body: { role: 'super_admin' } },
    unknownRoleLong: { as: ANN, id: 'eva', body: { role: 'r'.repeat(100) } },
    emptyRole: { as: ANN, id: 'eva', body: { role: '' } },
    customRole: { as: ANN, id: 'eva', body: { role: 'auditor' } },
    rolesLookupFails: { as: ANN, id: 'eva', body: { role: 'auditor' }, setup: () => { fx.rolesFail = true; } },
    builtinRoleWhenLookupFails: { as: ANN, id: 'eva', body: { role: 'user' }, setup: () => { fx.rolesFail = true; } },
    // Plain updates.
    profileByPlatformAdmin: { as: ANN, id: 'eva', body: { displayName: ' <b>Eva</b> Jansen ', firstName: 'Eva', lastName: 'Jansen', email: 'eva@new.test', phone: '+31 6', avatar: 'data:x', avatarType: 'upload', id: 'eva', username: 'eva' } },
    profileByOrgAdmin: { as: JAN, id: 'eva', body: { displayName: 'Eva J', role: 'user', organizationId: 'orgA', groups: ['g_a'] } },
    limits: { as: ANN, id: 'eva', body: { monthlyCostLimit: 25, imageLimits: { day: 5, hour: null } } },
    limitsWithNoWindowSet: { as: ANN, id: 'eva', body: { imageLimits: { day: null } } },
    limitsCleared: { as: ANN, id: 'eva', body: { monthlyCostLimit: null, imageLimits: null } },
    groupsChanged: { as: ANN, id: 'eva', body: { groups: ['g_a', 'g_b'] } },
    groupsUnchanged: { as: ANN, id: 'eva', body: { groups: ['g_a'], status: 'active' } },
    unknownUser: { as: ANN, id: 'ghost', body: { displayName: 'x' } },
    unknownUserWithPassword: { as: ANN, id: 'ghost', body: { password: STRONG } },
    snapshotFails: { as: ANN, id: 'eva', body: { orgRole: 'org_admin', status: 'active' }, setup: () => { fx.failGetUser = true; } },
    // The fields only a platform admin writes, and a move between organisations.
    platformRoleSet: { as: ANN, id: 'eva', body: { role: 'admin' } },
    platformRoleCleared: { as: ANN, id: 'ann', body: { role: 'user' } },
    moveToOtherOrg: { as: ANN, id: 'eva', body: { organizationId: 'orgB' } },
    moveKeepsExplicitRole: { as: ANN, id: 'eva', body: { organizationId: 'orgB', orgRole: 'org_admin' } },
    moveOutOfEveryOrg: { as: ANN, id: 'eva', body: { organizationId: '' } },
    moveOutWithNull: { as: ANN, id: 'eva', body: { organizationId: null } },
    moveIntoAnOrg: { as: ANN, id: 'sol', body: { organizationId: 'orgA' } },
    sameOrgEchoed: { as: ANN, id: 'eva', body: { organizationId: 'orgA', displayName: 'Eva' } },
    noOrgEchoedAsNull: { as: ANN, id: 'sol', body: { organizationId: null } },
    orgAdminEchoesOrgAndRole: { as: JAN, id: 'eva', body: { organizationId: 'orgA', role: 'user', orgRole: 'member' } },
    // The last organisation admin.
    demoteOneOfTwoAdmins: { as: ANN, id: 'kim', body: { orgRole: 'member' } },
    demoteSoleAdmin: { as: ANN, id: 'bob', body: { orgRole: 'member' } },
    moveSoleAdmin: { as: ANN, id: 'bob', body: { organizationId: 'orgA', orgRole: 'org_admin' } },
    suspendSoleAdmin: { as: ANN, id: 'bob', body: { status: 'suspended' } },
    soleAdminOfEmptyOrg: { as: ANN, id: 'bob', body: { orgRole: 'member' }, setup: () => { user('bea').status = 'suspended'; } },
    soleAdminEditsOwnProfile: { as: BOB, id: 'bob', body: { displayName: 'Bob' } },
    soleAdminKeepsEverything: { as: ANN, id: 'bob', body: { orgRole: 'org_admin', organizationId: 'orgB', status: 'active', displayName: 'Bob' } },
    otherAdminSuspendedCounts: { as: ANN, id: 'kim', body: { orgRole: 'member' }, setup: () => { user('jan').status = 'suspended'; } },
    memberSuspended: { as: JAN, id: 'eva', body: { status: 'suspended' } },
    memberPromoted: { as: JAN, id: 'eva', body: { orgRole: 'org_admin' } },
    concurrentDemotion: { as: ANN, id: 'kim', body: { orgRole: 'member' }, setup: () => { fx.onUpdate = () => { user('jan').orgRole = 'member'; }; } },
    // Stepping down oneself.
    selfDemotionUnconfirmed: { as: JAN, id: 'jan', body: { orgRole: 'member' } },
    selfDemotionConfirmedAsText: { as: JAN, id: 'jan', body: { orgRole: 'member', confirmSelfDemotion: 'true' } },
    selfDemotionConfirmed: { as: JAN, id: 'jan', body: { orgRole: 'member', confirmSelfDemotion: true } },
    selfDemotionToNoRole: { as: JAN, id: 'jan', body: { orgRole: '' } },
    selfSuspension: { as: JAN, id: 'jan', body: { status: 'suspended' } },
    selfDemotionSoleAdmin: { as: BOB, id: 'bob', body: { orgRole: 'member', confirmSelfDemotion: true } },
    otherAdminDemotedByPeer: { as: JAN, id: 'kim', body: { orgRole: 'member' } },
    // The last platform admin.
    lastPlatformAdminStepsDown: { as: ANN, id: 'ann', body: { role: 'user' }, setup: () => { user(PLATFORM_OPERATOR_ID).status = 'suspended'; } },
    lastPlatformAdminSuspended: { as: ANN, id: 'ann', body: { status: 'suspended' }, setup: () => { user(PLATFORM_OPERATOR_ID).status = 'suspended'; } },
    platformAdminSuspendedWhileOperatorActive: { as: ANN, id: 'ann', body: { status: 'suspended' } },
    // Passwords.
    resetByPlatformAdmin: { as: ANN, id: 'eva', body: { password: STRONG } },
    resetByOrgAdmin: { as: JAN, id: 'eva', body: { password: STRONG } },
    resetOfAdminElsewhere: { as: JAN, id: 'kim', body: { password: STRONG }, setup: kimAdministersOrgB },
    resetOfAdminElsewhereByPlatformAdmin: { as: ANN, id: 'kim', body: { password: STRONG }, setup: kimAdministersOrgB },
    ownPasswordWhileAdminElsewhere: { as: { id: 'kim', role: 'user' }, id: 'kim', body: { password: STRONG, oldPassword: 'old' }, setup: kimAdministersOrgB },
    profileOfAdminElsewhere: { as: JAN, id: 'kim', body: { displayName: 'Kim' }, setup: kimAdministersOrgB },
    resetWeak: { as: ANN, id: 'eva', body: { password: 'short' } },
    resetContainsStoredEmail: { as: ANN, id: 'eva', body: { password: 'My-Example-Pass-42' } },
    resetContainsUnknownUsersId: { as: ANN, id: 'ghost', body: { password: 'ghost-Horse-Battery-42' } },
    resetContainsNewEmail: { as: ANN, id: 'eva', body: { password: 'brand.new@mail.test', email: 'brand.new@mail.test' } },
    resetMemberLengthForMember: { as: ANN, id: 'eva', body: { password: MEMBER_ONLY } },
    resetMemberLengthForOrgAdmin: { as: ANN, id: 'kim', body: { password: MEMBER_ONLY } },
    resetMemberLengthWithPromotion: { as: ANN, id: 'eva', body: { password: MEMBER_ONLY, orgRole: 'org_admin' } },
    resetMemberLengthWithPlatformRole: { as: ANN, id: 'eva', body: { password: MEMBER_ONLY, role: 'admin' } },
    changeOwnPassword: { as: EVA, id: 'eva', body: { password: STRONG, oldPassword: 'old-secret' }, setup: () => { user('eva').orgRole = 'org_admin'; } },
    changeOwnPasswordWrongOld: { as: JAN, id: 'jan', body: { password: STRONG, oldPassword: 'wrong' }, setup: () => { fx.rewrap = 'refuse'; } },
    changeOwnPasswordRewrapThrows: { as: JAN, id: 'jan', body: { password: STRONG, oldPassword: 'old' }, setup: () => { fx.rewrap = 'throw'; } },
    resetWithSuspension: { as: ANN, id: 'eva', body: { password: STRONG, status: 'suspended' } },
    ownPasswordAndProfile: { as: JAN, id: 'jan', body: { password: STRONG, oldPassword: 'old', displayName: 'Jan' } },
    // Several at once: the order of the refusals.
    unknownRoleBeforeLastAdmin: { as: ANN, id: 'bob', body: { role: 'root', orgRole: 'member' } },
    lastOrgAdminBeforeLastPlatformAdmin: { as: ANN, id: 'ann', body: { role: 'user', orgRole: 'member' }, setup: () => { user(PLATFORM_OPERATOR_ID).status = 'suspended'; Object.assign(user('ann'), { organizationId: 'orgB', orgRole: 'org_admin' }); user('bob').orgRole = 'member'; } },
    lastPlatformAdminBeforePassword: { as: ANN, id: 'ann', body: { role: 'user', password: 'short' }, setup: () => { user(PLATFORM_OPERATOR_ID).status = 'suspended'; } },
    resetRefusalBeforePolicy: { as: JAN, id: 'kim', body: { password: 'short' }, setup: kimAdministersOrgB },
    adminThroughGroupDemoted: { as: ANN, id: 'kim', body: { orgRole: 'member' }, setup: () => { kimAdministersOrgB(); user('bob').orgRole = 'member'; } },
    adminThroughGroupDemotedOtherOrgHasAdmin: { as: ANN, id: 'kim', body: { orgRole: 'member' }, setup: kimAdministersOrgB },
    concurrentChangeInSecondOrg: { as: ANN, id: 'kim', body: { status: 'suspended' }, setup: () => { kimAdministersOrgB(); fx.onUpdate = () => { user('bob').status = 'suspended'; }; } },
    everythingAtOnce: { as: ANN, id: 'eva', body: { displayName: 'Eva', orgRole: 'org_admin', role: 'auditor', organizationId: 'orgB', groups: ['g_b'], status: 'active', password: STRONG, monthlyCostLimit: 10 } },
};

/** @param {Case} c */
async function run(c) {
    resetFx();
    if (c.setup) c.setup();
    const res = await api.call('PUT', `/users/${c.id}`, { user: c.as, body: c.body });
    return { status: res.status, body: res.body ?? res.text, events: fx.events };
}

test('PUT /users/:id: every request gives the recorded answer and effects, in order', async () => {
    /** @type {Record<string, unknown>} */
    const actual = {};
    for (const [name, c] of Object.entries(CASES)) actual[name] = copy(await run(c));
    if (process.env.UPDATE_GOLDEN) fs.writeFileSync(GOLDEN, `${JSON.stringify(actual, null, 1)}\n`);
    const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
    assert.deepEqual(Object.keys(actual), Object.keys(golden));
    for (const name of Object.keys(golden)) assert.deepEqual(actual[name], golden[name], name);
});
