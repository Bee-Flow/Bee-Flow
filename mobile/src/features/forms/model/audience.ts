/**
 * Who may fill a form in, edited — the pure half of the web's
 * FormAudienceCard. Two answers: only the people and groups the owner lists
 * (the default for a new form: nobody until someone is added), or everyone
 * in the organisation. Never anyone outside it: the organisation is the outer
 * wall on the server whatever is chosen here. Widening keeps the list, for
 * when the owner narrows it again.
 */

import type { FormAudience } from './types';

export type GranteeType = 'user' | 'group';

export interface Grantee {
    type: GranteeType;
    id: string;
}

/** Groups first, then people — the web's row order. */
export function granteesOf(audience: FormAudience): Grantee[] {
    return [...audience.groups.map((id) => ({ type: 'group' as const, id })), ...audience.users.map((id) => ({ type: 'user' as const, id }))];
}

export function withGrantee(audience: FormAudience, grantee: Grantee): FormAudience {
    if (grantee.type === 'user') {
        return audience.users.includes(grantee.id) ? audience : { ...audience, users: [...audience.users, grantee.id] };
    }
    return audience.groups.includes(grantee.id) ? audience : { ...audience, groups: [...audience.groups, grantee.id] };
}

export function withoutGrantee(audience: FormAudience, grantee: Grantee): FormAudience {
    return grantee.type === 'user'
        ? { ...audience, users: audience.users.filter((x) => x !== grantee.id) }
        : { ...audience, groups: audience.groups.filter((x) => x !== grantee.id) };
}

export const withMode = (audience: FormAudience, mode: FormAudience['mode']): FormAudience => ({ ...audience, mode });

/** Initials for a person's 28dp tile: "Anna de Vries" → "AD". */
export function initialsOf(name: string): string {
    return (
        String(name || '')
            .trim()
            .split(/\s+/)
            .slice(0, 2)
            .map((w) => w[0] ?? '')
            .join('')
            .toUpperCase() || '?'
    );
}
