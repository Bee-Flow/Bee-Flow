import { resolveAssetUrl } from '../assetUrl';

/**
 * ClipVideo — a demo clip WITH sound, as the CMS "clip" media kind.
 *
 * Unlike the silent loop (autoplay, muted, no controls) this is a normal
 * player: controls, no autoplay, sound on, and only the metadata is fetched
 * up front (clips are 50-110 MB). An optional poster is shown until play, an
 * optional WebVTT track is offered as default captions.
 */

export interface ClipMedia {
    src?: string;
    poster?: string;
    captionsSrc?: string;
    captionsLang?: string;
    alt?: string;
}

function languageLabel(lang: string): string {
    try {
        return new Intl.DisplayNames([lang], { type: 'language' }).of(lang) || lang;
    } catch {
        return lang;
    }
}

export function hasClipSrc(media?: ClipMedia | null): boolean {
    return typeof media?.src === 'string' && media.src.trim() !== '';
}

export default function ClipVideo({ media, className = '' }: { media: ClipMedia; className?: string }) {
    const poster = media.poster?.trim();
    const captions = media.captionsSrc?.trim();
    const lang = media.captionsLang?.trim() || 'en';
    return (
        <video
            className={['clip-video', className].filter(Boolean).join(' ')}
            src={resolveAssetUrl((media.src || '').trim())}
            poster={poster ? resolveAssetUrl(poster) : undefined}
            controls
            preload="metadata"
            playsInline
            aria-label={media.alt || undefined}
        >
            {captions ? (
                <track kind="captions" src={resolveAssetUrl(captions)} srcLang={lang} label={languageLabel(lang)} default />
            ) : null}
        </video>
    );
}
