import { useCallback, useEffect, useRef, useState } from 'react';
import { API_BASE, authFetch } from '../../utils/helpers';

/**
 * Press-to-talk dictation for a composer.
 *
 * Records with MediaRecorder, posts the blob to POST /api/dictate, and hands
 * back the text. The server transcribes locally (NPU Whisper, CPU model as
 * fallback), so nothing spoken here leaves the installation.
 *
 * SECURE CONTEXT: getUserMedia only exists on HTTPS or localhost. This install
 * is served over plain HTTP, so the microphone works at http://localhost:8081
 * and is simply ABSENT at http://192.168.50.49:8081 — the browser removes the
 * API entirely, it is not a permission the user can grant. `supported` reports
 * that up front so the UI can hide the button instead of offering a control
 * that cannot work.
 */

const MAX_SECONDS = 120;

function pickMimeType() {
    if (typeof MediaRecorder === 'undefined') return '';
    // Ordered by how well the server's ffmpeg handles them; every browser
    // supports at least one. An empty string lets the browser choose.
    for (const t of ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']) {
        try { if (MediaRecorder.isTypeSupported(t)) return t; } catch (_) { /* older browsers */ }
    }
    return '';
}

export default function useDictation({ onText, language = 'nl' } = {}) {
    const [state, setState] = useState('idle');       // idle | recording | transcribing
    const [error, setError] = useState(null);
    const [seconds, setSeconds] = useState(0);

    const recorderRef = useRef(null);
    const chunksRef = useRef([]);
    const streamRef = useRef(null);
    const timerRef = useRef(null);
    const cancelledRef = useRef(false);
    const mountedRef = useRef(true);

    const supported = typeof navigator !== 'undefined'
        && !!navigator.mediaDevices?.getUserMedia
        && typeof MediaRecorder !== 'undefined';

    const cleanup = useCallback(() => {
        if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
        // Releasing the tracks is what turns the browser's recording indicator
        // off. Leaving them live reads as "this page is still listening".
        if (streamRef.current) {
            for (const track of streamRef.current.getTracks()) { try { track.stop(); } catch (_) { /* already ended */ } }
            streamRef.current = null;
        }
        recorderRef.current = null;
        chunksRef.current = [];
        setSeconds(0);
    }, []);

    useEffect(() => () => { mountedRef.current = false; cleanup(); }, [cleanup]);

    const transcribe = useCallback(async (blob) => {
        if (!blob || blob.size < 1200) {          // a click, not speech
            if (mountedRef.current) setState('idle');
            return;
        }
        if (mountedRef.current) setState('transcribing');
        try {
            const form = new FormData();
            const ext = (blob.type || '').includes('ogg') ? 'ogg' : (blob.type || '').includes('mp4') ? 'm4a' : 'webm';
            form.append('audio', blob, `dictation.${ext}`);
            form.append('language', language || 'nl');

            const res = await authFetch(`${API_BASE}/api/dictate`, { method: 'POST', body: form });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.error || `Transcription failed (${res.status})`);

            const text = String(data.text || '').trim();
            if (!mountedRef.current) return;
            if (!text) { setError('No speech detected.'); setState('idle'); return; }
            onText?.(text);
            setState('idle');
        } catch (err) {
            if (!mountedRef.current) return;
            setError(err.message || 'Could not transcribe that.');
            setState('idle');
        }
    }, [language, onText]);

    const stop = useCallback(() => {
        const rec = recorderRef.current;
        if (!rec || rec.state === 'inactive') return;
        try { rec.stop(); } catch (_) { cleanup(); setState('idle'); }
    }, [cleanup]);

    const cancel = useCallback(() => {
        cancelledRef.current = true;
        stop();
    }, [stop]);

    const start = useCallback(async () => {
        if (!supported) {
            setError(window.isSecureContext === false
                ? 'The microphone needs a secure page. Open this over localhost or HTTPS.'
                : 'This browser cannot record audio.');
            return;
        }
        setError(null);
        cancelledRef.current = false;
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                // Dictation is one close voice in a room, which is exactly what
                // these three are for.
                audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
            });
            streamRef.current = stream;

            const mimeType = pickMimeType();
            const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
            recorderRef.current = rec;
            chunksRef.current = [];

            rec.ondataavailable = (e) => { if (e.data?.size) chunksRef.current.push(e.data); };
            rec.onerror = () => { cleanup(); setState('idle'); setError('Recording failed.'); };
            rec.onstop = () => {
                const chunks = chunksRef.current;
                const type = rec.mimeType || mimeType || 'audio/webm';
                cleanup();
                if (cancelledRef.current) { setState('idle'); return; }
                transcribe(new Blob(chunks, { type }));
            };

            rec.start();
            setState('recording');
            setSeconds(0);
            timerRef.current = setInterval(() => {
                setSeconds((s) => {
                    const next = s + 1;
                    // Hard stop rather than letting a forgotten open mic run:
                    // the recording lives in memory until it is sent.
                    if (next >= MAX_SECONDS) stop();
                    return next;
                });
            }, 1000);
        } catch (err) {
            cleanup();
            setState('idle');
            setError(err?.name === 'NotAllowedError'
                ? 'Microphone access was blocked. Allow it in your browser settings.'
                : (err?.message || 'Could not start recording.'));
        }
    }, [supported, cleanup, transcribe, stop]);

    const toggle = useCallback(() => {
        if (state === 'recording') stop();
        else if (state === 'idle') start();
    }, [state, start, stop]);

    return {
        supported, state, seconds, error, start, stop, cancel, toggle,
        clearError: () => setError(null),
        // Test seam: jsdom has no MediaRecorder, so the upload half cannot be
        // reached through start()/stop(). Exposing it keeps the request shape
        // (and the /api prefix that once 404'd) under test without shipping a
        // fake recorder.
        __test_transcribe: transcribe,
    };
}
