/**
 * App Studio reads. Screens and the editor call these, never useQuery: the
 * keys, the stale times and the "which answers are not errors" live here.
 */

import { useQuery } from '@tanstack/react-query';

import { getApp, getCatalog, getTemplate, listAccessibleApps, listMyApps, listTemplates } from '../api/endpointsApps';
import { getBuilderSession } from '../api/endpointsBuilder';
import { listVersions } from '../api/endpointsDefinition';
import { listPublicPages, listPublishGroups } from '../api/endpointsPublish';
import { getRuntime, pollRun } from '../api/endpointsRuntime';
import { studioKeys } from '../api/keys';

interface Enabled {
    enabled?: boolean;
}

/** Static per server build: fetched once per session. */
export function useCatalog({ enabled = true }: Enabled = {}) {
    return useQuery({
        queryKey: studioKeys.catalog,
        queryFn: ({ signal }) => getCatalog(signal),
        enabled,
        staleTime: Infinity,
        gcTime: Infinity,
    });
}

export function useTemplates({ enabled = true }: Enabled = {}) {
    return useQuery({
        queryKey: studioKeys.templates,
        queryFn: ({ signal }) => listTemplates(signal),
        enabled,
        staleTime: 5 * 60_000,
    });
}

export function useTemplate(templateId: string | null) {
    return useQuery({
        queryKey: studioKeys.template(templateId ?? ''),
        queryFn: ({ signal }) => getTemplate(templateId as string, signal),
        enabled: Boolean(templateId),
        staleTime: 5 * 60_000,
    });
}

/** The builder's gallery: the caller's own apps, with usage and upgrade flags. */
export function useMyApps({ enabled = true }: Enabled = {}) {
    return useQuery({
        queryKey: studioKeys.mine,
        queryFn: ({ signal }) => listMyApps(signal),
        enabled,
    });
}

/** Every app the caller may open. */
export function useAccessibleApps({ enabled = true }: Enabled = {}) {
    return useQuery({
        queryKey: studioKeys.accessible,
        queryFn: ({ signal }) => listAccessibleApps(signal),
        enabled,
    });
}

/**
 * One app: the owner's full row with the working draft, or a reader's meta
 * plus the published copy. The editor loads its draft from here; it is not
 * refetched behind the editor's back (the autosave owns it while open).
 */
export function useAppRow(id: string) {
    return useQuery({
        queryKey: studioKeys.row(id),
        queryFn: ({ signal }) => getApp(id, signal),
        enabled: Boolean(id),
        staleTime: Infinity,
        refetchOnWindowFocus: false,
    });
}

export function useAppVersions(id: string, { enabled = true }: Enabled = {}) {
    return useQuery({
        queryKey: studioKeys.versions(id),
        queryFn: ({ signal }) => listVersions(id, signal),
        enabled: enabled && Boolean(id),
    });
}

export function usePublicPages(id: string, { enabled = true }: Enabled = {}) {
    return useQuery({
        queryKey: studioKeys.publicPages(id),
        queryFn: ({ signal }) => listPublicPages(id, signal),
        enabled: enabled && Boolean(id),
    });
}

/**
 * Groups for the publish audience. A 403 (no directory access) is normal:
 * `isError` then means "offer the whole organisation only", never a banner.
 */
export function usePublishGroups({ enabled = true }: Enabled = {}) {
    return useQuery({
        queryKey: studioKeys.publishGroups,
        queryFn: ({ signal }) => listPublishGroups(signal),
        enabled,
        staleTime: 60_000,
        retry: false,
    });
}

/**
 * The run view. The published copy only changes on a republish, and a
 * refetch mid-form would reset half-typed answers, so it is held for five
 * minutes; the owner's draft preview is always re-read.
 */
export function useAppRuntime(id: string, { draft = false, enabled = true }: Enabled & { draft?: boolean } = {}) {
    return useQuery({
        queryKey: studioKeys.runtime(id, draft),
        queryFn: ({ signal }) => getRuntime(id, { draft, signal }),
        enabled: enabled && Boolean(id),
        staleTime: draft ? 0 : 5 * 60_000,
    });
}

/**
 * Poll a 202'd action run until its status settles. Stops on its own: a
 * forgotten interval on a phone is a battery complaint.
 */
export function useActionRunPoll(appId: string, runId: string | null) {
    return useQuery({
        queryKey: studioKeys.actionRun(appId, runId),
        queryFn: ({ signal }) => pollRun(appId, runId as string, signal),
        enabled: Boolean(appId && runId),
        refetchInterval: (query) => {
            const status = query.state.data?.status;
            return !status || ['pending', 'queued', 'running'].includes(status) ? 3000 : false;
        },
        retry: false,
        staleTime: 0,
    });
}

/** The builder chat to rehydrate; `data === null` = no session yet. */
export function useBuilderSession(appId: string, { enabled = true }: Enabled = {}) {
    return useQuery({
        queryKey: studioKeys.builderSession(appId),
        queryFn: ({ signal }) => getBuilderSession(appId, signal),
        enabled: enabled && Boolean(appId),
        staleTime: 0,
    });
}
