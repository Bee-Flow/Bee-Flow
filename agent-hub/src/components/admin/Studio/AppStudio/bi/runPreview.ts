import { API_BASE } from '../../../../../utils/helpers';
import { mutate, errorBody, RefusedError } from '../../../../../api/mutate';
import type { TranslateParams } from '../../../../../hooks/useTranslation';

export async function runPreview(appId: string | null | undefined, payload: { tableId: string; descriptor: unknown }, t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string) {
    let body = null;
    try {
        const res = await mutate(`${API_BASE}/api/studio-apps/${encodeURIComponent(String(appId))}/data/query`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tableId: payload.tableId, aggregate: payload.descriptor }),
        });
        try { body = await res.json(); } catch { body = null; }
    } catch (err) {
        if (!(err instanceof RefusedError)) throw err;
        if (err.status === 404) return { rows: [] };
        throw new Error(errorBody(err)?.error || t('studio_apps_bi.query.preview_failed_status', 'Preview failed ({status})', { status: err.status }));
    }
    return { rows: Array.isArray(body?.rows) ? body.rows : [] };
}
