import { useCallback, useEffect, useRef } from 'react';
import { API_BASE, authFetch } from '../../../../../utils/helpers';

/**
 * App Studio runtime — chunked uploader for LARGE datasets (multi-GB VCFs).
 *
 * Protocol (routes/studioAppDatasets.js, on /api/studio-apps/:id/large-datasets):
 * init → sequential raw PUT parts → complete. Parts are SEQUENTIAL by server
 * contract; a 409 carries the part number the server expects, so a retry after
 * a network drop RE-SYNCS from the server's ledger instead of restarting the
 * file. Each part gets 3 attempts.
 *
 * Not /:id/datasets: that is the BI saved datasets (routes/studioAppData.js).
 * On the shared path the BI route answered the init, and this hook, finding no
 * datasetId, completed …/datasets/undefined. An init answer that is not an
 * upload now stops the upload where it happens.
 *
 * Unmount aborts the in-flight fetch; the server-side upload stays 'uploading'
 * and can be resumed by a later visit (same sequential contract) or deleted.
 */
export default function useDatasetUpload(appId) {
    const abortRef = useRef(null);

    useEffect(() => () => { abortRef.current?.abort(); }, []);

    const upload = useCallback(async (file, { onProgress } = {}) => {
        if (!appId || !file) throw new Error('Nothing to upload');
        const ac = new AbortController();
        abortRef.current = ac;
        const base = `${API_BASE}/api/studio-apps/${encodeURIComponent(appId)}/large-datasets`;

        const initRes = await authFetch(base, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: file.name, bytes: file.size, kind: 'vcf' }),
            signal: ac.signal,
        });
        const init = await initRes.json().catch(() => ({}));
        if (!initRes.ok) throw new Error(init.error || `Could not start the upload (${initRes.status})`);
        const { datasetId, partSize, partsTotal } = init;
        if (typeof datasetId !== 'string' || !datasetId || !(partSize > 0) || !Number.isInteger(partsTotal)) {
            throw new Error(`Could not start the upload (${initRes.status})`);
        }

        let n = 0;
        while (n < partsTotal) {
            const blob = file.slice(n * partSize, Math.min((n + 1) * partSize, file.size));
            let lastError = null;
            let sent = false;
            for (let attempt = 0; attempt < 3 && !sent; attempt++) {
                try {
                    const res = await authFetch(`${base}/${encodeURIComponent(datasetId)}/parts/${n}`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/octet-stream' },
                        body: blob,
                        signal: ac.signal,
                    });
                    if (res.status === 409) {
                        // The ledger knows better than our counter — re-sync.
                        const body = await res.json().catch(() => ({}));
                        if (Number.isInteger(body.expected)) { n = body.expected; sent = true; break; }
                        throw new Error(body.error || 'part out of sequence');
                    }
                    const body = await res.json().catch(() => ({}));
                    if (!res.ok) throw new Error(body.error || `part ${n} failed (${res.status})`);
                    n += 1;
                    sent = true;
                } catch (err) {
                    if (ac.signal.aborted) throw err;
                    lastError = err;
                    if (attempt === 2) throw lastError;
                    await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
                }
            }
            onProgress?.(Math.min(99, Math.floor((n / partsTotal) * 100)));
        }

        const doneRes = await authFetch(`${base}/${encodeURIComponent(datasetId)}/complete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
            signal: ac.signal,
        });
        const done = await doneRes.json().catch(() => ({}));
        if (!doneRes.ok) throw new Error(done.error || `Could not finish the upload (${doneRes.status})`);
        onProgress?.(100);
        return datasetId;
    }, [appId]);

    const abort = useCallback(() => { abortRef.current?.abort(); }, []);
    return { upload, abort };
}
