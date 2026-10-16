import { useEffect, useRef, type CSSProperties } from 'react';

/**
 * LazyLoopVideo: the silent autoplay loop (the "video-silent" CMS kind) that
 * downloads nothing until it is on screen.
 *
 * A bare `<video autoplay src>` starts fetching on page load, whether the
 * visitor ever scrolls to it or not, and several of those compete with the
 * stylesheet, fonts and LCP image for bandwidth (and, server-side, each one
 * holds a streaming connection: issue 224). Here `preload="none"` keeps the
 * browser from fetching, the `src` is attached the first time the element
 * scrolls near the viewport, and playback pauses again when it leaves. Visitors
 * who ask for reduced motion get no autoplay: the browser's own controls, and
 * the poster or (preload metadata) the first frame. The box is reserved by CSS
 * (.lazy-loop-video, 16:9) so it does not resize when the file's metadata
 * arrives during a scroll.
 */

export interface LazyLoopVideoProps {
    src: string;
    poster?: string;
    className?: string;
    style?: CSSProperties;
    ariaLabel?: string;
}

/** Start loading a little before the video is visible, so it is ready on arrival. */
const ROOT_MARGIN = '200px';

function prefersReducedMotion(): boolean {
    return typeof window.matchMedia === 'function'
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export default function LazyLoopVideo({ src, poster, className, style, ariaLabel }: LazyLoopVideoProps) {
    const ref = useRef<HTMLVideoElement>(null);
    const reduced = typeof window !== 'undefined' && prefersReducedMotion();

    useEffect(() => {
        const video = ref.current;
        if (!video || reduced) return;
        if (typeof IntersectionObserver !== 'function') {
            video.src = src;
            void video.play().catch(() => undefined);
            return;
        }
        const observer = new IntersectionObserver((entries) => {
            for (const entry of entries) {
                if (entry.isIntersecting) {
                    if (!video.getAttribute('src')) video.src = src;
                    // A rejected play() is the browser's autoplay policy; the poster stays.
                    void video.play().catch(() => undefined);
                } else {
                    video.pause();
                }
            }
        }, { rootMargin: ROOT_MARGIN });
        observer.observe(video);
        return () => observer.disconnect();
    }, [src, reduced]);

    return (
        <video
            ref={ref}
            className={['lazy-loop-video', className].filter(Boolean).join(' ')}
            style={style}
            poster={poster}
            preload={reduced ? 'metadata' : 'none'}
            muted
            loop
            playsInline
            controls={reduced}
            // With reduced motion there is no observer to attach it, so the
            // source is set directly and only the metadata (first frame) is fetched.
            src={reduced ? src : undefined}
            aria-label={ariaLabel}
        />
    );
}
