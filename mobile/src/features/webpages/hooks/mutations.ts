/**
 * Writes to the page itself: create, clone, save its settings, publish,
 * share, delete. The screen passes its own feedback as handlers.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';

import { usePageMutation, type Handlers } from './pageMutation';
import {
    cloneWebpage,
    createWebpage,
    createWebpageShare,
    deleteWebpage,
    refreshWebpageShare,
    revokeWebpageShare,
    setWebpagePublished,
    updateWebpage,
    type WebpagePatch,
} from '../api/endpoints';
import { webpageKeys } from '../api/keys';
import type { CreatedWebpageShare, Webpage } from '../model/types';

export type { Handlers } from './pageMutation';

export function useSetWebpagePublished(id: string, handlers: Handlers<boolean, boolean> = {}) {
    return usePageMutation(id, (next: boolean) => setWebpagePublished(id, next), { handlers });
}

/** Freeze what the page is now for the people who can already see it. */
export function useRepublishWebpage(id: string, handlers: Handlers<boolean, void> = {}) {
    return usePageMutation(id, () => setWebpagePublished(id, true, true), { handlers });
}

type ShareOptions = { password?: string; title?: string };

export function useCreateWebpageShare(id: string, handlers: Handlers<CreatedWebpageShare | null, ShareOptions> = {}) {
    return usePageMutation(id, (options: ShareOptions) => createWebpageShare(id, options), { handlers });
}

export function useRefreshWebpageShare(id: string, handlers: Handlers<void, string> = {}) {
    return usePageMutation(id, (shareId: string) => refreshWebpageShare(id, shareId), { handlers });
}

export function useRevokeWebpageShare(id: string, handlers: Handlers<void, string> = {}) {
    return usePageMutation(id, (shareId: string) => revokeWebpageShare(id, shareId), { handlers });
}

/** `confirmedBreaking` only once the guard's 409 answer has been shown. */
export function useDeleteWebpage(id: string, handlers: Handlers<void, boolean> = {}) {
    return usePageMutation(id, (confirmedBreaking: boolean) => deleteWebpage(id, { confirmedBreaking }), {
        handlers,
        // The page is gone; asking for its detail again would only 404.
        refresh: () => [webpageKeys.all],
    });
}

export type NewWebpage = Parameters<typeof createWebpage>[0];

export function useCreateWebpage(handlers: Handlers<Webpage | null, NewWebpage> = {}) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (input: NewWebpage) => createWebpage(input),
        onSuccess: (page, input) => {
            handlers.onSuccess?.(page, input);
            void queryClient.invalidateQueries({ queryKey: webpageKeys.all });
        },
        onError: handlers.onError,
    });
}

export function useCloneWebpage(id: string, handlers: Handlers<Webpage | null, string | undefined> = {}) {
    return usePageMutation(id, (name: string | undefined) => cloneWebpage(id, name), {
        handlers,
        refresh: () => [webpageKeys.all],
    });
}

export function useUpdateWebpage(id: string, handlers: Handlers<void, WebpagePatch> = {}) {
    return usePageMutation(id, (patch: WebpagePatch) => updateWebpage(id, patch), { handlers });
}
