import { useQuery } from '@tanstack/react-query';
import { useLayoutEffect, useRef } from 'react';
import { studioAppFetch } from '@/api/queries/studioApps';
import { useHasQueryClient } from '../components/comboBox';
import { useAssetTransport } from './assetTransport';
import { assetNeedsFetch, assetUrl, isAssetRef } from './assetUrl';

interface Props {
    /** The node's backgroundImage knob: `asset:<id>` or anything else (drawn as nothing). */
    image: unknown;
    fit?: unknown;
    overlay?: unknown;
}

const FITS = ['cover', 'contain', 'tile'];
const OVERLAYS = ['dim', 'light'];

const FITS_SET = FITS;

function Layer({ src, fit, overlay }: { src: string; fit: unknown; overlay: unknown }) {
    const ref = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => {
        ref.current?.style.setProperty('--app-backdrop-image', `url("${src}")`);
    }, [src]);
    const dataFit = typeof fit === 'string' && FITS_SET.includes(fit) ? fit : 'cover';
    const dataOverlay = typeof overlay === 'string' && OVERLAYS.includes(overlay) ? overlay : 'none';
    // The address is built by assetUrl() from a validated id and the page's own base (ids
    // hold letters, digits, _ and - only; the token and app id are percent-encoded), so it
    // cannot leave the url("...") token. It is set as a custom property the stylesheet reads.
    return (
        <div
            ref={ref}
            className="app-backdrop-layer"
            data-app-backdrop="true"
            data-fit={dataFit}
            data-overlay={dataOverlay}
            aria-hidden="true"
        />
    );
}

/** The bytes through the request layer (demo, Nextcloud header session), shown from a blob URL. */
function FetchedLayer({ url, fit, overlay }: { url: string; fit: unknown; overlay: unknown }) {
    const { data } = useQuery({
        queryKey: ['studio-app-asset', url],
        queryFn: async () => {
            const res = await studioAppFetch(url);
            if (!res.ok) throw new Error(`asset ${res.status}`);
            return URL.createObjectURL(await res.blob());
        },
        staleTime: Infinity,
        gcTime: Infinity,
        retry: false,
    });
    return data ? <Layer src={data} fit={fit} overlay={overlay} /> : null;
}

/**
 * The picture behind a node (style knob group "backdrop"): a layer under the cell's content,
 * addressed through assetUrl for this page, never by a hand-built URL. Draws nothing for a
 * value that is not an asset reference or when the page has nothing to address it by.
 */
export default function BackgroundImageLayer({ image, fit, overlay }: Props) {
    const transport = useAssetTransport();
    const canFetch = useHasQueryClient();
    const url = isAssetRef(image) ? assetUrl(image, transport) : null;
    if (!url) return null;
    if (assetNeedsFetch(transport)) return canFetch ? <FetchedLayer url={url} fit={fit} overlay={overlay} /> : null;
    return <Layer src={url} fit={fit} overlay={overlay} />;
}
