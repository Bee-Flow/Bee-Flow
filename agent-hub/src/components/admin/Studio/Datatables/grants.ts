/**
 * One datatable grant as the sharing tab uses it.
 *
 * The server sends the stored row's own spelling, `grantee_type` /
 * `grantee_id` (stores/datatableStore/rowMappers.rowToGrant — the mobile
 * client and the server contract test read it that way too), while this tab
 * was written against `granteeType` / `granteeId`. Every grant therefore read
 * as "not a group", found no name, and a group grant such as Purchasing showed
 * as "? A person" — and changing its grade re-sent an empty grantee.
 * Both spellings are accepted so either side can move without breaking the other.
 */
export type GranteeType = 'user' | 'group';

export interface DatatableGrant {
    id: string;
    granteeType: GranteeType;
    granteeId: string;
    grade: 'viewer' | 'editor';
}

type RawGrant = Record<string, unknown> | null | undefined;

export function readGrant(raw: RawGrant): DatatableGrant | null {
    if (!raw || typeof raw !== 'object') return null;
    const type = raw.grantee_type ?? raw.granteeType;
    const granteeId = raw.grantee_id ?? raw.granteeId;
    if ((type !== 'user' && type !== 'group') || typeof granteeId !== 'string' || !granteeId) return null;
    if (typeof raw.id !== 'string' || !raw.id) return null;
    return { id: raw.id, granteeType: type, granteeId, grade: raw.grade === 'editor' ? 'editor' : 'viewer' };
}

/** The grants of a `{ grants }` answer, unreadable entries dropped. */
export function readGrants(list: unknown): DatatableGrant[] {
    if (!Array.isArray(list)) return [];
    return list.map((g) => readGrant(g as RawGrant)).filter((g): g is DatatableGrant => g !== null);
}
