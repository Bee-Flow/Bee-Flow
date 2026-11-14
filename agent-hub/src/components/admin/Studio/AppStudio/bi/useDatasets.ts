import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import useTranslation from '@/hooks/useTranslation';
import type { TranslateFn } from '@/hooks/useTranslation';
import { authFetch } from '@/utils/helpers';
import { apiUrl } from '@/api/typedRequest';
import type { AuthFetchOptions } from '@/utils/helpers';

/**
 * App Studio BI — saved-dataset CRUD hook (owner-only endpoints).
 *
 *   GET    /api/studio-apps/:appId/datasets
 *   POST   /api/studio-apps/:appId/datasets            → { dataset }
 *   PUT    /api/studio-apps/:appId/datasets/:datasetId → { dataset }
 *   DELETE /api/studio-apps/:appId/datasets/:datasetId
 *
 * Like useAppTables, a 404 degrades to an empty list rather than an error.
 * saveDataset/deleteDataset are promises that resolve to the server body and
 * invalidate the list so the gallery refreshes.
 */

/** One aggregate of a saved view's descriptor. */
export interface DatasetAggregate {
    fn?: string;
    field?: string;
    as?: string;
}

/** One breakdown of a saved view's descriptor. */
export interface DatasetGroup {
    field?: string;
    /** A field of the record a relation field points at (bi/aggregateExtras.ts). */
    relatedField?: string;
    bucket?: string;
    /** A whole-number step for a number field. */
    binWidth?: number;
    as?: string;
}

/** The question a saved view asks; only the parts that name its answer columns are read here. */
interface DatasetDescriptor {
    aggregates?: Array<DatasetAggregate | null>;
    groupBy?: Array<DatasetGroup | null>;
    [key: string]: unknown;
}

/** One saved view (dataset) of an app. */
export interface Dataset {
    id: string;
    name?: string;
    descriptor?: DatasetDescriptor | null;
    [key: string]: unknown;
}

/** The body the dataset endpoints answer with: the list, or the one saved dataset. */
export interface DatasetsBody {
    error?: string;
    datasets?: unknown;
    dataset?: Dataset;
}

/** The writable half of a dataset: what saveDataset sends (`id` present means update). */
export interface DatasetPayload {
    id?: string;
    [key: string]: unknown;
}

async function request(url: string, options: AuthFetchOptions = {}, t: TranslateFn): Promise<DatasetsBody | null> {
    const res = await authFetch(url, {
        headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
        ...options,
    });
    if (res.status === 404 && (!options.method || options.method === 'GET')) return null;
    let body: DatasetsBody | null = null;
    try { body = await res.json(); } catch { body = null; }
    if (!res.ok) {
        const err: Error & { status?: number } = new Error(body?.error || t('studio_apps_bi.hooks.request_failed', 'Request failed ({status})', { status: res.status }));
        err.status = res.status;
        throw err;
    }
    return body;
}

export default function useDatasets(appId: string | null | undefined) {
    const { t } = useTranslation();
    const qc = useQueryClient();
    const listKey = ['studio-app-datasets', appId];

    const listQuery = useQuery({
        queryKey: listKey,
        queryFn: async (): Promise<Dataset[]> => {
            const body = await request(apiUrl('GET /api/studio-apps/{id}/datasets', { params: { id: String(appId) } }), {}, t);
            return Array.isArray(body?.datasets) ? body.datasets : [];
        },
        enabled: !!appId,
        staleTime: 30_000,
        retry: false,
    });

    // An app id that is not there yet reads as the word, as encodeURIComponent would write it.
    const appIdParam = String(appId);
    const invalidate = () => qc.invalidateQueries({ queryKey: ['studio-app-datasets', appId] });

    const saveMutation = useMutation({
        mutationFn: async ({ id, ...payload }: DatasetPayload) => {
            if (id) {
                return request(apiUrl('PUT /api/studio-apps/{id}/datasets/{datasetId}', { params: { id: appIdParam, datasetId: id } }), { method: 'PUT', body: JSON.stringify(payload) }, t);
            }
            return request(apiUrl('POST /api/studio-apps/{id}/datasets', { params: { id: appIdParam } }), { method: 'POST', body: JSON.stringify(payload) }, t);
        },
        onSuccess: invalidate,
    });

    const deleteMutation = useMutation({
        mutationFn: async (id: string) => request(apiUrl('DELETE /api/studio-apps/{id}/datasets/{datasetId}', { params: { id: appIdParam, datasetId: id } }), { method: 'DELETE' }, t),
        onSuccess: invalidate,
    });

    return {
        datasets: Array.isArray(listQuery.data) ? listQuery.data : [],
        isLoading: !!appId && listQuery.isLoading,
        isError: listQuery.isError,
        saveDataset: (payload: DatasetPayload) => saveMutation.mutateAsync(payload),
        deleteDataset: (id: string) => deleteMutation.mutateAsync(id),
        saving: saveMutation.isPending,
        deleting: deleteMutation.isPending,
        refetch: listQuery.refetch,
    };
}
