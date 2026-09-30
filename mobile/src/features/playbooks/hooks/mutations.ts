/**
 * Playbook writes other than the phase transitions (those are
 * usePlaybookActions): compose, create, delete, and the three writes a stage
 * makes on its own — the access proposal and its approval, the compliance
 * registration and its re-check. A write that answers with the playbook
 * hands it straight to the cache, so nothing re-reads what it already has.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';

import {
    assignAppMember,
    composeRecipe,
    createPlaybook,
    deletePlaybook,
    proposeAccess,
    publishApp,
    recheckCompliance,
    registerCompliance,
} from '../api/endpoints';
import { playbookKeys } from '../api/keys';
import { applyAccessPlan } from '../model/accessApply';
import type { AccessPlan, Playbook } from '../model/types';

export function useComposeRecipe() {
    return useMutation({
        mutationFn: ({ description, locale }: { description: string; locale: string }) => composeRecipe(description, locale),
    });
}

export function useCreatePlaybook() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (body: Record<string, unknown>) => createPlaybook(body),
        onSuccess: (pb) => {
            if (pb) queryClient.setQueryData(playbookKeys.detail(pb.id), pb);
            void queryClient.invalidateQueries({ queryKey: playbookKeys.list });
        },
    });
}

/** Deletes the playbook only — its table, automation and app stay. */
export function useDeletePlaybook() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (id: string) => deletePlaybook(id),
        onSuccess: (_void, id) => {
            queryClient.removeQueries({ queryKey: playbookKeys.detail(id) });
            void queryClient.invalidateQueries({ queryKey: playbookKeys.list });
        },
    });
}

function useAdopt(id: string) {
    const queryClient = useQueryClient();
    return (pb: Playbook | null) => {
        if (pb) queryClient.setQueryData(playbookKeys.detail(id), pb);
        else void queryClient.invalidateQueries({ queryKey: playbookKeys.detail(id) });
    };
}

export function useProposeAccess(id: string, key: string) {
    return useMutation({ mutationFn: (message: string) => proposeAccess(id, key, message) });
}

/** Apply an approved plan's people and audience, then re-read where the app stands. */
export function useApplyAccess(appId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (plan: AccessPlan) => applyAccessPlan(plan, {
            assignMember: (userId, roleKey) => assignAppMember(appId, userId, roleKey),
            publish: (body) => publishApp(appId, body),
        }),
        onSettled: () => void queryClient.invalidateQueries({ queryKey: playbookKeys.app(appId) }),
    });
}

export function useRegisterCompliance(id: string, key: string) {
    const adopt = useAdopt(id);
    return useMutation({
        mutationFn: (body: Record<string, unknown>) => registerCompliance(id, key, body),
        onSuccess: (res) => adopt(res.playbook),
    });
}

export function useRecheckCompliance(id: string, key: string) {
    const adopt = useAdopt(id);
    return useMutation({ mutationFn: () => recheckCompliance(id, key), onSuccess: adopt });
}
