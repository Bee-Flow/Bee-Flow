/**
 * Naming, filtering and ordering the member roster — the port of the web's
 * useUserFilters (agent-hub/src/hooks/useUserFilters.ts) for the two axes an
 * organisation's own list uses: role and status. The org and via axes belong
 * to the super-admin directory, which spans organisations.
 */

import { personName } from '@/shared/lib/display';

import type { Member } from './types';

export interface MemberFilters {
    search: string;
    /** 'all', 'user' (user or member), or an org role id. */
    role: string;
    /** 'all' | 'active' | 'pending'. */
    status: string;
}

export const NO_FILTERS: Readonly<MemberFilters> = Object.freeze({ search: '', role: 'all', status: 'all' });

/** The roster's name for a member (shared with every other list of people). */
export const displayName: (member: Pick<Member, 'id' | 'displayName' | 'firstName' | 'lastName' | 'username'>) => string = personName;

export function isPending(member: Member): boolean {
    return member.status === 'pending';
}

/** The role a member holds in the organisation; the web's RoleBadge reads the same. */
export function memberRole(member: Member): string {
    return member.orgRole || member.role || 'user';
}

/** Trust the server's scoping; only the system account is dropped, as on the web. */
export function orgMembers(members: readonly Member[]): Member[] {
    return members.filter((m) => !m.isSystem);
}

function matchesSearch(member: Member, needle: string): boolean {
    const hay = `${member.displayName ?? ''} ${member.username ?? ''} ${member.email ?? ''}`.toLowerCase();
    return hay.includes(needle);
}

function matchesRole(member: Member, role: string): boolean {
    if (role === 'all') return true;
    const held = memberRole(member);
    if (role === 'user') return held === 'user' || held === 'member';
    return held === role;
}

export function matchesFilters(member: Member, filters: MemberFilters): boolean {
    const needle = filters.search.trim().toLowerCase();
    if (needle && !matchesSearch(member, needle)) return false;
    if (!matchesRole(member, filters.role)) return false;
    if (filters.status !== 'all' && (member.status || 'active') !== filters.status) return false;
    return true;
}

export function filtersActive(filters: MemberFilters): boolean {
    return filters.search !== '' || filters.role !== 'all' || filters.status !== 'all';
}

/** Pending sign-ups first — they are waiting on this screen — then by name. */
export function sortMembers(members: readonly Member[]): Member[] {
    return [...members].sort((a, b) => {
        const pending = Number(isPending(b)) - Number(isPending(a));
        return pending || displayName(a).localeCompare(displayName(b));
    });
}

export function pendingCount(members: readonly Member[]): number {
    return members.filter(isPending).length;
}

export function groupMembers(members: readonly Member[], groupId: string): Member[] {
    return sortMembers(members.filter((m) => m.groups.includes(groupId)));
}

/** A member's groups with one toggled — the body of PUT /auth/users/:id { groups }. */
export function toggledGroups(current: readonly string[], groupId: string): string[] {
    return current.includes(groupId) ? current.filter((g) => g !== groupId) : [...current, groupId];
}
