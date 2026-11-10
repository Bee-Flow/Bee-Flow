import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { studioAppFetch } from '@/api/queries/studioApps';
import { useHasQueryClient } from '../components/comboBox';
import { useAssetTransport } from './assetTransport';
import { assetNeedsFetch, assetUrl, isHttpsUrl } from './assetUrl';

interface AssetImageProps {
    /** An https URL (drawn exactly as before) or `asset:<id>`. */
    value: string | null | undefined;
    alt: string;
    className?: string;
    onError?: () => void;
    /** What stands in when there is nothing to draw. */
    fallback?: ReactNode;
    /** The app, where no data scope says it (the editor's panels). */
    appId?: string | null;
}

/** The bytes through the request layer (its headers, the demo transport), shown from a blob URL. */
function FetchedAssetImg({ url, alt, className, onError, fallback }: { url: string; alt: string; className?: string; onError?: () => void; fallback: ReactNode }) {
    const { data, isError } = useQuery({
        queryKey: ['studio-app-asset', url],
        queryFn: async () => {
            const res = await studioAppFetch(url);
            if (!res.ok) throw new Error(`asset ${res.status}`);
            // Kept for the session: an asset id names bytes that never change.
            return URL.createObjectURL(await res.blob());
        },
        staleTime: Infinity,
        gcTime: Infinity,
        retry: false,
    });
    if (isError) return <>{fallback}</>;
    if (!data) return null;
    return <img src={data} alt={alt} onError={onError} className={className} />;
}

/**
 * An image of an App Studio app whose source may be an uploaded asset. An https URL renders
 * the same <img> as before; `asset:<id>` resolves through assetUrl() for this page.
 */
export default function AssetImage({ value, alt, className, onError, fallback = null, appId }: AssetImageProps) {
    const transport = useAssetTransport(appId);
    const canFetch = useHasQueryClient();
    if (isHttpsUrl(value)) return <img src={value} alt={alt} onError={onError} className={className} />;
    const url = assetUrl(value, transport);
    if (!url) return <>{fallback}</>;
    if (assetNeedsFetch(transport)) {
        return canFetch ? <FetchedAssetImg url={url} alt={alt} className={className} onError={onError} fallback={fallback} /> : <>{fallback}</>;
    }
    return <img src={url} alt={alt} onError={onError} className={className} />;
}
