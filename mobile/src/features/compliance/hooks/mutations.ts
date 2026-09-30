/**
 * The hub's writes. Every one invalidates the whole `compliance` key space:
 * a DSR that closes moves the counts, the deadlines, the attention list and a
 * framework's score at once, and a partial refresh would show them disagreeing.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';

import {
    autoFixCheck,
    finishSetup,
    rerunCheck,
    reviewRopa,
    runAllChecks,
    saveSettings,
    sendWrite,
    setFrameworkEnabled,
    setFrameworkRelevance,
    setScc,
} from '../api/endpoints';
import { complianceKeys } from '../api/keys';
import type { WriteRequest } from '../model/types';

function useInvalidating<TArgs, TResult>(fn: (args: TArgs) => Promise<TResult>) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: fn,
        onSettled: () => client.invalidateQueries({ queryKey: complianceKeys.all }),
    });
}

/** One register write, as its registry entry built it. */
export const useComplianceWrite = () => useInvalidating((request: WriteRequest) => sendWrite(request));

export const useRunAllChecks = () => useInvalidating(() => runAllChecks());

export const useRerunCheck = () => useInvalidating((checkId: string) => rerunCheck(checkId));

export const useAutoFixCheck = () => useInvalidating((checkId: string) => autoFixCheck(checkId));

export const useToggleFramework = () =>
    useInvalidating(({ id, enabled }: { id: string; enabled: boolean }) => setFrameworkEnabled(id, enabled));

export const useFrameworkRelevance = () =>
    useInvalidating(({ id, relevance }: { id: string; relevance: string }) => setFrameworkRelevance(id, relevance));

/** Save the changed columns; before setup is finished this also stamps it (POST /settings/onboarded). */
export const useSaveComplianceSettings = () =>
    useInvalidating(({ patch, onboarded }: { patch: Record<string, unknown>; onboarded: boolean }) =>
        onboarded ? saveSettings(patch) : finishSetup(patch),
    );

export const useReviewRopa = () => useInvalidating(() => reviewRopa());

export const useSetScc = () => useInvalidating(({ operator, confirmed }: { operator: string; confirmed: boolean }) => setScc(operator, confirmed));
