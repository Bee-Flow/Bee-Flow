// The short-lived preview bearer token of one web page (POST
// /api/webpages/:id/preview-token): minted whenever the preview is (re)loaded
// and whenever the sandboxed iframe asks for a fresh one after a 401. Never
// cached: the signing secret can rotate mid-session.

import { useMutation } from '@tanstack/react-query';
import { ApiError } from '../mutate';
import { apiRequest } from '../typedRequest';

export interface PreviewToken { token: string; expiresAt?: number }

async function mintToken(webpageId: string, signal?: AbortSignal): Promise<PreviewToken> {
    let res: Response;
    try {
        res = await apiRequest('POST /api/webpages/{id}/preview-token', { params: { id: webpageId }, init: signal ? { signal } : undefined });
    } catch (err) {
        if (!(err instanceof ApiError)) throw err;
        throw new Error(`token fetch ${err.status}`);
    }
    return res.json();
}

export function useMintPreviewTokenMutation() {
    return useMutation<PreviewToken, Error, { webpageId: string; signal?: AbortSignal }>({
        mutationFn: ({ webpageId, signal }) => mintToken(webpageId, signal),
    });
}
