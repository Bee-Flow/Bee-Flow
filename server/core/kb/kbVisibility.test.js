/**
 * Retrieval-time visibility.
 *
 * The bug this closes: a knowledge base shared with the Sales group, attached
 * to an agent the whole organisation may talk to, answered questions for
 * people outside Sales — with citations. The picker had been honest and the
 * runtime had not.
 *
 * So the cases that matter are the ones where a filter that LOOKS right
 * silently is not: a null orgIds meaning super-admin, an org admin asking a
 * question, and an anonymous embed evaluated as its owner.
 *
 * Run: node --test --test-force-exit core/kb/kbVisibility.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { filterKbIdsForUser, filterKbIdsForEmbed, filterKbIdsForPublicAnswer, filterKbIdsForGroupMember, sharedGroupsOf, reasonFor } = require('./kbVisibility');

const realStore = require('../../stores/knowledgeBases');

function kb(id, over = {}) {
    return {
        id, tenant_id: 'owner', organization_id: 'org1',
        is_published: true, shared_groups: '[]', source_kind: null,
        ...over,
    };
}

/** The real policy function, over a fake table — the policy is not the thing under test. */
function storeOf(rows) {
    const byId = new Map(rows.map(r => [r.id, r]));
    return {
        kbStore: {
            getKB: async (id) => byId.get(id) || null,
            canUserAccessKB: realStore.canUserAccessKB,
        },
    };
}

const ASKER = { userId: 'u_asker', orgIds: new Set(['org1']), userGroups: [] };

test('an org-wide published base is readable', async () => {
    const deps = storeOf([kb('a')]);
    assert.deepStrictEqual(await filterKbIdsForUser(['a'], { ...ASKER, deps }), ['a']);
});

test('a group-restricted base is dropped for someone outside the group', async () => {
    // The bug, in one line.
    const deps = storeOf([kb('a', { shared_groups: '["g_sales"]' })]);
    assert.deepStrictEqual(await filterKbIdsForUser(['a'], { ...ASKER, deps }), []);
    assert.deepStrictEqual(
        await filterKbIdsForUser(['a'], { ...ASKER, userGroups: ['g_sales'], deps }),
        ['a'],
    );
});

test('a draft is dropped for everyone but its owner', async () => {
    const deps = storeOf([kb('a', { is_published: false })]);
    assert.deepStrictEqual(await filterKbIdsForUser(['a'], { ...ASKER, deps }), []);
    assert.deepStrictEqual(await filterKbIdsForUser(['a'], { ...ASKER, userId: 'owner', deps }), ['a']);
});

test('a base in another organisation is dropped', async () => {
    const deps = storeOf([kb('a', { organization_id: 'org2' })]);
    assert.deepStrictEqual(await filterKbIdsForUser(['a'], { ...ASKER, deps }), []);
});

test('an id that resolves to nothing is dropped, not passed through', async () => {
    // Deleted, or never real. Either way it cannot be authorised, and letting
    // it through re-creates the trust-the-client hole.
    const deps = storeOf([]);
    assert.deepStrictEqual(await filterKbIdsForUser(['gone'], { ...ASKER, deps }), []);
});

test('orgIds is coerced to a Set — a null must never mean super-admin', async () => {
    // canUserAccessKB reads `orgIds === null` as super admin and returns true
    // for everything. A resolver that failed and returned null would silently
    // turn this whole filter off.
    const deps = storeOf([kb('a', { organization_id: 'org_other', is_published: false })]);
    for (const orgIds of [null, undefined, ['org1'], 'org1']) {
        assert.deepStrictEqual(
            await filterKbIdsForUser(['a'], { userId: 'u_asker', orgIds, deps }), [],
            `orgIds ${JSON.stringify(orgIds)}`,
        );
    }
});

test('an org admin asking a question is just a person asking a question', async () => {
    // The admin bypass is right for a management screen and wrong here: an
    // answer assembled from a base they only have administrative reach into
    // is a leak whose audit trail says "the agent said it".
    const deps = storeOf([kb('a', { is_published: false }), kb('b', { shared_groups: '["g_sales"]' })]);
    assert.deepStrictEqual(await filterKbIdsForUser(['a', 'b'], { ...ASKER, deps }), []);
});

test('the order of the surviving ids is the order given', async () => {
    const deps = storeOf([kb('a'), kb('b'), kb('c')]);
    assert.deepStrictEqual(await filterKbIdsForUser(['c', 'a', 'b'], { ...ASKER, deps }), ['c', 'a', 'b']);
});

test('a system base is readable by anyone — it is public reference text', async () => {
    const deps = storeOf([kb('a', { source_kind: 'system_managed', organization_id: null, is_published: false })]);
    assert.deepStrictEqual(await filterKbIdsForUser(['a'], { ...ASKER, deps }), ['a']);
});

test('nothing in, nothing out, and no lookups', async () => {
    let asked = 0;
    const deps = { kbStore: { getKB: async () => { asked += 1; return null; }, canUserAccessKB: () => true } };
    assert.deepStrictEqual(await filterKbIdsForUser([], { ...ASKER, deps }), []);
    assert.deepStrictEqual(await filterKbIdsForUser(null, { ...ASKER, deps }), []);
    assert.deepStrictEqual(await filterKbIdsForUser(['', null, 5], { ...ASKER, deps }), []);
    assert.strictEqual(asked, 0);
});

test('warn mode computes the drop and lets it through anyway', async () => {
    // The one-release grace period: an operator sees the blast radius on their
    // own data before it bites.
    const deps = storeOf([kb('a', { shared_groups: '["g_sales"]' })]);
    process.env.KB_VISIBILITY_ENFORCE = 'warn';
    try {
        assert.deepStrictEqual(await filterKbIdsForUser(['a'], { ...ASKER, deps }), ['a']);
    } finally {
        delete process.env.KB_VISIBILITY_ENFORCE;
    }
    // And enforces again the moment it is unset.
    assert.deepStrictEqual(await filterKbIdsForUser(['a'], { ...ASKER, deps }), []);
});

describe_embed();
function describe_embed() {
    const OWNER = { ownerUserId: 'owner', ownerOrgIds: new Set(['org1']) };

    test('an embed sees org-wide published bases only', async () => {
        const deps = storeOf([kb('a')]);
        assert.deepStrictEqual(await filterKbIdsForEmbed(['a'], { ...OWNER, deps }), ['a']);
    });

    test('an embed never sees a draft, even though its owner would', async () => {
        // Evaluated as the owner would be too permissive: an embed is the
        // public internet and a draft is unfinished.
        const deps = storeOf([kb('a', { is_published: false })]);
        assert.deepStrictEqual(await filterKbIdsForEmbed(['a'], { ...OWNER, deps }), []);
    });

    test('an embed never sees a group-restricted base', async () => {
        // It was restricted on purpose, and an anonymous visitor is in no group.
        const deps = storeOf([kb('a', { shared_groups: '["g_sales"]' })]);
        assert.deepStrictEqual(await filterKbIdsForEmbed(['a'], { ...OWNER, deps }), []);
    });

    test('an embed never sees a personal base', async () => {
        const deps = storeOf([kb('a', { organization_id: null })]);
        assert.deepStrictEqual(await filterKbIdsForEmbed(['a'], { ...OWNER, deps }), []);
    });

    test('an embed does see a system base', async () => {
        const deps = storeOf([kb('a', { source_kind: 'system_managed', organization_id: null })]);
        assert.deepStrictEqual(await filterKbIdsForEmbed(['a'], { ...OWNER, deps }), ['a']);
    });

    test('an embed with a broken org resolution sees nothing rather than everything', async () => {
        const deps = storeOf([kb('a')]);
        assert.deepStrictEqual(await filterKbIdsForEmbed(['a'], { ownerUserId: 'owner', ownerOrgIds: null, deps }), []);
    });
}

test('sharedGroupsOf survives the TEXT column holding anything', () => {
    // shared_groups is TEXT holding JSON on this table, not jsonb.
    assert.deepStrictEqual(sharedGroupsOf({ shared_groups: '["a","b"]' }), ['a', 'b']);
    assert.deepStrictEqual(sharedGroupsOf({ shared_groups: '[]' }), []);
    assert.deepStrictEqual(sharedGroupsOf({ shared_groups: null }), []);
    assert.deepStrictEqual(sharedGroupsOf({ shared_groups: 'not json' }), []);
    assert.deepStrictEqual(sharedGroupsOf({ shared_groups: '{"a":1}' }), []);
    assert.deepStrictEqual(sharedGroupsOf(null), []);
});

test('the drop reason names the rule, for the log and nothing else', () => {
    const orgIds = new Set(['org1']);
    assert.strictEqual(reasonFor(null, 'u', orgIds), 'unknown');
    assert.strictEqual(reasonFor(kb('a', { organization_id: null }), 'u', orgIds), 'personal');
    assert.strictEqual(reasonFor(kb('a', { organization_id: 'org2' }), 'u', orgIds), 'other_org');
    assert.strictEqual(reasonFor(kb('a', { is_published: false }), 'u', orgIds), 'draft');
    assert.strictEqual(reasonFor(kb('a', { shared_groups: '["g"]' }), 'u', orgIds), 'group');
});

describe_public_answer();
function describe_public_answer() {
    // The support responder's rule. Its asker is synthetic
    // (`support-ai:<inbox>:<thread>`), so there is no person whose reach could
    // be consulted — and the answer is e-mailed to a customer.
    const IN_ORG = { orgIds: new Set(['org1']) };

    test('an explicit grant still has to be publishable', async () => {
        const deps = storeOf([kb('a'), kb('b', { is_published: false })]);
        assert.deepStrictEqual(
            await filterKbIdsForPublicAnswer(['a', 'b'], { ...IN_ORG, deps }), ['a'],
            'the grant is a snapshot; the base may have been unpublished since',
        );
    });

    test('requireOrgMatch:false skips the ORG test and nothing else', async () => {
        // The legacy single-tenant inbox is configured from a global config
        // key and has no inbox row, so there is no organisation to compare
        // against. That must not become "quote anything".
        const deps = storeOf([
            kb('ok', { organization_id: 'whatever' }),
            kb('draft', { organization_id: 'whatever', is_published: false }),
            kb('grouped', { organization_id: 'whatever', shared_groups: '["g_sales"]' }),
            kb('personal', { organization_id: null }),
            kb('sys', { source_kind: 'system_managed', organization_id: null }),
        ]);
        const out = await filterKbIdsForPublicAnswer(
            ['ok', 'draft', 'grouped', 'personal', 'sys'],
            { orgIds: new Set(), requireOrgMatch: false, deps },
        );
        assert.deepStrictEqual(out, ['ok', 'sys']);
    });

    test('requireOrgMatch defaults to ON — it has to be asked for', async () => {
        const deps = storeOf([kb('a', { organization_id: 'org_other' })]);
        assert.deepStrictEqual(await filterKbIdsForPublicAnswer(['a'], { ...IN_ORG, deps }), []);
    });

    test('warn mode does NOT loosen the public rule', async () => {
        // The grace period exists so an operator can see what a filter would
        // drop from THEIR OWN people's answers. Extending it to what may be
        // e-mailed to a customer would make an env var the thing standing
        // between a draft and an outsider.
        const deps = storeOf([kb('a', { is_published: false })]);
        process.env.KB_VISIBILITY_ENFORCE = 'warn';
        try {
            assert.deepStrictEqual(await filterKbIdsForPublicAnswer(['a'], { ...IN_ORG, deps }), []);
        } finally {
            delete process.env.KB_VISIBILITY_ENFORCE;
        }
    });

    test('an id that resolves to nothing is dropped', async () => {
        const deps = storeOf([]);
        assert.deepStrictEqual(await filterKbIdsForPublicAnswer(['gone'], { ...IN_ORG, deps }), []);
    });
}

// ── filterKbIdsForGroupMember: the "Test as · group X" preview (A1c) ──

{
    const MEMBER = { orgIds: new Set(['org1']), groupId: 'g_sales' };

    test('a member of the group reads the org-wide and the group\'s own bases', async () => {
        const deps = storeOf([kb('open'), kb('sales', { shared_groups: '["g_sales"]' })]);
        assert.deepStrictEqual(
            await filterKbIdsForGroupMember(['open', 'sales'], { ...MEMBER, deps }),
            ['open', 'sales'],
        );
    });

    test('a base restricted to ANOTHER group is not theirs', async () => {
        const deps = storeOf([kb('hr', { shared_groups: '["g_hr"]' })]);
        assert.deepStrictEqual(await filterKbIdsForGroupMember(['hr'], { ...MEMBER, deps }), []);
    });

    test('the simulated member owns nothing — the owner bypass cannot fire', async () => {
        // The reassuring answer this exists to prevent: the editor running the
        // preview usually owns the bases, and `canUserAccessKB` lets an owner
        // through before it ever looks at a group.
        //
        // All three rows below are org-published and restricted to a group the
        // simulated member is NOT in, so the only thing that could keep them is
        // ownership. They cover the three identities somebody might reach for
        // instead of the symbol: the person testing, a null, and a row that
        // arrived without the column at all.
        const deps = storeOf([
            kb('theirs', { tenant_id: 'me', shared_groups: '["g_hr"]' }),
            kb('null_tenant', { tenant_id: null, shared_groups: '["g_hr"]' }),
            kb('no_tenant', { tenant_id: undefined, shared_groups: '["g_hr"]' }),
            kb('control', { shared_groups: '["g_sales"]' }),
        ]);
        assert.deepStrictEqual(
            await filterKbIdsForGroupMember(['theirs', 'null_tenant', 'no_tenant'], { ...MEMBER, deps }),
            [],
        );
        // Not vacuous: a base this group really is in still comes back.
        assert.deepStrictEqual(
            await filterKbIdsForGroupMember(['control'], { ...MEMBER, deps }),
            ['control'],
        );
    });

    test('a draft and another org\'s base are both out', async () => {
        const deps = storeOf([kb('draft', { is_published: false }), kb('elsewhere', { organization_id: 'org2' })]);
        assert.deepStrictEqual(await filterKbIdsForGroupMember(['draft', 'elsewhere'], { ...MEMBER, deps }), []);
    });

    test('public reference text is readable by anybody, member or not', async () => {
        const deps = storeOf([kb('law', { source_kind: 'system_managed', organization_id: null, tenant_id: 'sys' })]);
        assert.deepStrictEqual(await filterKbIdsForGroupMember(['law'], { ...MEMBER, deps }), ['law']);
    });

    test('no group is not "every group"', async () => {
        // A missing groupId is a simulation nobody can evaluate. Returning the
        // input would make an unreadable request the widest one.
        const deps = storeOf([kb('open')]);
        for (const groupId of [undefined, null, '', 42, {}]) {
            assert.deepStrictEqual(
                await filterKbIdsForGroupMember(['open'], { orgIds: MEMBER.orgIds, groupId, deps }),
                [], JSON.stringify(groupId),
            );
        }
    });

    test('null orgIds does not mean super admin here', async () => {
        // `canUserAccessKB` reads a null orgIds as super-admin. A simulated
        // member has no such thing; the coercion to an empty Set is what stops
        // "test as group X" from reading every organisation's bases.
        const deps = storeOf([kb('open')]);
        assert.deepStrictEqual(
            await filterKbIdsForGroupMember(['open'], { orgIds: null, groupId: 'g_sales', deps }),
            [],
        );
    });

    test('an id that resolves to nothing is dropped', async () => {
        assert.deepStrictEqual(
            await filterKbIdsForGroupMember(['gone'], { ...MEMBER, deps: storeOf([]) }),
            [],
        );
    });
}
