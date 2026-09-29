/**
 * Unit tests for the pure third-party org-membership resolver.
 *
 * These pin the union semantics that resolveUserOrgIds (permissions.js:642-672)
 * implements against the DB — the Security People directory groups by this rule,
 * so a divergence here shows up as people filed under the wrong organisation.
 *
 * Run: cd server && node --test auth/orgMembership.test.js
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { parseGroupIds, membershipFor, orgIdsForUser, isMemberOfOrg } = require('./orgMembership');

const GROUPS = [
    { id: 'g_fin', name: 'Finance', organizationId: 'orgA' },
    { id: 'g_sup', name: 'Support', organizationId: 'orgB' },
    { id: 'g_glob', name: 'Everyone', organizationId: null }, // global group
];

describe('parseGroupIds', () => {
    test('accepts an already-parsed array', () => {
        assert.deepEqual(parseGroupIds({ groups: ['a', 'b'] }), ['a', 'b']);
    });

    test('parses the raw JSON TEXT column', () => {
        assert.deepEqual(parseGroupIds({ groups: '["a","b"]' }), ['a', 'b']);
    });

    test('never throws on malformed or absent JSON', () => {
        assert.deepEqual(parseGroupIds({ groups: '{not json' }), []);
        assert.deepEqual(parseGroupIds({ groups: null }), []);
        assert.deepEqual(parseGroupIds({}), []);
        assert.deepEqual(parseGroupIds(null), []);
    });

    test('rejects valid JSON that is not an array', () => {
        assert.deepEqual(parseGroupIds({ groups: '{"a":1}' }), []);
    });
});

describe('membershipFor', () => {
    test('resolves a direct organizationId', () => {
        assert.deepEqual(
            membershipFor({ organizationId: 'orgA', groups: [] }, GROUPS),
            [{ orgId: 'orgA', via: 'direct' }],
        );
    });

    test('resolves membership transitively through a group', () => {
        // The trap: this user has NO organizationId, yet belongs to orgA.
        assert.deepEqual(
            membershipFor({ organizationId: null, groups: ['g_fin'] }, GROUPS),
            [{ orgId: 'orgA', via: 'group:g_fin' }],
        );
    });

    test('keeps both paths to the same org as distinct entries', () => {
        assert.deepEqual(
            membershipFor({ organizationId: 'orgA', groups: ['g_fin'] }, GROUPS),
            [{ orgId: 'orgA', via: 'direct' }, { orgId: 'orgA', via: 'group:g_fin' }],
        );
        // ...but the org itself is counted once.
        assert.deepEqual([...orgIdsForUser({ organizationId: 'orgA', groups: ['g_fin'] }, GROUPS)], ['orgA']);
    });

    test("treats organizationId '' — the column DEFAULT — as no org", () => {
        assert.deepEqual(membershipFor({ organizationId: '', groups: [] }, GROUPS), []);
    });

    test('gives a global group (organizationId null) no org membership', () => {
        assert.deepEqual(membershipFor({ organizationId: '', groups: ['g_glob'] }, GROUPS), []);
    });

    test('spans multiple orgs when the paths disagree', () => {
        assert.deepEqual(
            membershipFor({ organizationId: 'orgA', groups: ['g_sup'] }, GROUPS),
            [{ orgId: 'orgA', via: 'direct' }, { orgId: 'orgB', via: 'group:g_sup' }],
        );
    });

    test('ignores a group id that resolves to nothing', () => {
        assert.deepEqual(membershipFor({ organizationId: '', groups: ['g_gone'] }, GROUPS), []);
    });

    test('reads groups straight from the JSON TEXT column', () => {
        assert.deepEqual(
            membershipFor({ organizationId: null, groups: '["g_fin"]' }, GROUPS),
            [{ orgId: 'orgA', via: 'group:g_fin' }],
        );
    });

    test('survives an empty group table and a null user', () => {
        assert.deepEqual(membershipFor({ organizationId: 'orgA', groups: ['g_fin'] }, []), [
            { orgId: 'orgA', via: 'direct' },
        ]);
        assert.deepEqual(membershipFor(null, GROUPS), []);
        assert.deepEqual(membershipFor({ organizationId: 'orgA' }), [{ orgId: 'orgA', via: 'direct' }]);
    });
});

describe('isMemberOfOrg', () => {
    test('is true through either path and false otherwise', () => {
        const viaGroup = { organizationId: null, groups: ['g_fin'] };
        assert.equal(isMemberOfOrg(viaGroup, GROUPS, 'orgA'), true);
        assert.equal(isMemberOfOrg(viaGroup, GROUPS, 'orgB'), false);
        assert.equal(isMemberOfOrg({ organizationId: 'orgB' }, GROUPS, 'orgB'), true);
    });

    test('is false for a falsy org id rather than matching the empty default', () => {
        assert.equal(isMemberOfOrg({ organizationId: '' }, GROUPS, ''), false);
        assert.equal(isMemberOfOrg({ organizationId: '' }, GROUPS, undefined), false);
    });
});
