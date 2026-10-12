import { CircleCheck, ChevronDown } from 'lucide-react';
import React, { useEffect, useId, useState } from 'react';
import { useTranslation } from '../../../hooks/useTranslation';
import { isCrossOrigin, mediaUrl, useLearnManifest, videoEntry, videoForLocale } from '../learnMedia';

export interface VideoStepDoc {
    id: string;
    type: 'video';
    videoId: string;
    titleKey?: string;
    titleFallback?: string;
}

export interface VideoStepState {
    status: 'watched';
    watchedAt: string;
}

interface VideoStepProps {
    step: VideoStepDoc;
    saved?: { status?: string } | null;
    onState?: (state: VideoStepState) => void;
    /** The clip is not in the pack or will not play: the player drops the step. */
    onUnavailable?: () => void;
}

/**
 * VideoStep — a short captioned clip inside the LessonPlayer.
 *
 * OPTIONAL by construction (stepTypes.stepIsRequired): Next is always enabled,
 * and nothing about completion or mastery waits on it. Watching to the end
 * records { status: 'watched' }.
 *
 * Never renders an empty frame: while the manifest is unknown it renders
 * nothing, and when the clip is missing from the pack or the browser cannot
 * play it, it calls onUnavailable so the player removes the step (the learner
 * lands on the next one). The player normally filters unavailable videos out
 * before this mounts; this is the backstop for a file that 404s or will not
 * decode.
 */
type Translate = (key: string, fallback: string) => string;

/** A caption track's label in its own language: a Dutch learner looking for Dutch subtitles reads "Nederlands". */
const TRACK_LABELS: Record<string, string> = { nl: 'Nederlands', de: 'Deutsch', fr: 'Français' };

/** The manifest entry for this step, and whether it is known to be missing. */
function useVideoEntry(step: VideoStepDoc, onUnavailable?: () => void) {
    const media = useLearnManifest(true);
    const ready = media.status === 'ready';
    const entry = ready ? videoEntry(step, media.manifest) : null;
    const missing = media.status === 'unavailable' || (ready && !entry);
    useEffect(() => {
        if (missing) onUnavailable?.();
    }, [missing, onUnavailable]);
    return entry && ready ? { entry, base: media.base } : null;
}

function stepTitle(step: VideoStepDoc, t: Translate): string {
    if (!step.titleKey && !step.titleFallback) return '';
    return t(step.titleKey || '', step.titleFallback || '');
}

export default function VideoStep({ step, saved, onState, onUnavailable }: VideoStepProps) {
    const { t, resolvedLocale } = useTranslation();
    const found = useVideoEntry(step, onUnavailable);
    if (!found) return null;

    // The clip in the language the learner reads the app in (the app on
    // screen, the voice and the subtitles), English when the pack has none.
    const { video: entry, lang } = videoForLocale(found.entry, resolvedLocale);
    const { base } = found;
    const title = stepTitle(step, t);
    const watched = saved?.status === 'watched';
    // Burned-in subtitles are always on screen. A <track> next to them would
    // draw every line twice whenever it is shown, and Safari turns one on by
    // itself for a learner whose OS asks for captions; so such a clip gets no
    // track at all, and the transcript below carries the text.
    const track = entry.captions[lang];
    const captions = track && !entry.burnedCaptions ? mediaUrl(base, track) : null;
    const onEnded = () => {
        if (!watched) onState?.({ status: 'watched', watchedAt: new Date().toISOString() });
    };

    return (
        <figure className="m-0 flex flex-col gap-2" data-testid="lesson-video">
            <div className="overflow-hidden rounded-xl border border-[var(--border-default)] bg-black shadow-sm">
                <video
                    className="block w-full aspect-video bg-black"
                    src={mediaUrl(base, entry.file)}
                    poster={entry.poster ? mediaUrl(base, entry.poster) : undefined}
                    controls
                    preload="metadata"
                    playsInline
                    // CORS mode only for a cross-origin caption track: without one,
                    // a CDN that sends no CORS headers can still serve the video.
                    crossOrigin={captions && isCrossOrigin(base) ? 'anonymous' : undefined}
                    aria-label={title || t('learn.video.aria_label', 'Lesson video')}
                    onEnded={onEnded}
                    // Only a clip that never loaded is dropped. A network error
                    // mid-playback (readyState >= HAVE_METADATA) keeps the step,
                    // with the browser's own error state, instead of yanking
                    // the learner on to the next step while they watch.
                    onError={(e) => { if (e.currentTarget.readyState < 1) onUnavailable?.(); }}
                    data-testid="lesson-video-player"
                >
                    {captions && (
                        <track kind="captions" srcLang={lang} src={captions} default label={TRACK_LABELS[lang] || t('learn.video.captions_label', 'English')} />
                    )}
                </video>
            </div>
            <VideoCaption t={t} title={title} watched={watched} />
            {entry.transcript.length > 0 && <Transcript t={t} lines={entry.transcript} />}
        </figure>
    );
}

function VideoCaption({ t, title, watched }: { t: Translate; title: string; watched: boolean }) {
    return (
        <figcaption className="flex items-center gap-2 text-[12px] text-[var(--text-secondary)]">
            {title && <span className="font-medium text-[var(--text-primary)]">{title}</span>}
            {watched ? (
                <span className="inline-flex items-center gap-1 text-[var(--learn-complete-ink)]" data-testid="lesson-video-watched">
                    <CircleCheck className="w-3 h-3" aria-hidden="true" />
                    {t('learn.video.watched', 'Watched')}
                </span>
            ) : (
                <span className="text-[var(--text-tertiary)]">{t('learn.video.optional_hint', 'Optional: watch it, or carry on with Next.')}</span>
            )}
        </figcaption>
    );
}

/** Collapsible transcript: a real button with aria-expanded, so Enter/Space work. */
function Transcript({ t, lines }: { t: Translate; lines: string[] }) {
    const [open, setOpen] = useState(false);
    const id = useId();
    return (
        <div className="rounded-lg border border-[var(--border-default)]">
            <button
                type="button"
                className="flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-[12px] font-medium text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent-primary)]"
                aria-expanded={open}
                aria-controls={id}
                onClick={() => setOpen((o) => !o)}
            >
                {open ? t('learn.video.transcript_hide', 'Hide transcript') : t('learn.video.transcript_show', 'Show transcript')}
                <ChevronDown className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
            </button>
            <div id={id} hidden={!open} className={`${open ? 'flex' : 'hidden'} flex-col gap-1.5 px-3 pb-3 text-[12px] leading-relaxed text-[var(--text-secondary)]`}>
                {lines.map((line, i) => <p key={i} className="m-0">{line}</p>)}
            </div>
        </div>
    );
}
