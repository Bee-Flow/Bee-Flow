/**
 * Skill writes. Each refreshes every skill query; the screen passes its own
 * feedback (close a sheet, toast, navigate) as handlers. The autosave of an
 * open skill is not here — it is useSkillEditor, which owns its own timing.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';

import { createSkill, deleteSkill, draftSkill, improveSkill } from '../api/endpoints';
import { skillKeys } from '../api/keys';
import type { Skill, SkillDraft, SkillProposal } from '../model/types';

interface Handlers<D, V> {
    onSuccess?: (data: D, vars: V) => void;
    onError?: (error: Error, vars: V) => void;
}

export type NewSkill = Partial<SkillDraft> & { name: string };

export function useCreateSkill(handlers: Handlers<Skill | null, NewSkill> = {}) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (draft: NewSkill) => createSkill(draft),
        onSuccess: (skill, draft) => {
            void queryClient.invalidateQueries({ queryKey: skillKeys.all });
            handlers.onSuccess?.(skill, draft);
        },
    });
}

export interface SkillDeletion {
    skill: Skill;
    /** True only once the guard's 409 answer has been shown. */
    confirmed: boolean;
}

export function useDeleteSkill(handlers: Handlers<void, SkillDeletion> = {}) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: ({ skill, confirmed }: SkillDeletion) => deleteSkill(skill.id, { confirmedBreaking: confirmed }),
        onSuccess: (_result, vars) => {
            handlers.onSuccess?.(undefined, vars);
            void queryClient.invalidateQueries({ queryKey: skillKeys.all });
        },
        onError: handlers.onError,
    });
}

/** One sentence → a proposal. Nothing is stored. */
export function useDraftSkill(handlers: Handlers<SkillProposal | null, string> = {}) {
    return useMutation({
        mutationFn: (sentence: string) => draftSkill(sentence),
        onSuccess: handlers.onSuccess,
        onError: handlers.onError,
    });
}

/** The server rewrites and STORES; the screen adopts the stored row. */
export function useImproveSkill(id: string, handlers: Handlers<Skill | null, void> = {}) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: () => improveSkill(id),
        onSuccess: (skill) => {
            void queryClient.invalidateQueries({ queryKey: skillKeys.all });
            handlers.onSuccess?.(skill, undefined);
        },
        onError: handlers.onError,
    });
}
