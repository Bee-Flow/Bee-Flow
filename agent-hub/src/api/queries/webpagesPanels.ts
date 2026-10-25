// Webpage reads behind the chat side panel and the picker popover. authFetch
// stays in the queryFns; the components keep their loading/error rendering.

import { useQuery } from '@tanstack/react-query';
import { API_BASE, authFetch } from '../../utils/helpers';
import type { ExtraFileMeta, PrimaryContent, WebpageRow } from '../webpageEditorTypes';

/** GET /api/webpages/:id/<path>: the JSON body; rejects with the server's `error` (or `HTTP <status>`). */
async function readWebpageJson<T>(webpageId: string | number | boolean, path: string): Promise<T> {
    const res = await authFetch(`${API_BASE}/api/webpages/${encodeURIComponent(webpageId as string)}/${path}`);
    let body: unknown = null;
    try { body = await res.json(); } catch { body = null; }
    if (!res.ok) throw new Error((body as { error?: string } | null)?.error || `HTTP ${res.status}`);
    return body as T;
}

export interface WebpageBundle {
    webpage?: WebpageRow;
    files?: Partial<PrimaryContent>;
    extraFiles?: ExtraFileMeta[];
}

/**
 * GET /api/webpages/:id. Rejects with the server's `error` (or `Failed (<status>)`). The answer is
 * dropped when the panel lets go of it (`gcTime: 0`) and a new `reloadKey` is a new read, so the
 * panel shows "Loading" again exactly where it used to.
 */
export function useWebpageBundleQuery(webpageId: string, reloadKey: number) {
    return useQuery<WebpageBundle, Error>({
        queryKey: ['webpages', 'bundle', webpageId, reloadKey] as const,
        queryFn: async () => {
            const res = await authFetch(`${API_BASE}/api/webpages/${webpageId}`);
            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                throw new Error(body.error || `Failed (${res.status})`);
            }
            return res.json();
        },
        staleTime: 0,
        gcTime: 0,
        retry: false,
    });
}

/** GET /api/webpages while the popover is open. Rejects with `Failed (<status>)`. */
export function useWebpageListQuery(enabled: boolean) {
    return useQuery<WebpageRow[], Error>({
        queryKey: ['webpages', 'list', 'picker'] as const,
        enabled,
        queryFn: async () => {
            const res = await authFetch(`${API_BASE}/api/webpages`);
            if (!res.ok) throw new Error(`Failed (${res.status})`);
            const data = await res.json();
            return Array.isArray(data?.webpages) ? data.webpages : [];
        },
        staleTime: 0,
        retry: false,
    });
}

/**
 * GET /api/webpages/:id/data-cards: what feeds a page (tables, automations, warnings, knowledge).
 * A failed read rejects: it must never look like "nothing hangs on this page".
 */
export function useWebpageDataCardsQuery<TPayload>(webpageId: string | number | boolean | null | undefined) {
    return useQuery<TPayload, Error>({
        queryKey: ['webpages', 'dataCards', webpageId ?? null] as const,
        enabled: !!webpageId,
        queryFn: () => readWebpageJson<TPayload>(webpageId as string, 'data-cards'),
        staleTime: 0,
        gcTime: 0,
        retry: false,
    });
}

/** GET /api/webpages/:id/audience: who can see the page. Rejects with the server's `error` (or `HTTP <status>`). */
export function useWebpageAudienceQuery<TModel>(webpageId: string | number | boolean | null | undefined, enabled: boolean) {
    return useQuery<TModel, Error>({
        queryKey: ['webpages', 'audience', webpageId ?? null] as const,
        enabled: enabled && !!webpageId,
        queryFn: () => readWebpageJson<TModel>(webpageId as string, 'audience'),
        staleTime: 0,
        gcTime: 0,
        retry: false,
    });
}

/** GET /api/webpages/:id/bindings: what the page sets off (own code, forms, agent). A failed read rejects. */
export function useWebpageBindingsQuery<TPayload>(webpageId: string | number | boolean | null | undefined, enabled: boolean) {
    return useQuery<TPayload, Error>({
        queryKey: ['webpages', 'bindings', webpageId ?? null] as const,
        enabled: enabled && !!webpageId,
        queryFn: () => readWebpageJson<TPayload>(webpageId as string, 'bindings'),
        staleTime: 0,
        gcTime: 0,
        retry: false,
    });
}

/**
 * The tables and automations the "Pick a source" menu offers. One list failing is not the other
 * list's problem (`error` is set only when both did); a network failure rejects. Lazy: `enabled`
 * turns on the first time the menu opens, and the answer is then kept.
 */
export function usePickerSourcesQuery<TTable, TAutomation>(enabled: boolean) {
    return useQuery<{ tables: TTable[]; automations: TAutomation[]; error: boolean }, Error>({
        queryKey: ['webpages', 'pickerSources'] as const,
        enabled,
        queryFn: async () => {
            const [tRes, aRes] = await Promise.all([
                authFetch(`${API_BASE}/api/datatables`),
                authFetch(`${API_BASE}/api/automation/`),
            ]);
            const tBody = tRes.ok ? await tRes.json() : null;
            const aBody = aRes.ok ? await aRes.json() : null;
            return {
                tables: Array.isArray(tBody?.datatables) ? tBody.datatables : [],
                automations: Array.isArray(aBody?.automations) ? aBody.automations : [],
                error: !tRes.ok && !aRes.ok,
            };
        },
        staleTime: Infinity,
        gcTime: 0,
        retry: false,
    });
}
