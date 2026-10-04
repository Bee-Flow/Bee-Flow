import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadLearnManifest, resetLearnManifestCache } from '../learnMedia';
import { clearEphemeralLesson, registerEphemeralLesson } from '../lessons';
import LessonPlayerJs from './LessonPlayer';

/**
 * Video steps are optional and their media may be absent. These pin the
 * player's side of that contract: an unavailable clip is never shown (the
 * lesson simply has one step fewer), an available one never locks Next, and a
 * clip that fails to play gets out of the way by itself.
 */

const LessonPlayer = LessonPlayerJs as unknown as React.ComponentType<Record<string, unknown>>;

const STEPS = [
    { type: 'slide', id: 'card-1', titleFallback: 'First card', bodyMdFallback: 'Hello.' },
    { type: 'video', id: 'clip', videoId: 'agents-intro', titleFallback: 'Agents in 70 seconds' },
    { type: 'slide', id: 'card-2', titleFallback: 'Second card', bodyMdFallback: 'Bye.' },
];

let lessonId: string | null = null;
function playLesson() {
    lessonId = registerEphemeralLesson({ titleFallback: 'Video lesson', kind: 'lesson', steps: STEPS });
    return render(<LessonPlayer lessonId={lessonId} user={{ id: 'u1', role: 'user' }} onClose={() => {}} />);
}

async function primeManifest(body: unknown, ok = true) {
    resetLearnManifestCache();
    await loadLearnManifest({ fetchImpl: vi.fn(async () => ({ ok, json: async () => body })), base: '/learn-media' });
}

afterEach(() => {
    resetLearnManifestCache();
    if (lessonId) clearEphemeralLesson(lessonId);
    lessonId = null;
});

const nextButton = () => screen.getByRole('button', { name: /^next/i });

describe('LessonPlayer with a video step', () => {
    it('drops the video when there is no media pack', async () => {
        await primeManifest('not found', false);
        const user = userEvent.setup();
        playLesson();
        expect(screen.getAllByText('Step 1 of 2').length).toBeGreaterThan(0);
        await user.click(nextButton());
        expect(screen.getByText('Second card')).toBeTruthy();
        expect(screen.queryByTestId('lesson-video')).toBeNull();
    });

    it('shows an available clip without locking Next', async () => {
        await primeManifest({ version: '1', videos: { 'agents-intro': { file: 'agents-intro.mp4' } } });
        const user = userEvent.setup();
        playLesson();
        expect(screen.getAllByText('Step 1 of 3').length).toBeGreaterThan(0);
        await user.click(nextButton());
        expect(screen.getByTestId('lesson-video')).toBeTruthy();
        expect((nextButton() as HTMLButtonElement).disabled).toBe(false);
        await user.click(nextButton());
        expect(screen.getByText('Second card')).toBeTruthy();
    });

    it('moves on by itself when the clip fails to play', async () => {
        await primeManifest({ version: '1', videos: { 'agents-intro': { file: 'agents-intro.mp4' } } });
        const user = userEvent.setup();
        playLesson();
        await user.click(nextButton());
        fireEvent.error(screen.getByTestId('lesson-video-player'));
        await waitFor(() => expect(screen.getByText('Second card')).toBeTruthy());
        expect(screen.getAllByText('Step 2 of 2').length).toBeGreaterThan(0);
        expect(screen.queryByTestId('lesson-video')).toBeNull();
    });
});
