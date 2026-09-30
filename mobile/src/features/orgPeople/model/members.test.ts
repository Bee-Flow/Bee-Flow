import {
    displayName,
    filtersActive,
    groupMembers,
    isPending,
    matchesFilters,
    memberRole,
    NO_FILTERS,
    orgMembers,
    pendingCount,
    sortMembers,
    toggledGroups,
} from './members';
import type { Member } from './types';

const m = (id: string, extra: Partial<Member> = {}): Member => ({
    id,
    avatar: null,
    avatarType: null,
    groups: [],
    lastSeenAt: null,
    ...extra,
});

describe('displayName', () => {
    it('prefers the display name, then first and last, then the handle, then the id', () => {
        expect(displayName(m('1', { displayName: 'Ada L.' }))).toBe('Ada L.');
        expect(displayName(m('2', { firstName: 'Ada', lastName: 'Lovelace' }))).toBe('Ada Lovelace');
        expect(displayName(m('3', { username: 'ada' }))).toBe('ada');
        expect(displayName(m('4'))).toBe('4');
    });
});

describe('roles and status', () => {
    it('reads the org role, then the platform role, then "user"', () => {
        expect(memberRole(m('a', { orgRole: 'dpo', role: 'admin' }))).toBe('dpo');
        expect(memberRole(m('b', { role: 'admin' }))).toBe('admin');
        expect(memberRole(m('c'))).toBe('user');
    });

    it('counts pending sign-ups and drops only the system account', () => {
        const roster = [m('a', { status: 'pending' }), m('b'), m('admin', { isSystem: true, status: 'pending' })];
        expect(orgMembers(roster).map((x) => x.id)).toEqual(['a', 'b']);
        expect(pendingCount(orgMembers(roster))).toBe(1);
        expect(isPending(roster[1] as Member)).toBe(false);
    });
});

describe('matchesFilters (the web useUserFilters, role and status axes)', () => {
    const ada = m('1', { displayName: 'Ada', email: 'ada@x.nl', orgRole: 'org_admin' });
    const bob = m('2', { username: 'bob', status: 'pending' });
    const cy = m('3', { displayName: 'Cy', orgRole: 'member' });

    it('searches name, handle and e-mail, case-insensitively', () => {
        expect(matchesFilters(ada, { ...NO_FILTERS, search: ' ADA@X ' })).toBe(true);
        expect(matchesFilters(bob, { ...NO_FILTERS, search: 'bo' })).toBe(true);
        expect(matchesFilters(cy, { ...NO_FILTERS, search: 'zz' })).toBe(false);
    });

    it('treats "user" as user or member, and any other role exactly', () => {
        const user = { ...NO_FILTERS, role: 'user' };
        expect([ada, bob, cy].filter((x) => matchesFilters(x, user)).map((x) => x.id)).toEqual(['2', '3']);
        expect(matchesFilters(ada, { ...NO_FILTERS, role: 'org_admin' })).toBe(true);
        expect(matchesFilters(cy, { ...NO_FILTERS, role: 'org_admin' })).toBe(false);
    });

    it('reads a missing status as active', () => {
        expect(matchesFilters(ada, { ...NO_FILTERS, status: 'active' })).toBe(true);
        expect(matchesFilters(bob, { ...NO_FILTERS, status: 'active' })).toBe(false);
        expect(matchesFilters(bob, { ...NO_FILTERS, status: 'pending' })).toBe(true);
    });

    it('knows when any filter is on', () => {
        expect(filtersActive(NO_FILTERS)).toBe(false);
        expect(filtersActive({ ...NO_FILTERS, status: 'pending' })).toBe(true);
        expect(filtersActive({ ...NO_FILTERS, search: 'x' })).toBe(true);
    });
});

describe('ordering and groups', () => {
    it('puts pending sign-ups first, then sorts by name', () => {
        const roster = [m('z', { displayName: 'Zoe' }), m('p', { displayName: 'Piet', status: 'pending' }), m('a', { displayName: 'Anna' })];
        expect(sortMembers(roster).map((x) => x.id)).toEqual(['p', 'a', 'z']);
    });

    it('lists a group’s members and toggles one group in a member’s list', () => {
        const roster = [m('a', { displayName: 'B', groups: ['g1'] }), m('b', { displayName: 'A', groups: ['g1', 'g2'] }), m('c')];
        expect(groupMembers(roster, 'g1').map((x) => x.id)).toEqual(['b', 'a']);
        expect(toggledGroups(['g1', 'g2'], 'g1')).toEqual(['g2']);
        expect(toggledGroups(['g2'], 'g1')).toEqual(['g2', 'g1']);
    });
});
