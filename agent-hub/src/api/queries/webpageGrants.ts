// The "Apps & data" pane of the webpage IDE: what a page may call (its grants) and
// what its author could add (the app catalog and the automations).

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '../typedRequest';
import { READ_ONCE } from './readOnce';

/** Everything the pane reads for one page; invalidating it asks all of it again. */
const paneKey = (webpageId: string) => ['webpages', 'apps-pane', webpageId] as const;

/** Asks the pane's grants, catalog and automations again; resolves when the answers are in. */
export function useReloadWebpageAppsPane(webpageId: string): () => Promise<void> {
    const queryClient = useQueryClient();
    return () => queryClient.invalidateQueries({ queryKey: paneKey(webpageId) });
}

/** GET /api/webpages/{id}/grants. A refusal errors with the RefusedError, so the pane can show the server's text. */
export function useWebpageGrantsQuery<Grants>(webpageId: string, enabled: boolean) {
    return useQuery<Grants, Error>({
        queryKey: [...paneKey(webpageId), 'grants'],
        queryFn: async () => (await apiRequest('GET /api/webpages/{id}/grants', { params: { id: webpageId } })).json() as Promise<Grants>,
        enabled,
        ...READ_ONCE,
    });
}

/**
 * One of the pane's best-effort lists (the app catalog, the automations), read through the
 * loader the pane hands over. A failure is the caller's to show; the grants stay manageable.
 */
export function useWebpagePaneList<T>(webpageId: string, list: 'catalog' | 'automations', load: () => Promise<T>, enabled: boolean) {
    return useQuery<T, Error>({
        queryKey: [...paneKey(webpageId), list],
        queryFn: () => load(),
        enabled,
        ...READ_ONCE,
    });
}

export interface WebpageGrantRef { kind: 'integrations' | 'automations'; key: string }

/** DELETE one grant of a page; the pane's reads are asked again once it is gone. */
export function useRevokeWebpageGrant(webpageId: string) {
    const queryClient = useQueryClient();
    return useMutation<void, Error, WebpageGrantRef>({
        mutationFn: async ({ kind, key }) => {
            await (kind === 'integrations'
                ? apiRequest('DELETE /api/webpages/{id}/grants/integrations/{tool}', { params: { id: webpageId, tool: key } })
                : apiRequest('DELETE /api/webpages/{id}/grants/automations/{automationId}', { params: { id: webpageId, automationId: key } }));
        },
        onSuccess: () => queryClient.invalidateQueries({ queryKey: paneKey(webpageId) }),
    });
}
