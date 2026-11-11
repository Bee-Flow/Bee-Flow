import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { studioAppFetch } from '@/api/queries/studioApps';
import { useHasQueryClient } from '../components/comboBox';
import { assetNeedsFetch, assetUrl, type AssetTransport } from '../assets/assetUrl';
import { assetFontFamily, fontAssetIds, fontRolesOf } from './fontRoles';

/**
 * The uploaded fonts an app's design names in its font roles (`design.fonts`, `asset:<id>`),
 * registered with the browser under assetFontFamily(<id>) so the role's stack finds them.
 *
 * The bytes come from the app's own asset store, by the same address an uploaded image uses
 * (assets/assetUrl.ts: the app, the public page token, the screenshot's in-process route), or
 * through the request layer where the session travels in a header (Nextcloud, the demo). No
 * other host is asked for anything. A font that does not load leaves the role's fallback stack.
 *
 * Renders nothing. Mounted next to the app's stylesheet (AppCustomCss), which every host
 * renders. A registered face stays for the session: fonts are global, and taking one away while
 * another screen still uses it would restyle that screen.
 */

const registered = new Set<string>();

type FontSource = string | ArrayBuffer;

/** Register `family` once; a browser without the font loading API (or a test DOM) does nothing. */
function registerFace(family: string, source: FontSource): void {
    if (registered.has(family) || typeof FontFace === 'undefined' || typeof document === 'undefined' || !document.fonts) return;
    registered.add(family);
    try {
        const face = new FontFace(family, typeof source === 'string' ? `url(${JSON.stringify(source)}) format("woff2")` : source);
        document.fonts.add(face);
        face.load().catch(() => { registered.delete(family); });
    } catch {
        registered.delete(family);
    }
}

/** A face read straight from its address (a cookie session, a public page, the screenshot). */
function LinkedFace({ family, url }: { family: string; url: string }) {
    useEffect(() => { registerFace(family, url); }, [family, url]);
    return null;
}

/** A face whose bytes go through the request layer first (its headers, the demo transport). */
function FetchedFace({ family, url }: { family: string; url: string }) {
    const { data } = useQuery({
        queryKey: ['studio-app-font', url],
        queryFn: async () => {
            const res = await studioAppFetch(url);
            if (!res.ok) throw new Error(`font ${res.status}`);
            return res.arrayBuffer();
        },
        staleTime: Infinity,
        gcTime: Infinity,
        retry: false,
    });
    useEffect(() => { if (data) registerFace(family, data); }, [family, data]);
    return null;
}

export default function AppFontFaces({ definition, transport }: { definition?: { [key: string]: unknown } | null; transport: AssetTransport }) {
    const canFetch = useHasQueryClient();
    const ids = fontAssetIds(fontRolesOf(definition?.design));
    if (!ids.length) return null;
    const fetched = assetNeedsFetch(transport);
    return (
        <>
            {ids.map((id) => {
                const url = assetUrl(`asset:${id}`, transport);
                if (!url) return null;
                const family = assetFontFamily(id);
                if (fetched) return canFetch ? <FetchedFace key={id} family={family} url={url} /> : null;
                return <LinkedFace key={id} family={family} url={url} />;
            })}
        </>
    );
}
