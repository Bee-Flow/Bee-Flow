// The document a fill-in form fills in (api/templateFillApi.ts), cached per
// document and per answer: `revision` is how many template-fill results the
// answer holds for it, so a new tool result in a live turn reads it again. The
// form keeps showing what it has while that read is on its way (it merges the
// new values in place: nothing a person is typing is thrown away).

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { FillDocument, FilledPreviewPage } from '../templateFillApi';
import { apiJson } from '../typedRequest';
import { useOptionalQueryClient } from './optionalQueryClient';

const templateFillKey = (id: string) => ['templateFill', id] as const;

export function useFillDocumentQuery(id: string, revision: number, load: (id: string) => Promise<FillDocument>) {
    const { client, attached } = useOptionalQueryClient();
    return useQuery<FillDocument, Error>({
        queryKey: [...templateFillKey(id), revision],
        enabled: attached && !!id,
        queryFn: () => load(id),
        retry: false,
        placeholderData: keepPreviousData,
        // A form that opens again (another tab of the editor, an answer scrolled back into view) reads the
        // document anew: what an earlier form read is older than what that form itself saved since.
        gcTime: 0,
    }, client);
}

/**
 * The document with what is filled in so far. `revision` is the document's
 * revision as the form last heard it: each save of a value is another one, so
 * the page is read again, and the one on screen stays until the new one is in.
 */
export function useFilledPreviewQuery(id: string, revision: string, load: ((id: string) => Promise<FilledPreviewPage>) | undefined) {
    const { client, attached } = useOptionalQueryClient();
    return useQuery<FilledPreviewPage, Error>({
        queryKey: [...templateFillKey(id), 'preview', revision],
        enabled: attached && !!id && !!load,
        queryFn: () => (load ? load(id) : Promise.reject(new Error('no preview'))),
        retry: false,
        placeholderData: keepPreviousData,
        gcTime: 0,
    }, client);
}

/** Who is reading a form whose host did not say (a chat answer): the signed-in person's id. */
export function useFillReaderId(enabled: boolean) {
    const { client, attached } = useOptionalQueryClient();
    return useQuery<string | null, Error>({
        queryKey: ['templateFill', 'reader'],
        enabled: attached && enabled,
        staleTime: Infinity,
        retry: false,
        queryFn: async () => {
            const body = await apiJson<'GET /auth/user', { user?: { id?: unknown } }>('GET /auth/user');
            return typeof body.user?.id === 'string' ? body.user.id : null;
        },
    }, client);
}
