import { errorBody, RefusedError } from '@/api/mutate';
import type { TranslateParams } from '@/hooks/useTranslation';
import { apiRequest } from '@/api/typedRequest';

export async function runPreview(appId: string | null | undefined, payload: { tableId: string; descriptor: unknown }, t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string) {
    let body = null;
    try {
        const res = await apiRequest('POST /api/studio-apps/{id}/data/query', { params: { id: String(appId) }, body: { tableId: payload.tableId, aggregate: payload.descriptor } });
        try { body = await res.json(); } catch { body = null; }
    } catch (err) {
        if (!(err instanceof RefusedError)) throw err;
        if (err.status === 404) return { rows: [] };
        throw new Error(errorBody(err)?.error || t('studio_apps_bi.query.preview_failed_status', 'Preview failed ({status})', { status: err.status }));
    }
    return { rows: Array.isArray(body?.rows) ? body.rows : [] };
}
