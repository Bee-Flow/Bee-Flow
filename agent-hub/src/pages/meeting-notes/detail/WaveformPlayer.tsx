import { Play, Pause, RotateCcw, RotateCw } from 'lucide-react';
import useTranslation from '../../../hooks/useTranslation';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import useWaveform from '../hooks/useWaveform';
import { formatDuration } from '../lib/format';
import { buildSpeakerRows, buildSpeakerColorMap, normalizeChapters } from '../lib/playerData';
import TimelineStack from './player/TimelineStack';
import type { PlayerSegment, TimelineMarker } from './player/player.types';

interface WaveformPlayerProps {
    audioSrc: string;
    onReady?: (api: { seek: (seconds: number) => void }) => void;
    markers?: TimelineMarker[];
    mentionMarkers?: TimelineMarker[];
    segments?: PlayerSegment[];
    speakers?: Array<{ id: string; speakingSeconds?: number }>;
    chapters?: Array<{ title?: string; start?: string; summary?: string }>;
    durationSeconds?: number;
}

/**
 * The meeting player: audio element, transport controls, and the layered
 * timeline (marker rail / waveform / per-speaker rows / chapter strip — see
 * player/TimelineStack.jsx for the layer discipline).
 *
 * Exposes `seek(seconds)` to the parent via the `onReady` callback API.
 */

const RATES = [1, 1.25, 1.5, 2];
const RATE_STORAGE_KEY = 'mn-playback-rate';

/** Playback state + media-event wiring, kept out of the component body. */
/** A duration is only usable if it is a finite, positive number of seconds. */
function finiteDuration(v: number) {
    return Number.isFinite(v) && v > 0 ? v : 0;
}

function useAudioPlayback(audioRef: React.RefObject<HTMLAudioElement | null>, peakDuration: number) {
    const [playing, setPlaying] = useState<boolean>(false);
    const [currentTime, setCurrentTime] = useState<number>(0);
    const [duration, setDuration] = useState<number>(0);

    useEffect(() => {
        const audio = audioRef.current;
        if (!audio) return undefined;
        const onTime = () => setCurrentTime(audio.currentTime);
        // `audio.duration` is Infinity for a stream-recorded WebM — MediaRecorder
        // writes no duration into the container, so the element cannot know it
        // without seeing the last cluster. `audio.duration || peakDuration`
        // treated Infinity as a valid value (it is truthy), which is how the
        // time row rendered "Infinity:NaN:NaN" and every timeline offset
        // collapsed to 0 (x / Infinity). Only a finite, positive duration is
        // usable; `peakDuration` (decoded from the same bytes by Web Audio) and
        // the stored `durationSeconds` are both exact, so there is nothing to
        // recover from the element itself.
        //
        // Do NOT try to "unlock" the element's duration by seeking past the end
        // — the usual `currentTime = 1e10` trick. On a blob-backed WebM the
        // element enters a seek that can never complete, and a later play() then
        // waits on it forever: the button toggles and no audio is ever heard.
        const onMeta = () => setDuration(finiteDuration(audio.duration) || peakDuration || 0);
        const onPlay = () => setPlaying(true);
        const onPause = () => setPlaying(false);
        audio.addEventListener('timeupdate', onTime);
        audio.addEventListener('loadedmetadata', onMeta);
        // Chrome reports Infinity first and revises it once it has seen enough
        // of the stream; without this the corrected value never arrives.
        audio.addEventListener('durationchange', onMeta);
        audio.addEventListener('ended', onPause);
        audio.addEventListener('play', onPlay);
        audio.addEventListener('pause', onPause);
        if (audio.duration) onMeta();
        return () => {
            audio.removeEventListener('timeupdate', onTime);
            audio.removeEventListener('loadedmetadata', onMeta);
            audio.removeEventListener('durationchange', onMeta);
            audio.removeEventListener('ended', onPause);
            audio.removeEventListener('play', onPlay);
            audio.removeEventListener('pause', onPause);
        };
    }, [audioRef, peakDuration]);

    return { playing, currentTime, duration };
}

/**
 * Keep the listening position (and play state) across an <audio> src swap.
 * Used when the waveform hook's blob URL replaces the streaming URL mid-listen.
 */
function useAudioSourceSwap(audioRef: React.RefObject<HTMLAudioElement | null>, src: string) {
    const lastSrcRef = useRef<string | null>(null);
    useEffect(() => {
        const a = audioRef.current;
        if (!a) return;
        if (lastSrcRef.current && lastSrcRef.current !== src && a.currentTime > 0) {
            const t = a.currentTime;
            const wasPlaying = !a.paused;
            const onMeta = () => {
                a.currentTime = t;
                if (wasPlaying) a.play().catch(() => {});
                a.removeEventListener('loadedmetadata', onMeta);
            };
            a.addEventListener('loadedmetadata', onMeta);
        }
        lastSrcRef.current = src;
    }, [audioRef, src]);
}

export default function WaveformPlayer({ audioSrc, onReady, markers = [], mentionMarkers = [], segments = [], speakers = [], chapters = [], durationSeconds = 0 }: WaveformPlayerProps) {
    const { t } = useTranslation();
    const audioRef = useRef<HTMLAudioElement>(null);
    const { peaks, duration: peakDuration, loading, objectUrl } = useWaveform(audioSrc, 600);
    const { playing, currentTime, duration } = useAudioPlayback(audioRef, peakDuration);
    // The waveform hook already downloaded the full authenticated audio; its
    // blob URL backs the <audio> element too (one download, and playback works
    // in the token-bridged iframe embed where the element can't send headers).
    // Until the blob exists the element streams the raw URL, so listening can
    // start immediately; the swap hook restores the position.
    const effectiveSrc = objectUrl || audioSrc;
    useAudioSourceSwap(audioRef, effectiveSrc);
    // On a 100-minute recording the speed control is the most-used one on the
    // player, so the choice sticks across meetings.
    const [rate, setRate] = useState<number>(() => {
        const stored = Number(localStorage.getItem(RATE_STORAGE_KEY));
        return RATES.includes(stored) ? stored : 1;
    });
    const [showRemaining, setShowRemaining] = useState<boolean>(false);

    // Audio metadata can lag or be missing; the stored duration keeps the
    // chapter strip and speaker rows laid out correctly from first paint.
    // Each candidate is filtered, not just the first: `peakDuration` is 0 while
    // the decode is in flight and `durationSeconds` (the value the backend
    // computed, and the one shown in the header) is the reliable floor.
    const effectiveDuration = finiteDuration(duration)
        || finiteDuration(peakDuration)
        || finiteDuration(durationSeconds)
        || 0;
    const { rows, others } = useMemo(
        () => buildSpeakerRows(segments, speakers, effectiveDuration),
        [segments, speakers, effectiveDuration],
    );
    const colorMap = useMemo(() => buildSpeakerColorMap(speakers), [speakers]);
    const chapterBlocks = useMemo(() => normalizeChapters(chapters, effectiveDuration), [chapters, effectiveDuration]);

    useEffect(() => {
        if (audioRef.current) audioRef.current.playbackRate = rate;
    }, [rate, effectiveSrc]);

    const seekTo = useCallback((sec: number, { play = false }: { play?: boolean } = {}) => {
        const audio = audioRef.current;
        if (!audio) return;
        audio.currentTime = Math.max(0, sec);
        if (play) audio.play().catch(() => {});
    }, []);

    useEffect(() => {
        onReady?.({ seek: (sec: number) => seekTo(sec, { play: true }) });
    }, [onReady, seekTo]);

    const togglePlay = () => {
        const a = audioRef.current;
        if (!a) return;
        if (a.paused) a.play().catch(() => {});
        else a.pause();
    };

    const skip = (delta: number) => seekTo((audioRef.current?.currentTime || 0) + delta);

    const cycleRate = () => {
        const next = RATES[(RATES.indexOf(rate) + 1) % RATES.length];
        setRate(next);
        try { localStorage.setItem(RATE_STORAGE_KEY, String(next)); } catch { /* private mode */ }
    };

    // Keyboard on the player container only — global handlers would steal
    // keystrokes from the transcript search input.
    const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === ' ') { e.preventDefault(); togglePlay(); }
        else if (e.key === 'ArrowLeft') { e.preventDefault(); skip(-5); }
        else if (e.key === 'ArrowRight') { e.preventDefault(); skip(5); }
    };

    return (
        <div
            tabIndex={0}
            onKeyDown={onKeyDown}
            aria-label={t('meeting_notes.player_aria', 'Meeting audio player. Space to play or pause, arrow keys to skip.')}
            className="flex items-center gap-3 px-3 py-2.5 rounded-xl border outline-none focus-visible:ring-1 bg-[var(--bg-secondary)] border-[var(--border-default)]"
        >
            <Transport playing={playing} onToggle={togglePlay} onSkip={skip} />

            <div className="flex-1 min-w-0">
                <TimelineStack
                    peaks={peaks}
                    loading={loading}
                    duration={effectiveDuration}
                    currentTime={currentTime}
                    markers={markers}
                    mentionMarkers={mentionMarkers}
                    rows={rows}
                    others={others}
                    colorMap={colorMap}
                    chapters={chapterBlocks}
                    segments={segments}
                    onSeekTo={seekTo}
                />
                <TimeRow
                    currentTime={currentTime}
                    duration={effectiveDuration}
                    showRemaining={showRemaining}
                    onToggle={() => setShowRemaining((v: boolean) => !v)}
                />
            </div>

            <RateChip rate={rate} onCycle={cycleRate} />
            <audio ref={audioRef} src={effectiveSrc} preload="metadata" />
        </div>
    );
}

function Transport({ playing, onToggle, onSkip }: { playing: boolean; onToggle: () => void; onSkip: (delta: number) => void }) {
    return (
        <div className="flex items-center gap-1">
            <SkipButton onClick={() => onSkip(-10)} label="Back 10 seconds"><RotateCcw className="w-3.5 h-3.5" /></SkipButton>
            <button
                type="button"
                onClick={onToggle}
                aria-label={playing ? 'Pause' : 'Play'}
                className="w-10 h-10 rounded-full flex items-center justify-center text-white transition-transform hover:scale-105 bg-[var(--accent-primary)]"
            >
                {playing ? <Pause className="w-4 h-4" fill="currentColor" /> : <Play className="w-4 h-4 ml-0.5" fill="currentColor" />}
            </button>
            <SkipButton onClick={() => onSkip(10)} label="Forward 10 seconds"><RotateCw className="w-3.5 h-3.5" /></SkipButton>
        </div>
    );
}

function TimeRow({ currentTime, duration, showRemaining, onToggle }: { currentTime: number; duration: number; showRemaining: boolean; onToggle: () => void }) {
    return (
        <div className="flex items-center justify-between text-[11px] mt-1 font-mono text-[var(--text-muted)]">
            <span>{formatDuration(currentTime)}</span>
            <button
                type="button"
                onClick={onToggle}
                className="font-mono hover:underline"
                aria-label={showRemaining ? 'Show total duration' : 'Show remaining time'}
            >
                {showRemaining ? `-${formatDuration(Math.max(0, duration - currentTime))}` : formatDuration(duration)}
            </button>
        </div>
    );
}

function RateChip({ rate, onCycle }: { rate: number; onCycle: () => void }) {
    return (
        <button
            type="button"
            onClick={onCycle}
            aria-label={`Playback speed ${rate}x, click to change`}
            className="px-2 py-1 rounded-md text-[11px] font-semibold border tabular-nums"
            style={{
                borderColor: rate !== 1 ? 'var(--accent-primary)' : 'var(--border-default)',
                color: rate !== 1 ? 'var(--accent-primary)' : 'var(--text-secondary)',
            }}
        >
            {rate}×
        </button>
    );
}

function SkipButton({ onClick, label, children }: { onClick: () => void; label: string; children?: React.ReactNode }) {
    return (
        <button
            type="button"
            onClick={onClick}
            aria-label={label}
            className="w-7 h-7 rounded-full flex items-center justify-center transition-colors hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
        >
            {children}
        </button>
    );
}
