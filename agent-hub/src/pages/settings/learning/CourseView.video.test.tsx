import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadLearnManifest, resetLearnManifestCache } from '../../../components/onboarding/learnMedia';
import CourseView from './CourseView';

const t = (_key: string, fallback: string) => fallback;

const lesson = {
    id: 'video-course-lesson',
    titleKey: 'x.title', titleFallback: 'Agents',
    descKey: 'x.desc', descFallback: 'What an agent is',
    estMinutes: 3,
    steps: [
        { type: 'slide', id: 's1', titleKey: 'x.s1', titleFallback: 'What an agent is' },
        { type: 'video', id: 'video-agents-intro', videoId: 'agents-intro', titleKey: 'x.v', titleFallback: 'Agents in 70 seconds' },
        { type: 'quiz', id: 'q1', questionKey: 'x.q1', questionFallback: 'Which one is an agent?' },
    ],
};

function renderCourse() {
    render(
        <CourseView
            t={t} locale="en"
            course={{ id: 'agents', titleKey: 'c.title', titleFallback: 'Agents', descKey: 'c.desc', descFallback: 'Course' }}
            lessons={[lesson]} progressMap={{}} completedMap={{}} masteredMap={{}}
            locked={false} lockedReason="" practiceableIds={new Set()} reviewBuilding={false}
            onBack={() => {}} onStartLesson={() => {}} onPractice={() => {}}
        />,
    );
}

async function primeManifest(body: unknown, ok = true) {
    resetLearnManifestCache();
    await loadLearnManifest({ fetchImpl: vi.fn(async () => ({ ok, json: async () => body })), base: '/learn-media' });
}

afterEach(() => resetLearnManifestCache());

describe('CourseView step list with an optional video', () => {
    it('does not list a video the deployment has no media for', async () => {
        await primeManifest(null, false);
        renderCourse();
        await userEvent.click(screen.getByLabelText('Lesson details'));
        const list = screen.getByTestId('lesson-steps');
        expect(within(list).queryByText(/Agents in 70 seconds/)).toBeNull();
        expect(within(list).getByText(/Which one is an agent\?/)).toBeTruthy();
        // Numbered as the player will show it: the quiz is step 2, not 3.
        expect(within(list).queryByText('3')).toBeNull();
    });

    it('lists the video when the media pack has the clip', async () => {
        await primeManifest({ version: '1', videos: { 'agents-intro': { file: 'agents-intro.3f9a2b1c.mp4' } } });
        renderCourse();
        await userEvent.click(screen.getByLabelText('Lesson details'));
        expect(within(screen.getByTestId('lesson-steps')).getByText(/Agents in 70 seconds/)).toBeTruthy();
    });
});
