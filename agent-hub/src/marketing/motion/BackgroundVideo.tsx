import { resolveAssetUrl } from '../assetUrl';
import LazyLoopVideo from '../components/LazyLoopVideo';
import { backgroundVideoLook, hasBackgroundVideo, hasVideoSource } from './backgroundVideo';
import type { BackgroundVideoData } from './motion.types';
import useAutoplayAllowed from './useAutoplayAllowed';
import './backgroundVideo.css';

const trimmed = (value?: string): string => (typeof value === 'string' ? value.trim() : '');

/**
 * BackgroundVideo: a full-bleed looping video behind a hero or band, with an
 * overlay for legibility. Place it as the first child of a `position: relative`
 * section and give the section the `has-bg-video` class.
 *
 * The poster is a real image and always renders (it is the LCP candidate and
 * the static fallback); the video is mounted only after hydration, and only
 * when motion is welcome: not on a phone-width screen, not with
 * prefers-reduced-motion, not with a data saver. It is muted, never has
 * controls, downloads nothing until it is near the viewport (LazyLoopVideo)
 * and pauses off-screen. The box is the section itself, so nothing shifts.
 */
export default function BackgroundVideo({ video, priority = true }: { video?: BackgroundVideoData | null; priority?: boolean }) {
    const allowed = useAutoplayAllowed();
    if (!video || !hasBackgroundVideo(video)) return null;
    const look = backgroundVideoLook(video);
    const poster = trimmed(video.poster);
    const mp4 = trimmed(video.src);
    const webm = trimmed(video.webmSrc);
    const play = allowed && hasVideoSource(video);
    const classes = `bg-video bg-video--fit-${look.fit} bg-video--pos-${look.position}`;
    return (
        <div className={classes} aria-hidden="true" data-playing={play ? 'true' : 'false'}>
            {poster ? (
                <img
                    className="bg-video-media"
                    src={resolveAssetUrl(poster)}
                    alt=""
                    {...(priority ? { loading: 'eager' as const, fetchPriority: 'high' as const } : { loading: 'lazy' as const })}
                />
            ) : null}
            {play ? (
                <LazyLoopVideo
                    className="bg-video-media"
                    src={mp4 ? resolveAssetUrl(mp4) : resolveAssetUrl(webm)}
                    webmSrc={mp4 && webm ? resolveAssetUrl(webm) : undefined}
                    poster={poster ? resolveAssetUrl(poster) : undefined}
                />
            ) : null}
            {look.overlay !== 'none' ? (
                <div className={`bg-video-overlay bg-video-overlay--${look.overlay}`} style={look.overlayStyle} />
            ) : null}
        </div>
    );
}
