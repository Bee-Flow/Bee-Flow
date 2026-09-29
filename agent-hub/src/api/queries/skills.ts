// Skills — the ONLY place that knows the /api/skills wire contract.
//
// The list used to live in a module-level `let cache` inside hooks/useSkills,
// with a Set of listeners to push changes at every mounted copy. That is a
// second cache beside the React Query one, and it had the fault a
// session-scoped cache always has: logout does not reload the page, so the
// next account to sign in on the same browser read the previous one's skills
// until something happened to call refresh(). The shared client is cleared on
// logout (AuthedApp), so putting the list here is also what fixes that.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, apiClient } from '../client';

/** A skill row. The editor round-trips fields this layer never reads, so the
 *  rest of the row travels untouched. */
export interface Skill {
    id: string;
    name?: string;
    description?: string;
    [key: string]: unknown;
}

/** The editor's form body, posted verbatim. */
export type SkillForm = Record<string, unknown>;

export const skillKeys = {
    all: ['skills'] as const,
    list: () => [...skillKeys.all, 'list'] as const,
};

/**
 * 403 and 404 are not failures here: they mean the feature is switched off for
 * this account or this install, which reads as "no skills" — the same answer
 * the endpoint gives an account that simply has none.
 */
async function fetchSkills(signal?: AbortSignal): Promise<Skill[]> {
    try {
        return (await apiClient.get<Skill[]>('/api/skills', { signal })) ?? [];
    } catch (e) {
        if (e instanceof ApiError && (e.status === 403 || e.status === 404)) return [];
        throw new Error('Failed to load skills');
    }
}

export function useSkillsQuery() {
    return useQuery<Skill[], Error>({
        queryKey: skillKeys.list(),
        queryFn: ({ signal }) => fetchSkills(signal),
    });
}

/** The message the server sent, or the given fallback. */
function messageOf(e: unknown, fallback: string): string {
    if (e instanceof ApiError) {
        const body = e.body as { error?: string } | null;
        return body?.error || fallback;
    }
    return fallback;
}

export function useCreateSkill() {
    const qc = useQueryClient();
    return useMutation<Skill, Error, SkillForm>({
        mutationFn: async (form) => {
            let created: Skill | null;
            try {
                created = await apiClient.post<Skill>('/api/skills', form);
            } catch (e) {
                throw new Error(messageOf(e, 'Failed to create skill'));
            }
            // The route answers with the row it wrote; a body-less 2xx would
            // leave the caller with nothing to open.
            if (!created) throw new Error('Failed to create skill');
            return created;
        },
        onSuccess: () => qc.invalidateQueries({ queryKey: skillKeys.all }),
    });
}

export function useUpdateSkill() {
    const qc = useQueryClient();
    return useMutation<void, Error, { id: string; form: SkillForm }>({
        mutationFn: async ({ id, form }) => {
            try {
                await apiClient.put(`/api/skills/${id}`, form);
            } catch (e) {
                throw new Error(messageOf(e, 'Failed to update skill'));
            }
        },
        onSuccess: () => qc.invalidateQueries({ queryKey: skillKeys.all }),
    });
}

export function useDeleteSkill() {
    const qc = useQueryClient();
    return useMutation<void, Error, string>({
        mutationFn: async (id) => {
            try {
                await apiClient.delete(`/api/skills/${id}`);
            } catch (e) {
                throw new Error(messageOf(e, 'Failed to delete skill'));
            }
        },
        onSuccess: () => qc.invalidateQueries({ queryKey: skillKeys.all }),
    });
}
