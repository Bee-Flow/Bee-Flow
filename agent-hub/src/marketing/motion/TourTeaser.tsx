import { Suspense, useRef, useState } from 'react';
import { Play } from 'lucide-react';
import LazyLoopVideo from '../components/LazyLoopVideo';
import { resolveAssetUrl } from '../assetUrl';
import type { TourData } from './motion.types';
import useAutoplayAllowed from './useAutoplayAllowed';
import TourPill, { TourModal, hasTeaser, hasTour, pillText, prefetchTourModal } from './TourPill';
import './tourTeaser.css';

/**
 * The tour's teaser loop as a hero visual: the muted loop at full colour in
 * the normal media frame (hairline, radius), like a product screenshot that
 * happens to move. The pill sits in the frame's bottom-left corner, or under
 * the frame (`teaserPill: "below"`). A click anywhere on the frame opens the
 * player; hover or focus on the frame raises the pill. Its own chunk, so the
 * public entry carries only the pill. With reduced motion or a data saver the
 * loop is its poster (useAutoplayAllowed).
 */
export default function TourTeaser({ tour }: { tour?: TourData | null }) {
    const allowed = useAutoplayAllowed({ mobile: true });
    const [open, setOpen] = useState(false);
    const button = useRef<HTMLButtonElement>(null);
    if (!tour || !hasTour(tour)) return null;
    if (!hasTeaser(tour)) return <TourPill tour={tour} />;
    const poster = tour.poster?.trim();
    const below = tour.teaserPill === 'below';
    const close = () => {
        setOpen(false);
        button.current?.focus();
    };
    const pill = (
        <button
            ref={button}
            type="button"
            className="tour-pill tour-pill--on-dark"
            aria-haspopup="dialog"
            onClick={() => setOpen(true)}
            onPointerEnter={prefetchTourModal}
            onFocus={prefetchTourModal}
        >
            <Play aria-hidden="true" className="tour-pill-icon" />
            <span>{pillText(tour)}</span>
        </button>
    );
    return (
        <div className="tour-teaser">
            {/* The pill is the keyboard and screen-reader control; the frame click is the pointer shortcut. */}
            <figure className="tour-teaser-frame cms-frame" onClick={() => setOpen(true)} onPointerEnter={prefetchTourModal}>
                {allowed ? (
                    <LazyLoopVideo
                        className="tour-teaser-media"
                        src={resolveAssetUrl((tour.teaserSrc || '').trim())}
                        poster={poster ? resolveAssetUrl(poster) : undefined}
                    />
                ) : poster ? (
                    <img className="tour-teaser-media" src={resolveAssetUrl(poster)} alt="" loading="lazy" />
                ) : <div className="tour-teaser-media" />}
                {below ? null : <div className="tour-teaser-corner">{pill}</div>}
            </figure>
            {below ? <div className="tour-teaser-below">{pill}</div> : null}
            {open ? (
                <Suspense fallback={null}>
                    <TourModal tour={tour} title={tour.alt || pillText(tour)} onClose={close} />
                </Suspense>
            ) : null}
        </div>
    );
}
