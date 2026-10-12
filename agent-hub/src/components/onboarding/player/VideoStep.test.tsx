import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadLearnManifest, resetLearnManifestCache } from '../learnMedia';
import VideoStep, { type VideoStepDoc } from './VideoStep';

const BASE = '/learn-media';

const MANIFEST = {
    version: '2026.10.1',
    videos: {
        'agents-intro': {
            file: 'agents-intro.3f9a2b1c.mp4',
            captions: { en: 'agents-intro.3f9a2b1c.en.vtt' },
            poster: 'agents-intro.3f9a2b1c.jpg',
            duration: 74,
            transcript: ['An agent is a saved assistant.', 'Give it instructions once.'],
        },
    },
};

const step: VideoStepDoc = {
    id: 'agents-video',
    type: 'video',
    videoId: 'agents-intro',
    titleKey: 'learn.test.agents-video.title',
    titleFallback: 'Agents in 70 seconds',
};

// Prime the shared manifest cache the way the player does, with an injected
// fetch instead of the network (no module mocks).
async function primeManifest(body: unknown, ok = true) {
    resetLearnManifestCache();
    const fetchImpl = vi.fn(async () => ({ ok, json: async () => body }));
    await loadLearnManifest({ fetchImpl, base: BASE });
    return fetchImpl;
}

afterEach(() => resetLearnManifestCache());

describe('VideoStep', () => {
    it('renders a captioned, framed player with poster and caption title', async () => {
        await primeManifest(MANIFEST);
        render(<VideoStep step={step} />);
        const video = screen.getByTestId('lesson-video-player') as HTMLVideoElement;
        expect(video.getAttribute('src')).toBe('/learn-media/agents-intro.3f9a2b1c.mp4');
        expect(video.getAttribute('poster')).toBe('/learn-media/agents-intro.3f9a2b1c.jpg');
        expect(video.hasAttribute('controls')).toBe(true);
        expect(video.getAttribute('preload')).toBe('metadata');
        expect(video.hasAttribute('playsinline')).toBe(true);
        // Same-origin base: no CORS mode needed for the captions.
        expect(video.hasAttribute('crossorigin')).toBe(false);

        const track = video.querySelector('track');
        expect(track).not.toBeNull();
        expect(track?.getAttribute('kind')).toBe('captions');
        expect(track?.getAttribute('srclang')).toBe('en');
        expect(track?.getAttribute('src')).toBe('/learn-media/agents-intro.3f9a2b1c.en.vtt');
        expect(track?.hasAttribute('default')).toBe(true);
        expect(track?.getAttribute('label')).toBe('English');

        expect(screen.getByText('Agents in 70 seconds')).toBeTruthy();
        expect(screen.getByText('Optional: watch it, or carry on with Next.')).toBeTruthy();
    });

    it('has a keyboard-operable transcript toggle', async () => {
        await primeManifest(MANIFEST);
        const user = userEvent.setup();
        render(<VideoStep step={step} />);
        const toggle = screen.getByRole('button', { name: /show transcript/i });
        expect(toggle.getAttribute('aria-expanded')).toBe('false');
        const panel = document.getElementById(toggle.getAttribute('aria-controls') || '');
        expect(panel?.hidden).toBe(true);

        toggle.focus();
        await user.keyboard('{Enter}');
        expect(toggle.getAttribute('aria-expanded')).toBe('true');
        expect(panel?.hidden).toBe(false);
        expect(screen.getByText('An agent is a saved assistant.')).toBeTruthy();
        expect(screen.getByRole('button', { name: /hide transcript/i })).toBe(toggle);
    });

    it('records watched when the clip ends, once', async () => {
        await primeManifest(MANIFEST);
        const onState = vi.fn();
        const { rerender } = render(<VideoStep step={step} onState={onState} />);
        fireEvent.ended(screen.getByTestId('lesson-video-player'));
        expect(onState).toHaveBeenCalledTimes(1);
        expect(onState.mock.calls[0][0]).toMatchObject({ status: 'watched' });
        expect(typeof onState.mock.calls[0][0].watchedAt).toBe('string');

        rerender(<VideoStep step={step} onState={onState} saved={{ status: 'watched' }} />);
        expect(screen.getByTestId('lesson-video-watched')).toBeTruthy();
        fireEvent.ended(screen.getByTestId('lesson-video-player'));
        expect(onState).toHaveBeenCalledTimes(1);
    });

    it('renders nothing and reports unavailable when the pack lacks the clip', async () => {
        await primeManifest({ version: '1', videos: {} });
        const onUnavailable = vi.fn();
        const { container } = render(<VideoStep step={step} onUnavailable={onUnavailable} />);
        expect(container.innerHTML).toBe('');
        await waitFor(() => expect(onUnavailable).toHaveBeenCalled());
    });

    it('renders nothing and reports unavailable when there is no manifest', async () => {
        await primeManifest('<!doctype html>', false);
        const onUnavailable = vi.fn();
        const { container } = render(<VideoStep step={step} onUnavailable={onUnavailable} />);
        expect(container.innerHTML).toBe('');
        await waitFor(() => expect(onUnavailable).toHaveBeenCalled());
    });

    it('reports unavailable when the clip will not play', async () => {
        await primeManifest(MANIFEST);
        const onUnavailable = vi.fn();
        render(<VideoStep step={step} onUnavailable={onUnavailable} />);
        expect(onUnavailable).not.toHaveBeenCalled();
        fireEvent.error(screen.getByTestId('lesson-video-player'));
        expect(onUnavailable).toHaveBeenCalledTimes(1);
    });

    it('omits the transcript toggle and track when the entry has neither', async () => {
        await primeManifest({ version: '1', videos: { 'agents-intro': { file: 'a.mp4' } } });
        render(<VideoStep step={{ ...step, titleKey: undefined, titleFallback: undefined }} />);
        const video = screen.getByTestId('lesson-video-player');
        expect(video.querySelector('track')).toBeNull();
        expect(video.getAttribute('aria-label')).toBe('Lesson video');
        expect(screen.queryByRole('button', { name: /transcript/i })).toBeNull();
    });
});

describe('VideoStep playback errors', () => {
    it('keeps the step when a clip that already loaded hits an error mid-playback', async () => {
        await primeManifest(MANIFEST);
        const onUnavailable = vi.fn();
        render(<VideoStep step={step} onUnavailable={onUnavailable} />);
        const video = screen.getByTestId('lesson-video-player');
        Object.defineProperty(video, 'readyState', { configurable: true, value: 1 }); // HAVE_METADATA
        fireEvent.error(video);
        expect(onUnavailable).not.toHaveBeenCalled();
        expect(screen.getByTestId('lesson-video')).toBeInTheDocument();
    });
});

describe('VideoStep with burned-in captions', () => {
    it('adds no caption track when the subtitles are burned in, and keeps the transcript', async () => {
        const burned = { ...MANIFEST.videos['agents-intro'], burnedCaptions: true };
        await primeManifest({ ...MANIFEST, videos: { 'agents-intro': burned } });
        render(<VideoStep step={step} />);
        const video = screen.getByTestId('lesson-video-player');
        expect(video.getAttribute('src')).toBe('/learn-media/agents-intro.3f9a2b1c.mp4');
        expect(video.querySelector('track')).toBeNull();
        expect(screen.getByRole('button', { name: /show transcript/i })).toBeTruthy();
    });

    it('asks for CORS only when a cross-origin caption track needs it', async () => {
        const cdn = 'https://cdn.example.test/learn';
        const burned = { ...MANIFEST.videos['agents-intro'], burnedCaptions: true };
        resetLearnManifestCache();
        await loadLearnManifest({ fetchImpl: vi.fn(async () => ({ ok: true, json: async () => ({ ...MANIFEST, videos: { 'agents-intro': burned } }) })), base: cdn });
        const { unmount } = render(<VideoStep step={step} />);
        expect(screen.getByTestId('lesson-video-player').hasAttribute('crossorigin')).toBe(false);
        unmount();

        resetLearnManifestCache();
        await loadLearnManifest({ fetchImpl: vi.fn(async () => ({ ok: true, json: async () => MANIFEST })), base: cdn });
        render(<VideoStep step={step} />);
        const video = screen.getByTestId('lesson-video-player');
        expect(video.getAttribute('crossorigin')).toBe('anonymous');
        expect(video.querySelector('track')?.getAttribute('src')).toBe(`${cdn}/agents-intro.3f9a2b1c.en.vtt`);
    });
});
