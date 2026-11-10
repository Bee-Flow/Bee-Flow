// The uploaded files of an App Studio app (/api/studio-apps/:id/assets): logo, pictures, fonts.
// Server: routes/studioAppAssets.mts. Every call is checked (mutate/request): a refusal throws a
// RefusedError carrying the status and the server's `{ error, code }`.
import { API_BASE, request, mutate } from './mutate';

export interface StudioAsset {
    id: string;
    /** `asset:<id>`, the value a definition stores. */
    ref: string;
    mime: string;
    size: number;
    createdAt: string | null;
    /** Where the SAVED draft and the published app name it (definition paths). */
    usedBy: { draft: string[]; published: string[] };
}

export interface StudioAssetList {
    assets: StudioAsset[];
    limits: { maxBytes: number; maxAssets: number; types: string[] };
}

const assetsUrl = (appId: string) => `${API_BASE}/api/studio-apps/${encodeURIComponent(appId)}/assets`;

export async function listStudioAssets(appId: string): Promise<StudioAssetList> {
    const res = await request(assetsUrl(appId));
    return res.json();
}

/**
 * Upload one file. A browser often declares a .woff2 with no type or a generic one; the server
 * decides by the bytes anyway, so the declared type is set from the name for that one case.
 */
export async function uploadStudioAsset(appId: string, file: File): Promise<StudioAsset> {
    const isWoff2 = file.name.toLowerCase().endsWith('.woff2');
    const typed = isWoff2 && file.type !== 'font/woff2' ? new File([file], file.name, { type: 'font/woff2' }) : file;
    const body = new FormData();
    body.append('file', typed);
    const res = await mutate(assetsUrl(appId), { method: 'POST', body });
    const data = await res.json();
    return data.asset;
}

export async function deleteStudioAsset(appId: string, assetId: string): Promise<void> {
    await mutate(`${assetsUrl(appId)}/${encodeURIComponent(assetId)}`, { method: 'DELETE' });
}
