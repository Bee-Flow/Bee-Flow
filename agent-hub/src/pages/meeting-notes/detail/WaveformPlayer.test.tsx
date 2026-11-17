import { render, screen, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';

// The waveform hook does an authenticated fetch + Web Audio decode; neither
// exists in jsdom, and neither is what this test is about.
vi.mock('../hooks/useWaveform', () => ({
    default: () => ({ peaks: null, duration: 0, loading: false, objectUrl: null, error: null }),
}));

import WaveformPlayer from './WaveformPlayer';

/**
 * MediaRecorder writes no duration into the WebM container, so `<audio>.duration`
 * is `Infinity` for every in-browser recording until the element has scanned to
 * the last cluster.
 *
 * `audio.duration || peakDuration || durationSeconds` accepted that — Infinity
 * is truthy — so the player's time row rendered the literal string
 * "Infinity:NaN:NaN" and every timeline offset became `x / Infinity === 0`.
 */
describe('WaveformPlayer with an Infinity-duration recording', () => {
    let originalDuration: PropertyDescriptor | undefined;

    beforeAll(() => {
        // jsdom has no layout engine, so no ResizeObserver; the canvas redraw
        // it drives is irrelevant here.
        if (!window.ResizeObserver) {
            window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
            globalThis.ResizeObserver = window.ResizeObserver;
        }
        originalDuration = Object.getOwnPropertyDescriptor(window.HTMLMediaElement.prototype, 'duration');
        Object.defineProperty(window.HTMLMediaElement.prototype, 'duration', {
            configurable: true,
            get() { return Infinity; },
        });
    });

    afterAll(() => {
        if (originalDuration) Object.defineProperty(window.HTMLMediaElement.prototype, 'duration', originalDuration);
        else delete (window.HTMLMediaElement.prototype as { duration?: unknown }).duration;
    });

    it('falls back to the stored duration instead of rendering Infinity', () => {
        const { container } = render(
            <WaveformPlayer audioSrc="/api/transcriptions/abc/audio" durationSeconds={2397} />
        );

        const audio = container.querySelector('video');
        act(() => { audio!.dispatchEvent(new Event('loadedmetadata')); });

        expect(screen.queryByText(/Infinity/)).toBeNull();
        expect(screen.queryByText(/NaN/)).toBeNull();
        // 2397s = 39:57 — the duration the backend computed, shown in the header.
        expect(screen.getByText('39:57')).toBeTruthy();
    });
});

/**
 * A Nextcloud Talk recording made in video mode is saved whole (an .mp4 or
 * .webm with a picture), but the player played it through an <audio> element:
 * the picture was never shown. The player now plays every recording through a
 * <video> element and shows it only when the file has a picture.
 */
describe('WaveformPlayer with a video recording', () => {
    beforeAll(() => {
        if (!window.ResizeObserver) {
            window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
            globalThis.ResizeObserver = window.ResizeObserver;
        }
    });
    afterEach(() => {
        delete (window.HTMLVideoElement.prototype as { videoWidth?: unknown }).videoWidth;
    });

    function setVideoWidth(width: number) {
        Object.defineProperty(window.HTMLVideoElement.prototype, 'videoWidth', { configurable: true, get: () => width });
    }

    it('shows the picture when the recording has one', () => {
        setVideoWidth(1280);
        const { container } = render(<WaveformPlayer audioSrc="/api/transcriptions/abc/audio" durationSeconds={60} />);
        const video = container.querySelector('video')!;
        expect(video).toBeTruthy();
        act(() => { video.dispatchEvent(new Event('loadedmetadata')); });
        expect(video.classList.contains('hidden')).toBe(false);
    });

    it('keeps an audio-only recording out of sight', () => {
        setVideoWidth(0);
        const { container } = render(<WaveformPlayer audioSrc="/api/transcriptions/abc/audio" durationSeconds={60} />);
        const video = container.querySelector('video')!;
        act(() => { video.dispatchEvent(new Event('loadedmetadata')); });
        expect(video.classList.contains('hidden')).toBe(true);
    });
});
