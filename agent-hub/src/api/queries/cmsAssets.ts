// GET /api/cms/admin/assets: the CMS asset library. The route answers
// `{ assets: [], unavailable: true }` in local-fs mode or a storage outage,
// which the picker shows as an explanatory empty state, not an error.

import { useQuery } from '@tanstack/react-query';
import { settled } from '../settled';
import { apiUrl } from '../typedRequest';
import { useOptionalQueryClient } from './optionalQueryClient';

export interface CmsAsset {
    key: string;
    url: string;
}

interface AssetLibrary {
    assets: CmsAsset[];
    unavailable: boolean;
}

const cmsAssetKeys = {
    library: ['cms', 'assetLibrary'] as const,
    probe: ['cms', 'assetLibrary', 'available'] as const,
};

/** The library, read each time the picker opens; a refusal or a failure is an error. */
export function useCmsAssetLibrary() {
    return useQuery<AssetLibrary>({
        queryKey: cmsAssetKeys.library,
        staleTime: 0,
        retry: false,
        queryFn: async () => {
            const r = await settled(apiUrl('GET /api/cms/admin/assets'), undefined, 'empty');
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const data = await r.res.json();
            return { assets: Array.isArray(data?.assets) ? data.assets : [], unavailable: data?.unavailable === true };
        },
    });
}

/**
 * Whether the library can be browsed, asked once per session however many
 * image fields a page has. `false` (route missing, storage in local-fs mode,
 * or not an admin) hides every Browse button: the picker is pure convenience
 * over upload/paste.
 */
export function useCmsAssetLibraryAvailable(enabled: boolean): boolean {
    // A field rendered without a QueryClientProvider (a block editor in a unit test) offers no Browse.
    const { client, attached } = useOptionalQueryClient();
    const query = useQuery<boolean>({
        queryKey: cmsAssetKeys.probe,
        enabled: enabled && attached,
        staleTime: Infinity,
        gcTime: Infinity,
        retry: false,
        queryFn: async () => {
            try {
                const r = await settled(apiUrl('GET /api/cms/admin/assets'), undefined, 'empty');
                const data: { unavailable?: boolean } | null = r.ok ? await r.res.json() : null;
                return !!(data && data.unavailable !== true);
            } catch {
                return false;
            }
        },
    }, client);
    return enabled && query.data === true;
}
