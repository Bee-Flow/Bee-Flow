/** Form queries. Screens call these rather than useQuery. */

import { useQuery, useQueryClient } from '@tanstack/react-query';

import { useAuth } from '@/core/auth/AuthProvider';

import { getFormDetail, listForms } from '../api/endpoints';
import { formKeys } from '../api/keys';
import { resolveFormRef } from '../model/formPage';
import { loadFormRecents, rememberFormOpened } from '../model/recents';

export function useForms() {
    return useQuery({
        queryKey: formKeys.all,
        queryFn: ({ signal }) => listForms(signal),
    });
}

/** One form for its Form page, by the routine's id. */
export function useFormDetail(automationId: string) {
    return useQuery({
        queryKey: formKeys.detail(automationId),
        queryFn: ({ signal }) => getFormDetail(automationId, signal),
        enabled: Boolean(automationId),
    });
}

/**
 * The routine a Form page route means (model/formPage.ts resolveFormRef). A
 * routine id answers at once; an old link that carries a page token waits for
 * the forms list, then answers that form's routine with `redirect` set.
 */
export function useResolvedFormRef(ref: string) {
    const needsList = resolveFormRef(ref, undefined) === null;
    const forms = useQuery({
        queryKey: formKeys.all,
        queryFn: ({ signal }) => listForms(signal),
        enabled: needsList,
    });
    const resolved = resolveFormRef(ref, forms.data);
    return { resolved, isError: needsList && forms.isError, error: forms.error, refetch: forms.refetch };
}

/** Which forms this person opened, and when — on the device, read once, then kept in step by useRememberFormOpened. */
export function useFormRecents() {
    const userId = useAuth().user?.id ?? '';
    return useQuery({
        queryKey: formKeys.recents(userId),
        queryFn: () => loadFormRecents(userId),
        enabled: Boolean(userId),
        staleTime: Infinity,
    });
}

/** Stamp a form as opened (the web's rememberFormOpened), on the device and in the cache. */
export function useRememberFormOpened(): (formId: string) => void {
    const queryClient = useQueryClient();
    const userId = useAuth().user?.id ?? '';
    return (formId) => {
        if (!userId || !formId) return;
        void rememberFormOpened(userId, formId).then((next) => queryClient.setQueryData(formKeys.recents(userId), next));
    };
}
