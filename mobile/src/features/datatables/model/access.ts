/**
 * Who can read a table, who can change it, and what YOU may do with it.
 *
 * Three words that are not interchangeable (the web's DatatableCard says so at
 * length): the SCOPE is the tenancy (an organisation, or this account alone),
 * the AUDIENCE is who a shared organisation table is published to, and the
 * GRADE is what the caller may do. Port of the web's datatableDisplay.js
 * audience and grade helpers, pinned by display.lockstep.test.ts.
 */

import type { Audience, Datatable, Grade } from './types';

/** The web's names for the three audiences (datatableDisplay PRIVATE/ORG/GROUPS). */
export type AudienceId = 'private' | 'org' | 'groups';

/**
 * `sharedGroups: []` on a PUBLISHED table means the whole organisation, not
 * nobody (auth/audience.js) — a picker that read the empty list as "no one
 * yet" would say "nobody can see this" over a table the company can read.
 */
export function audienceOf(table: Pick<Datatable, 'isPublished' | 'sharedGroups'> | null | undefined): AudienceId {
    if (!table?.isPublished) return 'private';
    return table.sharedGroups.length ? 'groups' : 'org';
}

/** The sharing route's word for each audience. */
export const AUDIENCE_WORD: Readonly<Record<AudienceId, Audience>> = {
    private: 'private',
    org: 'organisation',
    groups: 'groups',
};

const GRADE_ORDER: Readonly<Record<string, number>> = { viewer: 0, editor: 1, owner: 2 };

export function gradeAtLeast(grade: Grade | null | undefined, min: Grade): boolean {
    return (GRADE_ORDER[grade ?? ''] ?? -1) >= (GRADE_ORDER[min] ?? 99);
}

/**
 * May this session change the table itself (columns, name, sharing)? The
 * owner, and on an ORGANISATION table only with `manage_datatables` — the
 * server asks for it on org scope alone, so an owner of a personal table
 * never needs it.
 */
export function canEditTable(table: Pick<Datatable, 'grade' | 'scopeKind'>, canManage: boolean): boolean {
    return table.grade === 'owner' && (canManage || table.scopeKind === 'user');
}

/**
 * A change that hands real people access they did not have a second ago —
 * the web asks before each of these and never before a narrowing.
 */
export function widens(from: AudienceId, to: AudienceId): boolean {
    const rank: Record<AudienceId, number> = { private: 0, groups: 1, org: 2 };
    return rank[to] > rank[from];
}
