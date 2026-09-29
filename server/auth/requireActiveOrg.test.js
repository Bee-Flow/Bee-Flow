/**
 * auth/permissions.requireActiveOrg — the org-lifecycle (suspended/archived) gate.
 *
 * WHY: the gate used to pick the org it checks out of caller-controlled input —
 * `req.params[paramName] || req.body.organizationId` — with a docstring saying
 * the override was "for super-admin routes". Super-admins return next() one
 * line earlier, so the only callers who could ever reach the override were
 * ordinary members: appending `"organizationId":"<anything>"` to a JSON body
 * turned the suspension and archive gates off across every router behind
 * requireActiveOrgForMutations() (agents, KBs, skills, steps, webpages,
 * automations, integration connections). A nonexistent id worked too, because
 * an unknown org falls through to next().
 *
 * The contract pinned here: the CALLER's own org is always evaluated, and a
 * route param or a body organizationId is evaluated IN ADDITION, never instead.
 * A body org is only added when the caller is genuinely a member of it — that
 * is what separates the honest multi-org case (primary org active, a secondary
 * org suspended, so the write must still be blocked) from the original bug,
 * where naming any id at all took the caller off the gate. The
 * fail-open-on-DB-error behaviour is part of the contract too — this gate must
 * not lock customers out on a transient error.
 *
 * Run: cd server && node --test auth/requireActiveOrg.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../testUtils/stubRequire');

process.env.NODE_ENV = 'test';

// Fixture DB. `orgs` maps org id -> status; anything absent is "unknown org".
const fx = { user: null, orgs: {}, throwOnGetOrg: false };

const restore = installResolveStub({
    '../stores/userStore': {
        getUser: async () => fx.user,
        getAllGroups: async () => fx.groups || [],
        getOrganization: async (id) => {
            if (fx.throwOnGetOrg) throw new Error('connection terminated unexpectedly');
            return fx.orgs[id] ? { id, status: fx.orgs[id] } : null;
        },
    },
});

const permissions = require('./permissions');

restore();

function drive(gate, { method = 'POST', body = {}, params = {}, session } = {}) {
    return new Promise((resolve) => {
        const req = { method, body, params, session };
        const res = {
            statusCode: null,
            status(c) { this.statusCode = c; return this; },
            json(b) { resolve({ outcome: 'denied', status: this.statusCode, body: b }); return this; },
        };
        gate(req, res, () => resolve({ outcome: 'next' }));
    });
}

const MEMBER = { user: { id: 'u1', role: 'user' } };

function memberOf(orgId) {
    fx.user = { id: 'u1', organizationId: orgId, groups: [] };
    fx.groups = [];
}

// A genuinely multi-org member: `primary` is their own users.organizationId,
// every entry of `viaGroups` is a secondary org they reach through a group.
// resolveUserOrgIds() unions both — and so does assertUserCanUseOrg(), which is
// why a body org can be an org the caller is fully entitled to write into.
function memberOfPlusGroupOrgs(primary, ...viaGroups) {
    fx.groups = viaGroups.map((orgId, i) => ({ id: `g${i}`, organizationId: orgId }));
    fx.user = { id: 'u1', organizationId: primary, groups: fx.groups.map(g => g.id) };
}

test('a member of a suspended org is blocked with 402', async () => {
    fx.orgs = { 'org-a': 'suspended' };
    memberOf('org-a');
    const r = await drive(permissions.requireActiveOrgForMutations(), { session: MEMBER });
    assert.strictEqual(r.outcome, 'denied');
    assert.strictEqual(r.status, 402);
    assert.strictEqual(r.body.error, 'org_suspended');
});

test('body.organizationId cannot redirect the check at another, active org', async () => {
    fx.orgs = { 'org-a': 'suspended', 'org-b': 'active' };
    memberOf('org-a');
    const r = await drive(permissions.requireActiveOrgForMutations(), {
        session: MEMBER,
        body: { name: 'new agent', organizationId: 'org-b' },
    });
    assert.strictEqual(r.status, 402, 'one extra body field must not re-open a suspended tenant');
});

test('body.organizationId naming a nonexistent org cannot silence the gate', async () => {
    // The unknown-org branch falls through to next(); reading the target org
    // from the body therefore made "organizationId": "anything" a kill switch.
    fx.orgs = { 'org-a': 'suspended' };
    memberOf('org-a');
    const r = await drive(permissions.requireActiveOrgForMutations(), {
        session: MEMBER,
        body: { organizationId: 'no-such-org' },
    });
    assert.strictEqual(r.status, 402);
});

test('an archived org stays read-only for mutations, including with a body override', async () => {
    fx.orgs = { 'org-a': 'archived', 'org-b': 'active' };
    memberOf('org-a');
    const plain = await drive(permissions.requireActiveOrgForMutations(), { session: MEMBER });
    assert.strictEqual(plain.status, 410);
    assert.strictEqual(plain.body.error, 'org_archived');

    const override = await drive(permissions.requireActiveOrgForMutations(), {
        session: MEMBER, body: { organizationId: 'org-b' },
    });
    assert.strictEqual(override.status, 410);
});

test('a route param org is checked IN ADDITION to the caller org', async () => {
    fx.orgs = { 'org-a': 'active', 'org-b': 'suspended' };
    memberOf('org-a');
    const r = await drive(permissions.requireActiveOrg({ paramName: 'orgId' }), {
        session: MEMBER, params: { orgId: 'org-b' },
    });
    assert.strictEqual(r.status, 402, 'acting on a suspended org must be blocked');
});

// ── The three-source rule, one property per test ──────────────────
// requireActiveOrg evaluates three orgs, and the difference between them is
// membership: the route param, req.body.organizationId but ONLY when the caller
// really belongs to it, and the caller's own org unconditionally. (a) and (c)
// are what stop the body being a kill switch; (b) is what stops "just delete
// the body branch" from re-opening a different hole; (d) is what stops a
// hand-crafted JSON value from taking a shortcut through either.

test('naming a stranger org in the body does not silence the gate — the caller org is still evaluated', async () => {
    // The original bug in one expression: `req.params[x] || req.body.organizationId`
    // let the body REPLACE the org under test, and membership was never
    // consulted. Any id at all — here an active org this caller has nothing to
    // do with — moved the check off their own suspended tenant, across every
    // router behind requireActiveOrgForMutations(). The caller's own org is now
    // appended unconditionally, so a named org can only ever ADD work.
    fx.orgs = { 'org-a': 'suspended', 'org-stranger': 'active' };
    memberOf('org-a');
    const r = await drive(permissions.requireActiveOrgForMutations(), {
        session: MEMBER,
        body: { name: 'new agent', organizationId: 'org-stranger' },
    });
    assert.strictEqual(r.status, 402, 'an org the caller does not belong to must never become the org under test');
    assert.strictEqual(r.body.error, 'org_suspended');
});

test('a SUSPENDED secondary org the caller does belong to is enforced when the body names it', async () => {
    // The regression the first correction introduced by dropping req.body
    // wholesale: only the primary org was left, so a member whose primary org
    // is active kept writing into the suspended org they reach via a group.
    // That is not hypothetical — routes/agents/crud.js and
    // routes/knowledgeBases.js take the target org FROM THE BODY, and
    // assertUserCanUseOrg() admits any org in the resolveUserOrgIds union, so
    // the write lands in org-b while only org-a was ever checked. The suspended
    // tenant is exactly the one whose subscription stopped paying.
    fx.orgs = { 'org-a': 'active', 'org-b': 'suspended' };
    memberOfPlusGroupOrgs('org-a', 'org-b');
    const r = await drive(permissions.requireActiveOrgForMutations(), {
        session: MEMBER,
        body: { name: 'kb belonging to the suspended org', organizationId: 'org-b' },
    });
    assert.strictEqual(r.status, 402, 'an active primary org must not launder a write into a suspended secondary org');
    assert.strictEqual(r.body.error, 'org_suspended');
});

test('a body org the caller is NOT a member of is ignored rather than evaluated', async () => {
    // The mirror image of the first test, and the reason the rule is
    // "member-only" instead of the simpler "check everything named": a foreign
    // tenant's billing state is none of this request's business. Evaluating it
    // would let any unrelated org's suspension 402 a healthy customer — a stale
    // organizationId copied into a payload would be enough. Whether the caller
    // may write into org-stranger at all is assertUserCanUseOrg()'s 403, a
    // different question from "is a tenant suspended".
    fx.orgs = { 'org-a': 'active', 'org-stranger': 'suspended' };
    memberOf('org-a');
    const r = await drive(permissions.requireActiveOrgForMutations(), {
        session: MEMBER,
        body: { organizationId: 'org-stranger' },
    });
    assert.strictEqual(r.outcome, 'next', 'a foreign tenant\'s subscription must not decide this caller\'s request');
});

test('a non-string body.organizationId is neither honoured nor fatal', async () => {
    // req.body is attacker-shaped JSON: `"organizationId": {}` or `[...]` is one
    // curl away. Two things must hold. First it must not throw: the catch below
    // fails OPEN, so a TypeError raised anywhere in the gate hands back exactly
    // the bypass this gate exists to prevent — a raw value reaching Set.has()
    // or getOrganization() is a needless place to risk that. Hence the typeof
    // guard, and hence the caller's own suspended org still answering here.
    fx.orgs = { 'org-a': 'suspended' };
    memberOf('org-a');
    for (const junk of [{}, ['org-a'], { organizationId: 'org-a' }, 42, true]) {
        const r = await drive(permissions.requireActiveOrgForMutations(), {
            session: MEMBER, body: { organizationId: junk },
        });
        assert.strictEqual(r.status, 402,
            `body.organizationId = ${JSON.stringify(junk)} must not derail the caller-org check`);
    }

    // Second, no stringification. `['org-b']` coerces to the property key
    // 'org-b', so anything that passed the raw value on to getOrganization()
    // (or wrapped it in String()) would treat an array as a real org id — the
    // original code did precisely that. Only a genuine string org id, matched
    // by reference in the membership Set, may add a check; a malformed one is
    // rejected upstream by assertUserCanUseOrg() long before it writes anything.
    fx.orgs = { 'org-a': 'active', 'org-b': 'suspended' };
    memberOfPlusGroupOrgs('org-a', 'org-b');
    const coerced = await drive(permissions.requireActiveOrgForMutations(), {
        session: MEMBER, body: { organizationId: ['org-b'] },
    });
    assert.strictEqual(coerced.outcome, 'next', 'an array must not be coerced into a member org id');
});

// ── Everything that must keep working ─────────────────────────────

test('an active org passes', async () => {
    fx.orgs = { 'org-a': 'active' };
    memberOf('org-a');
    const r = await drive(permissions.requireActiveOrgForMutations(), { session: MEMBER });
    assert.strictEqual(r.outcome, 'next');
});

test('an org-less consumer account passes', async () => {
    fx.orgs = {};
    memberOf('');
    const r = await drive(permissions.requireActiveOrgForMutations(), { session: MEMBER });
    assert.strictEqual(r.outcome, 'next');
});

test('a super-admin is exempt even for a suspended org', async () => {
    fx.orgs = { 'org-a': 'suspended' };
    memberOf('org-a');
    const r = await drive(permissions.requireActiveOrgForMutations(), {
        session: { isAdmin: true, user: { id: 'root', role: 'admin' } },
    });
    assert.strictEqual(r.outcome, 'next');
});

test('reads are never blocked by the mutations-only variant', async () => {
    fx.orgs = { 'org-a': 'suspended' };
    memberOf('org-a');
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
        const r = await drive(permissions.requireActiveOrgForMutations(), { session: MEMBER, method });
        assert.strictEqual(r.outcome, 'next', `${method} must still be served`);
    }
});

test('a DB error still fails open — a degraded lookup must not lock customers out', async () => {
    fx.orgs = { 'org-a': 'suspended' };
    memberOf('org-a');
    fx.throwOnGetOrg = true;
    try {
        const r = await drive(permissions.requireActiveOrgForMutations(), { session: MEMBER });
        assert.strictEqual(r.outcome, 'next');
    } finally {
        fx.throwOnGetOrg = false;
    }
});
