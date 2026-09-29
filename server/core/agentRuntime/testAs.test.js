'use strict';

/**
 * "Test as · group X" — the rules.
 *
 * The feature is one sentence ("show me what a Sales member would see") and
 * three ways to get it wrong, all of them reassuring:
 *
 *   1. NAMING A GROUP WIDENS. If simulating Sales handed the editor a base
 *      only Sales may read, "Test as" would be a read-anything button with a
 *      friendly label. The KB tests below therefore always assert the same
 *      thing twice: what the simulation shows, and that it is a subset of what
 *      the person could already see.
 *   2. THE OWNER BYPASS SURVIVES. Both `canUserAccessKB` and `canSeePublished`
 *      let an owner through before any group rule runs, and the person testing
 *      usually IS the owner — so a simulation that keeps it answers "yes,
 *      Marketing sees this" about a personal base nobody else can open.
 *   3. A FAILED LOOKUP BECOMES A NORMAL RUN. The group store is down, the
 *      simulation quietly does not happen, and the answers come back under a
 *      label that says they were somebody else's. Every failure below is
 *      asserted as a refusal or as an empty knowledge list — never as a
 *      pass-through.
 *
 * The KB half runs the REAL `kbVisibility` filters and the REAL
 * `canUserAccessKB` over a fake table: faking the filters would prove the
 * plumbing and nothing about the rule.
 *
 * Run: cd server && node --test --test-force-exit core/agentRuntime/testAs.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const {
    TEST_AS_CODES, AUDIENCE_REASONS,
    normaliseGroupId, coerceTestAs, testAsLabelParts,
    resolveTestAs, gateTestAsRequest,
    visibleKbIdsFor, audienceForTestAs,
} = require('./testAs');

const realStore = require('../../stores/knowledgeBases');
const kbVisibility = require('../kb/kbVisibility');
const { canSeePublished } = require('../../auth/audience');

// ── 1. Reading the request ───────────────────────────────────────────

test('a group id is a bounded, trimmed, non-empty string', () => {
    assert.strictEqual(normaliseGroupId('  sales '), 'sales');
    assert.strictEqual(normaliseGroupId(''), null);
    assert.strictEqual(normaliseGroupId('   '), null);
    assert.strictEqual(normaliseGroupId(null), null);
    assert.strictEqual(normaliseGroupId(42), null);
    assert.strictEqual(normaliseGroupId({ groupId: 'sales' }), null);
    assert.strictEqual(normaliseGroupId('x'.repeat(500)).length, 200);
});

test('an absent simulation and an unreadable one are different answers', () => {
    // The distinction the whole feature rests on. If these collapsed into one,
    // a `testAs` the runtime could not parse would run as the real person.
    for (const absent of [undefined, null, false, '']) {
        assert.strictEqual(coerceTestAs(absent), null, JSON.stringify(absent));
    }
    for (const broken of ['sales', 42, true, [], {}, { groupId: '' }, { groupId: 7 }]) {
        const out = coerceTestAs(broken);
        assert.ok(out, `${JSON.stringify(broken)} must not read as "nothing was asked for"`);
        assert.strictEqual(out.groupId, null);
    }
    assert.deepStrictEqual(
        coerceTestAs({ groupId: ' sales ', groupName: ' Sales ', orgId: 'org1', audience: 'ignored' }),
        { groupId: 'sales', groupName: 'Sales', orgId: 'org1' },
    );
});

test('the wire label is null unless there is a real simulation behind it', () => {
    assert.strictEqual(testAsLabelParts(null), null);
    assert.strictEqual(testAsLabelParts({ groupId: '' }), null);
    assert.deepStrictEqual(
        testAsLabelParts({ groupId: 'sales', groupName: 'Sales', orgId: 'org1' }),
        { groupId: 'sales', groupName: 'Sales' },
    );
});

// ── 2. Resolving a group ─────────────────────────────────────────────

const GROUPS = {
    sales: { id: 'sales', name: 'Sales', organizationId: 'org1' },
    hr_other: { id: 'hr_other', name: 'HR', organizationId: 'org2' },
    users: { id: 'users', name: 'Users', organizationId: null },
};

function deps({ groups = GROUPS, own = [], throwsGroup = false, throwsOwn = false } = {}) {
    return {
        getGroup: async (id) => {
            if (throwsGroup) throw new Error('groups table unreachable');
            return groups[id] || null;
        },
        resolveUserGroups: async () => {
            if (throwsOwn) throw new Error('user row unreadable');
            return own;
        },
    };
}

test('no group id is a refusal, not a run', async () => {
    const out = await resolveTestAs({ groupId: '  ', userId: 'me', orgIds: new Set(['org1']), deps: deps() });
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.status, 400);
    assert.strictEqual(out.code, TEST_AS_CODES.invalid);
});

test('a group lookup that fails refuses — it never falls through to a plain run', async () => {
    // The single most likely way this feature turns into a lie: the read is
    // down, nobody simulated anything, and the label still says "as Sales".
    const out = await resolveTestAs({
        groupId: 'sales', userId: 'me', orgIds: new Set(['org1']), deps: deps({ throwsGroup: true }),
    });
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.status, 503);
    assert.strictEqual(out.code, TEST_AS_CODES.unreadable);
    assert.strictEqual(out.testAs, undefined);
});

test('a group in the caller\'s own org resolves, with its org and name', async () => {
    const out = await resolveTestAs({ groupId: ' sales ', userId: 'me', orgIds: new Set(['org1']), deps: deps() });
    assert.strictEqual(out.ok, true);
    assert.deepStrictEqual(out.testAs, { groupId: 'sales', groupName: 'Sales', orgId: 'org1' });
});

test('a group from another org and a group that does not exist give the SAME answer', async () => {
    const base = { userId: 'me', orgIds: new Set(['org1']), deps: deps() };
    const foreign = await resolveTestAs({ ...base, groupId: 'hr_other' });
    const missing = await resolveTestAs({ ...base, groupId: 'nope' });
    // Telling them apart confirms that another organisation has a group with
    // this id — to somebody who may not know that organisation exists.
    assert.strictEqual(foreign.ok, false);
    assert.strictEqual(missing.ok, false);
    assert.strictEqual(foreign.code, missing.code);
    assert.strictEqual(foreign.error, missing.error);
    assert.strictEqual(foreign.code, TEST_AS_CODES.notFound);
});

test('a group with no organisation resolves only for someone who is in it', async () => {
    const orgIds = new Set(['org1']);
    const outsider = await resolveTestAs({ groupId: 'users', userId: 'me', orgIds, deps: deps({ own: [] }) });
    assert.strictEqual(outsider.ok, false);
    const member = await resolveTestAs({ groupId: 'users', userId: 'me', orgIds, deps: deps({ own: ['users'] }) });
    assert.strictEqual(member.ok, true);
    assert.strictEqual(member.testAs.orgId, null);
});

test('a membership read that throws refuses — it does not count as membership', async () => {
    const out = await resolveTestAs({
        groupId: 'users', userId: 'me', orgIds: new Set(['org1']),
        deps: deps({ own: ['users'], throwsOwn: true }),
    });
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.code, TEST_AS_CODES.notFound);
});

test('a super admin may name any group', async () => {
    const out = await resolveTestAs({ groupId: 'hr_other', userId: 'root', orgIds: null, deps: deps() });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.testAs.orgId, 'org2');
});

// ── 3. The request gate ──────────────────────────────────────────────

test('no asGroup is the only way to get ok with nothing to simulate', async () => {
    for (const absent of [undefined, null, '', false]) {
        const out = await gateTestAsRequest({ asGroup: absent, userId: 'me', orgIds: new Set(), canEdit: false, deps: deps() });
        assert.deepStrictEqual(out, { ok: true, testAs: null }, JSON.stringify(absent));
    }
});

test('someone who may chat with an agent but not edit it cannot test as a group', async () => {
    const out = await gateTestAsRequest({
        asGroup: 'sales', userId: 'me', orgIds: new Set(['org1']), canEdit: false, deps: deps(),
    });
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.status, 403);
    assert.strictEqual(out.code, TEST_AS_CODES.notAllowed);
});

test('an editor gets the resolved simulation', async () => {
    const out = await gateTestAsRequest({
        asGroup: 'sales', userId: 'me', orgIds: new Set(['org1']), canEdit: true, deps: deps(),
    });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.testAs.groupId, 'sales');
});

// ── 4. Knowledge: the narrowing ──────────────────────────────────────

function kb(id, over = {}) {
    return {
        id, tenant_id: 'owner', organization_id: 'org1',
        is_published: true, shared_groups: '[]', source_kind: null, ...over,
    };
}

/** The real filters + the real policy, over a fake table. */
function kbDeps(rows, asker) {
    const byId = new Map(rows.map(r => [r.id, r]));
    return {
        askerContext: async () => asker,
        kbVisibility,
        kbStore: {
            getKB: async (id) => byId.get(id) || null,
            canUserAccessKB: realStore.canUserAccessKB,
        },
    };
}

const ASKER_IN_SALES = { orgIds: new Set(['org1']), userGroups: ['sales'] };
const ASKER_NO_GROUPS = { orgIds: new Set(['org1']), userGroups: [] };

const ROWS = [
    kb('open'),
    kb('sales_only', { shared_groups: '["sales"]' }),
    kb('mine', { tenant_id: 'me', organization_id: null }),
    kb('system', { source_kind: 'system_managed', organization_id: null, tenant_id: 'sys' }),
];

test('without a simulation nothing changes', async () => {
    const out = await visibleKbIdsFor(['open', 'sales_only', 'mine'], {
        userId: 'me', testAs: null, deps: kbDeps(ROWS, ASKER_IN_SALES),
    });
    assert.deepStrictEqual(out, ['open', 'sales_only', 'mine']);
});

test('simulating a group drops what that group may not read', async () => {
    const out = await visibleKbIdsFor(['open', 'sales_only', 'mine'], {
        userId: 'me',
        testAs: { groupId: 'marketing', orgId: 'org1' },
        deps: kbDeps(ROWS, ASKER_IN_SALES),
    });
    // `sales_only` is restricted to another group; `mine` is personal, and the
    // owner bypass that would have kept it is exactly what must not apply.
    assert.deepStrictEqual(out, ['open']);
});

test('simulating a group NEVER adds a base the person may not read', async () => {
    // The escalation this feature could have been. The asker is in no group,
    // so `sales_only` is invisible to them; naming Sales must not change that.
    const out = await visibleKbIdsFor(['open', 'sales_only'], {
        userId: 'me',
        testAs: { groupId: 'sales', orgId: 'org1' },
        deps: kbDeps(ROWS, ASKER_NO_GROUPS),
    });
    assert.deepStrictEqual(out, ['open']);
    assert.ok(!out.includes('sales_only'));
});

test('a base both sides may read survives, and public reference text does too', async () => {
    const out = await visibleKbIdsFor(['open', 'sales_only', 'system'], {
        userId: 'me',
        testAs: { groupId: 'sales', orgId: 'org1' },
        deps: kbDeps(ROWS, ASKER_IN_SALES),
    });
    assert.deepStrictEqual(out, ['open', 'sales_only', 'system']);
});

test('a group from another org sees none of this org\'s bases', async () => {
    const out = await visibleKbIdsFor(['open', 'sales_only'], {
        userId: 'me',
        testAs: { groupId: 'hr_other', orgId: 'org2' },
        deps: kbDeps(ROWS, ASKER_IN_SALES),
    });
    assert.deepStrictEqual(out, []);
});

test('a group with no organisation is evaluated inside the ASKER\'s orgs', async () => {
    const out = await visibleKbIdsFor(['open', 'sales_only'], {
        userId: 'me',
        testAs: { groupId: 'sales', orgId: null },
        deps: kbDeps(ROWS, ASKER_IN_SALES),
    });
    assert.deepStrictEqual(out, ['open', 'sales_only']);
});

test('an unreadable simulation yields NO knowledge, not the asker\'s own', async () => {
    // The failure mode with the friendliest-looking alternative.
    for (const broken of ['sales', {}, { groupId: '' }, 42, true]) {
        const out = await visibleKbIdsFor(['open'], {
            userId: 'me', testAs: broken, deps: kbDeps(ROWS, ASKER_IN_SALES),
        });
        assert.deepStrictEqual(out, [], JSON.stringify(broken));
    }
});

test('an empty id list is empty whatever was asked for', async () => {
    assert.deepStrictEqual(await visibleKbIdsFor([], { userId: 'me', deps: kbDeps(ROWS, ASKER_IN_SALES) }), []);
    assert.deepStrictEqual(await visibleKbIdsFor(null, { userId: 'me', deps: kbDeps(ROWS, ASKER_IN_SALES) }), []);
});

test('the group filter only ever sees the already-narrowed list', async () => {
    // Structural, not incidental: the result is a subset because of the order
    // these run in, so an intersection somebody later re-orders cannot widen.
    const seen = [];
    const spy = {
        filterKbIdsForUser: kbVisibility.filterKbIdsForUser,
        filterKbIdsForGroupMember: async (ids, opts) => {
            seen.push([...ids]);
            return kbVisibility.filterKbIdsForGroupMember(ids, opts);
        },
    };
    const d = kbDeps(ROWS, ASKER_NO_GROUPS);
    await visibleKbIdsFor(['open', 'sales_only'], {
        userId: 'me', testAs: { groupId: 'sales', orgId: 'org1' },
        deps: { ...d, kbVisibility: spy },
    });
    assert.deepStrictEqual(seen, [['open']], 'sales_only must be gone before the group filter runs');
});

// ── 5. Audience: could that group open the agent at all? ─────────────

const AGENT = {
    id: 'a1', owner_id: 'me', organization_id: 'org1',
    is_published: true, shared_groups: [],
};
const AUD = { orgIds: new Set(['org1']), deps: { canSeePublished } };

test('a published, org-wide agent is reachable by any group in the org', () => {
    assert.deepStrictEqual(
        audienceForTestAs(AGENT, { groupId: 'marketing', orgId: 'org1' }, AUD),
        { visible: true, reason: AUDIENCE_REASONS.ok },
    );
});

test('a group restriction is honoured in both directions', () => {
    const agent = { ...AGENT, shared_groups: ['sales'] };
    assert.strictEqual(audienceForTestAs(agent, { groupId: 'sales', orgId: 'org1' }, AUD).visible, true);
    assert.deepStrictEqual(
        audienceForTestAs(agent, { groupId: 'marketing', orgId: 'org1' }, AUD),
        { visible: false, reason: AUDIENCE_REASONS.groupRestricted },
    );
});

test('the owner bypass does not rescue an unpublished agent', () => {
    // `canSeePublished` would return true here — the editor owns it. Answering
    // "yes, Marketing can open it" because *you* can is the reassuring lie.
    const agent = { ...AGENT, is_published: false };
    assert.deepStrictEqual(
        audienceForTestAs(agent, { groupId: 'marketing', orgId: 'org1' }, AUD),
        { visible: false, reason: AUDIENCE_REASONS.unpublished },
    );
});

test('a group from another org cannot open it', () => {
    assert.deepStrictEqual(
        audienceForTestAs(AGENT, { groupId: 'hr_other', orgId: 'org2' }, AUD),
        { visible: false, reason: AUDIENCE_REASONS.otherOrg },
    );
});

test('a group with no org is judged against the asker\'s orgs', () => {
    assert.strictEqual(
        audienceForTestAs(AGENT, { groupId: 'users', orgId: null }, AUD).visible, true);
    assert.strictEqual(
        audienceForTestAs(AGENT, { groupId: 'users', orgId: null }, { ...AUD, orgIds: new Set() }).reason,
        AUDIENCE_REASONS.otherOrg);
});

test('no agent, no simulation and a throwing predicate are all "unknown", never visible', () => {
    for (const call of [
        [null, { groupId: 'sales' }, AUD],
        [AGENT, null, AUD],
        [AGENT, { groupId: '' }, AUD],
        [AGENT, { groupId: 'sales' }, { orgIds: new Set(['org1']), deps: { canSeePublished: () => { throw new Error('boom'); } } }],
    ]) {
        assert.deepStrictEqual(
            audienceForTestAs(call[0], call[1], call[2]),
            { visible: false, reason: AUDIENCE_REASONS.unknown },
        );
    }
});
