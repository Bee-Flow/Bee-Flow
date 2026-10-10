'use strict';

/**
 * Which servers may a user put on a token. Run: node --test auth/mcpAccess/eligibility.test.js
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const { eligibleServers, firstRefusedScope } = require('./eligibility');

const OPEN = { enabled: true, allowedUsers: { mode: 'all', roles: [], userIds: [] } };
const user = { id: 'u1', organizationId: 'o1', orgRole: 'member', groups: [] };

const yes = async () => true;
const no = async () => false;
const boom = async () => { throw new Error('db down'); };
const on = () => true;
const off = () => false;

const deps = (over = {}) => ({
    resolveOrgs: async () => ({ primary: 'o1', all: ['o1'] }),
    getOrgMcpPolicy: async () => OPEN,
    servers: {
        automations: { enabled: on, entitled: yes },
        studio: { enabled: on, entitled: yes },
        cms: { enabled: on, isAdmin: yes },
    },
    ...over,
});

test('everything on offer for a fully entitled user', async () => {
    assert.deepEqual(await eligibleServers(user, deps()), {
        policy: { allowed: true },
        integrations: { available: true },
        automations: { available: true },
        studio: { available: true, canWrite: true },
        cms: { available: true, canPublish: true },
    });
});

test('a server whose env flag is off is not_enabled, and its entitlement is not even asked', async () => {
    let asked = 0;
    const counting = async () => { asked += 1; return true; };
    const out = await eligibleServers(user, deps({ servers: {
        automations: { enabled: off, entitled: counting },
        studio: { enabled: off, entitled: counting },
        cms: { enabled: off, isAdmin: counting },
    } }));
    assert.deepEqual(out.automations, { available: false, reason: 'not_enabled' });
    assert.deepEqual(out.studio, { available: false, reason: 'not_enabled' });
    assert.deepEqual(out.cms, { available: false, reason: 'not_enabled', canPublish: false });
    assert.equal(asked, 0);
});

test('a missing predicate counts as not enabled', async () => {
    const out = await eligibleServers(user, deps({ servers: {} }));
    assert.equal(out.automations.reason, 'not_enabled');
    assert.equal(out.studio.reason, 'not_enabled');
    assert.equal(out.cms.reason, 'not_enabled');
});

test('a user without the right gets no_access per server', async () => {
    const out = await eligibleServers(user, deps({ servers: {
        automations: { enabled: on, entitled: no },
        studio: { enabled: on, entitled: no },
        cms: { enabled: on, isAdmin: no },
    } }));
    assert.deepEqual(out.automations, { available: false, reason: 'no_access' });
    assert.deepEqual(out.studio, { available: false, reason: 'no_access', canWrite: false });
    assert.deepEqual(out.cms, { available: false, reason: 'no_access', canPublish: false });
});

test('an entitlement lookup that throws fails closed as no_access', async () => {
    const out = await eligibleServers(user, deps({ servers: {
        automations: { enabled: on, entitled: boom },
        studio: { enabled: on, entitled: boom },
        cms: { enabled: on, isAdmin: boom },
    } }));
    assert.equal(out.automations.reason, 'no_access');
    assert.equal(out.studio.reason, 'no_access');
    assert.equal(out.cms.reason, 'no_access');
});

test('the policy: disabled org, user not allowed, and the strictest of several orgs', async () => {
    const policies = { o1: OPEN, o2: { enabled: false, allowedUsers: { mode: 'all' } }, o3: { enabled: true, allowedUsers: { mode: 'users', userIds: ['other'] } } };
    const run = (all) => eligibleServers(user, deps({
        resolveOrgs: async () => ({ primary: all[0], all }),
        getOrgMcpPolicy: async (id) => policies[id],
    }));
    assert.deepEqual((await run(['o1'])).policy, { allowed: true });
    assert.deepEqual((await run(['o2'])).policy, { allowed: false, reason: 'disabled' });
    assert.deepEqual((await run(['o3'])).policy, { allowed: false, reason: 'user_not_allowed' });
    assert.deepEqual((await run(['o1', 'o3'])).policy, { allowed: false, reason: 'user_not_allowed' });
});

test('role based policy follows the user\'s org role', async () => {
    const roles = { enabled: true, allowedUsers: { mode: 'roles', roles: ['org_admin'] } };
    const run = (u) => eligibleServers(u, deps({ getOrgMcpPolicy: async () => roles }));
    assert.equal((await run({ ...user, orgRole: 'member' })).policy.allowed, false);
    assert.equal((await run({ ...user, orgRole: 'admin' })).policy.allowed, true);
});

test('an org-less account is judged against the default policy', async () => {
    let asked;
    const out = await eligibleServers({ id: 'u2', organizationId: '', groups: [] }, deps({
        resolveOrgs: async () => ({ primary: null, all: [] }),
        getOrgMcpPolicy: async (id) => { asked = id; return OPEN; },
    }));
    assert.equal(asked, null);
    assert.equal(out.policy.allowed, true);
});

test('a policy or org lookup that fails is a refusal (unavailable), never open', async () => {
    assert.deepEqual((await eligibleServers(user, deps({ getOrgMcpPolicy: boom }))).policy, { allowed: false, reason: 'unavailable' });
    assert.deepEqual((await eligibleServers(user, deps({ resolveOrgs: boom }))).policy, { allowed: false, reason: 'unavailable' });
});

test('firstRefusedScope names the first server the user may not carry', () => {
    const elig = {
        policy: { allowed: true },
        integrations: { available: true },
        automations: { available: false, reason: 'no_access' },
        studio: { available: true, canWrite: false },
        cms: { available: true, canPublish: false },
    };
    assert.equal(firstRefusedScope({ integrations: { level: 'read' } }, elig), null);
    assert.equal(firstRefusedScope({ automations: { level: 'read' } }, elig).server, 'automations');
    assert.equal(firstRefusedScope({ studio: { level: 'read' } }, elig), null);
    assert.equal(firstRefusedScope({ studio: { level: 'write' } }, elig).server, 'studio');
    assert.equal(firstRefusedScope({ cms: { level: 'write', publish: false } }, elig), null);
    assert.equal(firstRefusedScope({ cms: { level: 'write', publish: true } }, elig).publish, true);
    assert.equal(firstRefusedScope({ nope: { level: 'read' } }, elig).server, 'nope');
});
