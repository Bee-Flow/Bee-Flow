/**
 * Writes behind the builder's tabs: knowledge sources and the version
 * history. A restore rewrites the three files, so it hands the restored
 * bodies to the cached copy the Code tab and the chat read.
 */

import { useQueryClient } from '@tanstack/react-query';

import { usePageMutation, type Handlers } from './pageMutation';
import {
    addTextSource,
    addUrlSource,
    cancelSource,
    createVersion,
    deleteSource,
    deleteVersion,
    restoreVersion,
    retrySource,
} from '../api/buildEndpoints';
import { webpageKeys } from '../api/keys';
import type { WebpageFiles, WebpageSource } from '../model/buildTypes';

const SOURCES = (id: string) => [webpageKeys.sources(id), webpageKeys.all];
const VERSIONS = (id: string) => [webpageKeys.versions(id)];

export type SourceAction = 'retry' | 'cancel' | 'delete';

export function useAddUrlSource(id: string, handlers: Handlers<WebpageSource, string> = {}) {
    return usePageMutation(id, (url: string) => addUrlSource(id, url), { handlers, refresh: SOURCES });
}

export function useAddTextSource(id: string, handlers: Handlers<WebpageSource, { text: string; name?: string }> = {}) {
    return usePageMutation(id, (input: { text: string; name?: string }) => addTextSource(id, input.text, input.name), {
        handlers,
        refresh: SOURCES,
    });
}

/** Retry, cancel or delete one source — the three buttons on its row. */
export function useSourceAction(id: string, handlers: Handlers<void, { action: SourceAction; sourceId: string }> = {}) {
    return usePageMutation(
        id,
        ({ action, sourceId }: { action: SourceAction; sourceId: string }) => {
            if (action === 'retry') return retrySource(id, sourceId);
            if (action === 'cancel') return cancelSource(id, sourceId);
            return deleteSource(id, sourceId);
        },
        { handlers, refresh: SOURCES },
    );
}

export function useCreateVersion(id: string, handlers: Handlers<void, string | undefined> = {}) {
    return usePageMutation(id, (summary: string | undefined) => createVersion(id, summary), {
        handlers,
        refresh: VERSIONS,
    });
}

export function useRestoreVersion(id: string, handlers: Handlers<WebpageFiles, string> = {}) {
    const queryClient = useQueryClient();
    return usePageMutation(
        id,
        async (versionId: string) => {
            const files = await restoreVersion(id, versionId);
            queryClient.setQueryData(webpageKeys.files(id), files);
            return files;
        },
        { handlers, refresh: (pageId) => [webpageKeys.detail(pageId), webpageKeys.document(pageId)] },
    );
}

export function useDeleteVersion(id: string, handlers: Handlers<void, string> = {}) {
    return usePageMutation(id, (versionId: string) => deleteVersion(id, versionId), { handlers, refresh: VERSIONS });
}
