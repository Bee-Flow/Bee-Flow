/**
 * The org's member directory behind the owner, DPO and attester pickers:
 * GET /api/compliance/org-users (server/routes/compliance/orgUsers.js).
 */

import { api } from '@/core/api/client';
import { field, shapeListOf } from '@/core/api/contract';

import { COMPLIANCE } from '../model/paths';

/** One member: name, contact and org role. */
export const readMembers = shapeListOf({
    id: field.str(''),
    displayName: field.str(''),
    email: field.strOrNull,
    phone: field.strOrNull,
    orgRole: field.strOrNull,
});
export type Member = ReturnType<typeof readMembers>[number];

export const memberKeys = { all: ['compliance', 'members'] as const };

export const getMembers = async (signal?: AbortSignal): Promise<Member[]> =>
    readMembers(await api.get<unknown>(`${COMPLIANCE}/org-users`, { signal }));
