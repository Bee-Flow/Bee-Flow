import { lazy, Suspense, useRef, useState } from 'react';
import { Play } from 'lucide-react';
import LazyLoopVideo from '../components/LazyLoopVideo';
import { resolveAssetUrl } from '../assetUrl';
import type { TourData } from './motion.types';
import useAutoplayAllowed from './useAutoplayAllowed';
import './tour.css';

/**
 * Product tour: a "Watch product tour · 4 minutes" pill that opens the full
 * video in a modal player, and an optional muted teaser loop as the block's
 * visual with the pill on top of it.
 *
 * The modal mounts only when opened, the player has controls and captions (a
 * WebVTT track, when one is set) and never autoplays: the visitor presses
 * play, so sound is always their choice. Closing unmounts the video, which
 * stops it. The teaser loop is lazy (LazyLoopVideo) and falls back to its
 * poster with reduced motion or a data saver.
 */

// The modal player is its own chunk: the pill is on the public entry, the
// player only loads when a visitor shows interest (hover, focus) or opens it.
const loadTourModal = () => import('./TourModal');
const TourModal = lazy(loadTourModal);
const prefetchTourModal = () => { loadTourModal().catch(() => undefined); };

export function hasTour(tour?: TourData | null): boolean {
    return !!tour && tour.enabled !== false && typeof tour.src === 'string' && tour.src.trim() !== '';
}

export function hasTeaser(tour?: TourData | null): boolean {
    return hasTour(tour) && typeof tour?.teaserSrc === 'string' && tour.teaserSrc.trim() !== '';
}

export function pillText(tour: TourData): string {
    return [tour.label?.trim() || 'Watch product tour', tour.duration?.trim()].filter(Boolean).join(' · ');
}

export default function TourPill({ tour, onDark = false }: { tour?: TourData | null; onDark?: boolean }) {
    const [open, setOpen] = useState(false);
    const button = useRef<HTMLButtonElement>(null);
    if (!tour || !hasTour(tour)) return null;
    const close = () => {
        setOpen(false);
        button.current?.focus();
    };
    return (
        <>
            <button
                ref={button}
                type="button"
                className={`tour-pill${onDark ? ' tour-pill--on-dark' : ''}`}
                aria-haspopup="dialog"
                onClick={() => setOpen(true)}
                onPointerEnter={prefetchTourModal}
                onFocus={prefetchTourModal}
            >
                <Play aria-hidden="true" className="tour-pill-icon" />
                <span>{pillText(tour)}</span>
            </button>
            {open ? (
                <Suspense fallback={null}>
                    <TourModal tour={tour} title={tour.alt || pillText(tour)} onClose={close} />
                </Suspense>
            ) : null}
        </>
    );
}

/** The teaser loop as a visual, with the pill laid over it. Without a teaser file it is only the pill. */
export function TourTeaser({ tour }: { tour?: TourData | null }) {
    const allowed = useAutoplayAllowed({ mobile: true });
    if (!tour || !hasTour(tour)) return null;
    if (!hasTeaser(tour)) return <TourPill tour={tour} />;
    const poster = tour.poster?.trim();
    return (
        <figure className="tour-teaser">
            {allowed ? (
                <LazyLoopVideo
                    className="tour-teaser-media"
                    src={resolveAssetUrl((tour.teaserSrc || '').trim())}
                    poster={poster ? resolveAssetUrl(poster) : undefined}
                />
            ) : poster ? (
                <img className="tour-teaser-media" src={resolveAssetUrl(poster)} alt="" loading="lazy" />
            ) : <div className="tour-teaser-media tour-teaser-empty" />}
            <div className="tour-teaser-pill"><TourPill tour={tour} onDark /></div>
        </figure>
    );
}
