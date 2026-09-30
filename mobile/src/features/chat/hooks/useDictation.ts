/**
 * Dictation into the composer (the web's useDictation): record, stop, and
 * the server's words are put where the cursor is. Local speech recognition
 * on the server (routes/dictate.js), so a dictated phrase never goes to a
 * cloud vendor. Two minutes at most, as on the web; a tap shorter than a
 * second is a mis-tap, not speech, and is dropped without a round trip.
 */

import { RecordingPresets, requestRecordingPermissionsAsync, setAudioModeAsync, useAudioRecorder } from 'expo-audio';
import { useCallback, useEffect, useRef, useState } from 'react';

import { currentLocale } from '@/core/i18n';
import { micBlocked } from '@/shared/device/useMicPermission';

import { dictate } from '../api/dictate';

export type DictationState = 'idle' | 'recording' | 'transcribing';

/**
 * What went wrong, for the composer to put in words: the microphone refused
 * (`microphone_blocked` once Android will not ask again, so only its settings
 * can help), nothing heard, or the server's failure.
 */
export type DictationProblem = 'microphone' | 'microphone_blocked' | 'no_speech' | 'failed';

const MAX_MS = 120_000;
const MIN_MS = 800;

export function useDictation({
    onText,
    onError,
}: {
    onText: (text: string) => void;
    /** Null clears the last problem, when a new recording starts. */
    onError: (problem: DictationProblem | null) => void;
}) {
    const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
    const [state, setState] = useState<DictationState>('idle');
    const startedAt = useRef(0);
    const limit = useRef<ReturnType<typeof setTimeout> | null>(null);

    const clearLimit = () => {
        if (limit.current) clearTimeout(limit.current);
        limit.current = null;
    };
    useEffect(() => clearLimit, []);

    const stop = useCallback(async () => {
        clearLimit();
        if (!recorder.isRecording) return;
        await recorder.stop();
        void setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
        const uri = recorder.uri;
        if (!uri || Date.now() - startedAt.current < MIN_MS) {
            setState('idle');
            return;
        }
        setState('transcribing');
        try {
            const text = await dictate(uri, currentLocale().split('-')[0] || 'nl');
            if (text) onText(text);
            else onError('no_speech');
        } catch {
            onError('failed');
        } finally {
            setState('idle');
        }
    }, [recorder, onText, onError]);

    const start = useCallback(async () => {
        onError(null);
        const permission = await requestRecordingPermissionsAsync().catch(() => ({ granted: false, canAskAgain: true }));
        if (!permission.granted) {
            onError(micBlocked({ ...permission, unknown: false }) ? 'microphone_blocked' : 'microphone');
            return;
        }
        await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true }).catch(() => undefined);
        await recorder.prepareToRecordAsync();
        recorder.record();
        startedAt.current = Date.now();
        setState('recording');
        limit.current = setTimeout(() => void stop(), MAX_MS);
    }, [recorder, stop, onError]);

    const toggle = useCallback(() => {
        if (state === 'recording') void stop();
        else if (state === 'idle') void start().catch(() => onError('failed'));
    }, [state, start, stop, onError]);

    return { state, toggle };
}
