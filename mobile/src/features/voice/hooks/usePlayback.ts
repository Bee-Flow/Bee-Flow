/**
 * The speaker side of the call: play a reply, and notice when it is over.
 *
 * Exactly one reply file is kept alive at a time — the previous one goes as
 * soon as the player has moved on — so a long call leaves no trail of MP3s.
 */

import { useAudioPlayer } from 'expo-audio';
import { useCallback, useRef } from 'react';

import type { Poller } from './usePoller';
import {
    audioModeFor,
    discardFile,
    PLAYBACK_POLL_MS,
    PLAYBACK_START_GRACE_MS,
    writeReplyFile,
} from '../model/audio';
import type { TtsEvent } from '../model/types';

export function usePlayback(poller: Poller) {
    // No source yet; each reply replaces it. The hook releases the player on
    // unmount, which is what stops a half-spoken answer when the screen closes.
    const player = useAudioPlayer(null, { updateInterval: PLAYBACK_POLL_MS });
    /** The cache file the current reply is playing from, so it can be cleaned. */
    const lastReply = useRef<string | null>(null);
    const { start: startPoll, stop: stopPoll } = poller;

    /** Play the reply. False when it could not be — the text is on screen anyway. */
    const playReply = useCallback(
        async (tts: TtsEvent): Promise<boolean> => {
            try {
                const uri = writeReplyFile(tts.audioBase64);
                await audioModeFor('play');
                player.replace({ uri });
                player.play();
                const previous = lastReply.current;
                lastReply.current = uri;
                discardFile(previous);
                return true;
            } catch (err) {
                if (__DEV__) console.warn('[voice] playback failed', err);
                return false;
            }
        },
        [player],
    );

    /**
     * Watch the reply to its end, then call `onFinished`. Polled rather than
     * event-driven: `didJustFinish` does arrive, but a playback that never
     * starts (a truncated MP3, a device with the media session taken) emits
     * nothing at all, and a call that silently stops listening is worse than
     * one that cuts an answer short. The grace period bounds that case.
     */
    const watchPlayback = useCallback(
        (stillSpeaking: () => boolean, onFinished: () => void) => {
            const startedAt = Date.now();
            let sawPlaying = false;
            startPoll(() => {
                if (!stillSpeaking()) {
                    stopPoll();
                    return;
                }
                if (player.playing) {
                    sawPlaying = true;
                    return;
                }
                if (!sawPlaying && Date.now() - startedAt < PLAYBACK_START_GRACE_MS) return;
                stopPoll();
                onFinished();
            }, PLAYBACK_POLL_MS);
        },
        [player, startPoll, stopPoll],
    );

    const pause = useCallback(() => {
        try {
            player.pause();
        } catch {
            /* nothing loaded */
        }
    }, [player]);

    /** Drop the last reply's file — the call is over. */
    const releaseReply = useCallback(() => {
        discardFile(lastReply.current);
        lastReply.current = null;
    }, []);

    return { playReply, watchPlayback, pause, releaseReply };
}
