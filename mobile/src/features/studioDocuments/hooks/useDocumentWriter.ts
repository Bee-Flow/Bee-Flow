/**
 * Every change to one open document goes through ONE queue, like the web
 * editor's write queue: the body's autosave and a settings save each name the
 * revision they were based on, so two writes in flight at once would have the
 * second refused as a conflict with the first. Queued, each write reads the
 * revision the previous one left in the cache.
 */

import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef } from 'react';

import { updateStudioDocument } from '../api/endpoints';
import { studioDocumentKeys } from '../api/keys';
import type { DocumentPatch, StudioDocument } from '../model/types';

/**
 * A patch, or a function of the document as the previous write left it — a
 * settings save merges into THAT, not into what the screen rendered from.
 */
export type PatchSource = DocumentPatch | ((current: StudioDocument | undefined) => DocumentPatch);
export type DocumentWrite = (patch: PatchSource) => Promise<StudioDocument | null>;

export function useDocumentWriter(id: string): DocumentWrite {
    const queryClient = useQueryClient();
    const queue = useRef<Promise<unknown>>(Promise.resolve());
    return useCallback(
        (source: PatchSource) => {
            const key = studioDocumentKeys.detail(id);
            const run = queue.current
                .catch(() => undefined)
                .then(async () => {
                    const current = queryClient.getQueryData<StudioDocument | null>(key) ?? undefined;
                    const patch = typeof source === 'function' ? source(current) : source;
                    const saved = await updateStudioDocument(id, patch, current?.versionId ?? null, current);
                    if (saved) queryClient.setQueryData(key, saved);
                    void queryClient.invalidateQueries({ queryKey: [...studioDocumentKeys.all, 'list'] });
                    void queryClient.invalidateQueries({ queryKey: studioDocumentKeys.versions(id) });
                    return saved;
                });
            queue.current = run;
            return run;
        },
        [queryClient, id],
    );
}
