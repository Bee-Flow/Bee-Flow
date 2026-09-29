import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import {
    skillKeys,
    useCreateSkill,
    useDeleteSkill,
    useSkillsQuery,
    useUpdateSkill,
    type Skill,
    type SkillForm,
} from '../api/queries/skills';
import { queryClient } from '../api/queryClient';

export type { Skill, SkillForm };

/**
 * Forget the cached list.
 *
 * The list used to live in this module and logout does not reload the page —
 * so without an invalidator the next account to sign in on the same browser
 * read the previous one's skills (names, descriptions, and skills shared only
 * with their groups) until something happened to call `refresh()`. It now
 * lives in the shared React Query cache, which `AuthedApp` clears on logout;
 * this drops just the skills, for a screen that changed them elsewhere.
 * Called from `hooks/sessionCaches.clearSessionCaches`.
 */
export function invalidateSkills(): void {
    queryClient.removeQueries({ queryKey: skillKeys.all });
}

export interface UseSkillsReturn {
    skills: Skill[];
    loading: boolean;
    error: string | null;
    refresh: () => Promise<void>;
    create: (form: SkillForm) => Promise<Skill>;
    update: (id: string, form: SkillForm) => Promise<void>;
    remove: (id: string) => Promise<void>;
}

/**
 * The skills list and its three writes, for the panels that show it.
 *
 * A thin adapter over `api/queries/skills`: every mounted copy reads the one
 * cached list, a write invalidates it, and the callers keep the shape they
 * already consume (`skills`, `loading`, `error`, and three promises that
 * settle once the list is fresh again).
 */
export function useSkills(): UseSkillsReturn {
    const qc = useQueryClient();
    const query = useSkillsQuery();
    const createSkill = useCreateSkill();
    const updateSkill = useUpdateSkill();
    const deleteSkill = useDeleteSkill();

    const refresh = useCallback(async () => {
        await qc.invalidateQueries({ queryKey: skillKeys.all });
    }, [qc]);

    const create = useCallback(
        (form: SkillForm) => createSkill.mutateAsync(form),
        [createSkill],
    );
    const update = useCallback(
        (id: string, form: SkillForm) => updateSkill.mutateAsync({ id, form }),
        [updateSkill],
    );
    const remove = useCallback(
        (id: string) => deleteSkill.mutateAsync(id),
        [deleteSkill],
    );

    return {
        skills: query.data ?? [],
        // Any load in flight, which is what this flag meant before the list
        // moved into the shared cache: a refresh lit it too.
        loading: query.isPending || query.isFetching,
        error: query.error ? query.error.message : null,
        refresh,
        create,
        update,
        remove,
    };
}
