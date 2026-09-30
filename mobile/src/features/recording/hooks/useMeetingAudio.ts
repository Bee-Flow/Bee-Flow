/**
 * The meeting's recording, as a native player.
 *
 * Nothing is downloaded until someone presses play (or taps a transcript
 * turn): most people open a note to read it, and an hour of audio is not a
 * cost to charge them for that. The file then stays in the cache, so the next
 * open plays at once.
 *
 * This hook deliberately does NOT subscribe to the player's status. That
 * ticks four times a second while playing, and the screen that holds this
 * hook also holds the transcript list; AudioPlayerCard subscribes on its own,
 * so only the card re-renders. The one thing this hook must see — the moment
 * a freshly loaded file can take a seek — it reads through a listener.
 */

import { useAudioPlayer, type AudioPlayer } from 'expo-audio';
import { useEffect, useRef, useState } from 'react';

import { downloadMeetingAudio } from '../api/endpoints';
import { nextRate } from '../model/player';

export type AudioPhase = 'idle' | 'loading' | 'ready' | 'error';

export interface MeetingAudio {
    player: AudioPlayer;
    phase: AudioPhase;
    error: unknown;
    rate: number;
    /** Play or pause; the first press downloads. */
    toggle: (playing: boolean) => void;
    /** Jump to a moment and play from it; loads first when needed. */
    seek: (seconds: number) => void;
    cycleRate: () => void;
}

export function useMeetingAudio(id: string): MeetingAudio {
    const [uri, setUri] = useState<string | null>(null);
    const [phase, setPhase] = useState<AudioPhase>('idle');
    const [error, setError] = useState<unknown>(null);
    const [rate, setRate] = useState(1);
    const pending = useRef<number | null>(null);
    const download = useRef<AbortController | null>(null);
    const player = useAudioPlayer(uri ? { uri } : null, { updateInterval: 250 });

    // A seek asked for before the file existed lands once the player has it.
    useEffect(() => {
        // `addListener` is optional here only for the jest mock of expo-audio.
        if (!uri || typeof player.addListener !== 'function') return undefined;
        const land = () => {
            if (pending.current === null) return;
            const at = pending.current;
            pending.current = null;
            player.setPlaybackRate(rate);
            void player.seekTo(at).then(() => player.play());
        };
        const sub = player.addListener('playbackStatusUpdate', (status) => {
            if (status.isLoaded) land();
        });
        // It may have loaded before this listener was attached.
        if (player.isLoaded) land();
        return () => sub.remove();
        // The player is recreated whenever `uri` changes; `rate` is applied
        // here only for the first play, cycleRate handles the rest.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [player, uri]);

    // Leaving the note (or opening another) stops its download: nothing is
    // left running into the cache for a screen that is gone.
    useEffect(() => () => download.current?.abort(), [id]);

    const load = async (startAt: number) => {
        if (phase === 'loading') return;
        pending.current = startAt;
        setPhase('loading');
        setError(null);
        const controller = new AbortController();
        download.current = controller;
        try {
            setUri(await downloadMeetingAudio(id, controller.signal));
            setPhase('ready');
        } catch (err) {
            if (controller.signal.aborted) return;
            pending.current = null;
            setError(err);
            setPhase('error');
        }
    };

    const seek = (seconds: number) => {
        if (phase !== 'ready') {
            void load(seconds);
            return;
        }
        void player.seekTo(seconds).then(() => player.play());
    };

    const toggle = (playing: boolean) => {
        if (phase !== 'ready') {
            void load(0);
            return;
        }
        if (playing) player.pause();
        else player.play();
    };

    const cycleRate = () => {
        const next = nextRate(rate);
        setRate(next);
        if (phase === 'ready') player.setPlaybackRate(next);
    };

    return { player, phase, error, rate, toggle, seek, cycleRate };
}
