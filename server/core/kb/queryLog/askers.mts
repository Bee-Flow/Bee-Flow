/**
 * askers.mts: who asked, as a manager of a knowledge base sees it.
 *
 * Unless the base is set to show names, a manager gets a stable pseudonym per asker instead of the user
 * id and name (purpose limitation: the log is for checking answers, not for watching people). The
 * pseudonym is keyed with the server secret and scoped to the organisation (core/privacy/pseudonym.js,
 * its own key domain), so it cannot be recomputed from a user id and cannot be joined with the labels of
 * other reports. The compliance routes do not use this: a data-subject request needs real ids.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type Pseudonym = {
    pseudonymFor: (userId: string, orgId: string, secret: string, o?: { domain: string }) => string;
    pseudonymId: (userId: string, orgId: string, secret: string, o?: { domain: string }) => string;
    pseudonymSecret: () => string;
};
const lib = (): Pseudonym => nodeRequire('../../privacy/pseudonym.js');
const DOMAIN = { domain: 'kb-query-log' };

/** A filter value that matches nobody (a pseudonym that does not exist must give an empty list, not everything). */
export const NO_SUCH_ASKER = '\uFFFD-no-such-asker';

export interface KbNamePolicy { organization_id?: string | null; query_log_show_names?: boolean | null }

export const showsNames = (kb: KbNamePolicy | null | undefined): boolean => kb?.query_log_show_names === true;

/** The label and the stable id of one asker in one organisation. */
export function askerPseudonym(userId: string, orgId: string): { label: string; id: string } {
    const secret = lib().pseudonymSecret();
    return { label: lib().pseudonymFor(userId, orgId, secret, DOMAIN), id: lib().pseudonymId(userId, orgId, secret, DOMAIN) };
}

/**
 * The row as a manager may see it: with names, unchanged; without, `userId` and `userName` are gone and
 * `askerPseudonym` (label) and `askerPseudonymId` (the value for the person filter) stand in. An
 * anonymous row (no user) has both as null.
 */
export function maskAsker<T extends { userId?: string | null; userName?: string | null; organizationId?: string | null }>(
    row: T, kb: KbNamePolicy,
): Omit<T, 'userId' | 'userName'> & { userId?: string | null; userName?: string | null; askerPseudonym?: string | null; askerPseudonymId?: string | null } {
    if (showsNames(kb)) return row;
    const { userId, userName: _name, ...rest } = row;
    const org = kb.organization_id ?? row.organizationId ?? null;
    const p = userId && org ? askerPseudonym(userId, org) : null;
    return { ...rest, askerPseudonym: p?.label ?? null, askerPseudonymId: p?.id ?? null };
}

/**
 * The user id to filter on. With names shown the value is the user id as before. Without, only a pseudonym
 * id works (a real user id must not confirm that a person asked): it is looked up among the people who
 * asked this base.
 */
export async function resolveAskerFilter(
    value: string | null | undefined, kb: KbNamePolicy & { id: string }, askersOf: (kbId: string) => Promise<string[]>,
): Promise<string | null> {
    if (!value) return null;
    if (showsNames(kb)) return value;
    const org = kb.organization_id;
    if (!org) return NO_SUCH_ASKER;
    for (const userId of await askersOf(kb.id)) if (askerPseudonym(userId, org).id === value) return userId;
    return NO_SUCH_ASKER;
}
