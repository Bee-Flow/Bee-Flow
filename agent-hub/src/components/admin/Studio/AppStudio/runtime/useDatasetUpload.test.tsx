import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { authFetch } = vi.hoisted(() => ({
    authFetch: vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(),
}));
vi.mock('../../../../../utils/helpers', () => ({ API_BASE: 'https://api.test', authFetch }));

import useDatasetUpload from './useDatasetUpload';

/**
 * The large-dataset uploader speaks to routes/studioAppDatasets.js, on
 * /api/studio-apps/:id/large-datasets.
 *
 * It used /:id/datasets, which routes/studioAppData.js (the BI saved datasets,
 * mounted first) also serves. The BI route answered the init with an empty BI
 * dataset, so the answer had no datasetId, no part was sent, and the complete
 * went to …/datasets/undefined/complete. The server test
 * (server/routes/studioAppDatasets.mount.test.js) walks the same URLs through
 * both real routers; this one pins that the client builds them.
 */

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
});

const DATASET_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const BASE = 'https://api.test/api/studio-apps/app%201/large-datasets';

/** What each call went to, in order, with the part sizes the client sliced. */
function calls() {
    return authFetch.mock.calls.map(([url, init]) => {
        const body = init?.body;
        const size = body instanceof Blob ? ` (${body.size} B)` : '';
        return `${init?.method || 'GET'} ${url}${size}`;
    });
}

beforeEach(() => {
    authFetch.mockReset();
});

describe('useDatasetUpload', () => {
    it('starts, sends each part and completes at /large-datasets', async () => {
        authFetch.mockImplementation(async (url) => {
            if (url.endsWith('/complete')) return json({ ok: true, status: 'uploaded' });
            if (url.includes('/parts/')) return json({ ok: true, partsDone: Number(url.split('/').pop()) + 1 });
            return json({ datasetId: DATASET_ID, partSize: 4, partsTotal: 2 });
        });
        const progress: number[] = [];
        const { result } = renderHook(() => useDatasetUpload('app 1'));

        const file = new File(['##fil'], 'me.vcf', { type: 'text/plain' }); // 5 bytes: 4 + 1
        const id = await result.current.upload(file, { onProgress: (pct: number) => progress.push(pct) });

        expect(id).toBe(DATASET_ID);
        expect(calls()).toEqual([
            `POST ${BASE}`,
            `PUT ${BASE}/${DATASET_ID}/parts/0 (4 B)`,
            `PUT ${BASE}/${DATASET_ID}/parts/1 (1 B)`,
            `POST ${BASE}/${DATASET_ID}/complete`,
        ]);
        expect(JSON.parse(String(authFetch.mock.calls[0][1]?.body))).toEqual({ name: 'me.vcf', bytes: 5, kind: 'vcf' });
        expect(progress.at(-1)).toBe(100);
    });

    it('stops at an init answer that is not an upload, instead of completing …/undefined', async () => {
        // What the BI route answered on the shared path: a 200, and a BI dataset.
        authFetch.mockResolvedValue(json({ success: true, dataset: { id: 'bi_1', name: 'me.vcf' } }));
        const { result } = renderHook(() => useDatasetUpload('app 1'));

        await expect(result.current.upload(new File(['x'], 'me.vcf'))).rejects.toThrow('Could not start the upload');
        expect(authFetch).toHaveBeenCalledTimes(1);
    });
});
