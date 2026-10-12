/**
 * The flow editor's reads. Screens call these, never useQuery: the keys, the
 * freshness rules and the fetchers live here.
 */

import { useQuery } from '@tanstack/react-query';

import { getBuilderSession } from '../api/builder';
import { getAgentPreview, agentPreviewQuery, getCatalog, getFormPickSources, getTableColumns } from '../api/catalog';
import { getFlowAutomation } from '../api/definition';
import { listFolders } from '../api/folders';
import { flowKeys } from '../api/keys';
import { getTemplate, listTemplates } from '../api/templates';
import type { AgentPreviewQuery } from '../api/types';
import { diffVersions, getVersion, listVersions } from '../api/versions';
import { setPickSources } from '../bindings/flowDeps/pickSources';

/** The automation row with the editor's definition. The draft store hydrates from this. */
export function useFlowDefinition(id: string | null) {
    return useQuery({
        queryKey: flowKeys.definition(id ?? ''),
        queryFn: ({ signal }) => getFlowAutomation(id as string, signal),
        enabled: Boolean(id),
    });
}

export interface CatalogOptions {
    /**
     * Read it anew when this screen mounts, even with a copy cached. The
     * automation's own screens (Build, Flowlet) pass it: a step's empty state
     * sends the author to Studio → Datatables or Knowledge, which unmounts the
     * editor, and coming back must offer what they made there. A step editor
     * reads the copy its automation's screen fetched, so opening a step (or
     * typing in one) never rebuilds it.
     */
    freshOnMount?: boolean;
}

/**
 * What the builder may offer: apps, agents, datatables, knowledge bases.
 * Computed per caller from their grants and slow to build, so it is not
 * re-read on focus, on reconnect or while someone edits a flow (`staleTime:
 * Infinity`); it is re-read once per visit to an automation (`freshOnMount` on the
 * automation's screens) and on coming back to a step (useCatalogOnReturn). Its
 * `app_pick` sources are handed to the bindings layer as they arrive.
 */
export function useCatalog({ freshOnMount = false }: CatalogOptions = {}) {
    return useQuery({
        queryKey: flowKeys.catalog,
        queryFn: async ({ signal }) => {
            const catalog = await getCatalog(signal);
            setPickSources(catalog.formPickSources);
            return catalog;
        },
        staleTime: Infinity,
        refetchOnMount: freshOnMount ? 'always' : true,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
    });
}

/** Only the `app_pick` sources — for the form editor opened without a catalog. */
export function useFormPickSources() {
    return useQuery({
        queryKey: flowKeys.formPickSources,
        queryFn: async ({ signal }) => {
            const sources = await getFormPickSources(signal);
            setPickSources(sources);
            return sources;
        },
        staleTime: Infinity,
        refetchOnWindowFocus: false,
    });
}

/** A Nextcloud table's columns (Tables row editor). A failure is not retried: the editor falls back. */
export function useTableColumns(tableId: string | number | null) {
    const key = tableId === null ? '' : String(tableId);
    return useQuery({
        queryKey: flowKeys.tableColumns(key),
        queryFn: ({ signal }) => getTableColumns(key, signal),
        enabled: key !== '',
        staleTime: 5 * 60_000,
        retry: false,
    });
}

/** What an agent would bring to this ai_step under these switches. */
export function useAgentPreview(agentId: string | null, query: AgentPreviewQuery) {
    const params = agentPreviewQuery(query);
    const signature = JSON.stringify(params);
    return useQuery({
        queryKey: flowKeys.agentPreview(agentId ?? '', signature),
        queryFn: ({ signal }) => getAgentPreview(agentId as string, query, signal),
        enabled: Boolean(agentId),
    });
}

export function useVersions(id: string | null) {
    return useQuery({
        queryKey: flowKeys.versions(id ?? ''),
        queryFn: ({ signal }) => listVersions(id as string, signal),
        enabled: Boolean(id),
    });
}

/** One stored version's definition. A version never changes. */
export function useVersion(id: string | null, versionId: string | null) {
    return useQuery({
        queryKey: flowKeys.version(id ?? '', versionId ?? ''),
        queryFn: ({ signal }) => getVersion(id as string, versionId as string, signal),
        enabled: Boolean(id && versionId),
        staleTime: Infinity,
    });
}

export function useVersionDiff(id: string | null, a: string | null, b: string | null) {
    return useQuery({
        queryKey: flowKeys.versionDiff(id ?? '', a ?? '', b ?? ''),
        queryFn: ({ signal }) => diffVersions(id as string, a as string, b as string, signal),
        enabled: Boolean(id && a && b),
        staleTime: Infinity,
    });
}

/** The gallery. Static server config, so one read per session. */
export function useTemplates() {
    return useQuery({
        queryKey: flowKeys.templates,
        queryFn: ({ signal }) => listTemplates(signal),
        staleTime: Infinity,
        refetchOnWindowFocus: false,
    });
}

export function useTemplate(templateId: string | null) {
    return useQuery({
        queryKey: flowKeys.template(templateId ?? ''),
        queryFn: ({ signal }) => getTemplate(templateId as string, signal),
        enabled: Boolean(templateId),
        staleTime: Infinity,
    });
}

export function useFolders() {
    return useQuery({
        queryKey: flowKeys.folders,
        queryFn: ({ signal }) => listFolders(signal),
    });
}

/**
 * The persisted AI conversation of an automation, read once when the chat opens;
 * after that the chat keeps its own transcript and the server its own copy.
 */
export function useBuilderSession(automationId: string | null) {
    return useQuery({
        queryKey: flowKeys.builderSession(automationId ?? ''),
        queryFn: ({ signal }) => getBuilderSession(automationId as string, signal),
        enabled: Boolean(automationId),
        staleTime: Infinity,
        refetchOnWindowFocus: false,
    });
}
