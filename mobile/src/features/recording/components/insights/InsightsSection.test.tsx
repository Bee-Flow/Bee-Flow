/**
 * The Insights on a finished note: the three headline numbers, the details
 * sheet and its tabs, the viewer's own row first, and the organisation's
 * per-person switch keeping every named statistic off the screen.
 */

import { fireEvent, screen } from '@testing-library/react-native';
import React from 'react';

import type { Transcription } from '@/features/recording/model/types';
import { renderWithProviders } from '@/shared/testing/renderWithProviders';

import { InsightsSection } from './InsightsSection';

jest.setTimeout(30_000);
jest.mock('@/core/auth/AuthProvider', () => ({ useAuth: () => ({ user: { id: 'me', displayName: 'Ans de Vries' } }) }));

const turns = Array.from({ length: 24 }, (_, i) => ({
    speaker: i % 2 === 0 ? 'Tom' : 'Ans de Vries',
    start: i * 25,
    end: i * 25 + 20,
    text: i % 4 === 0 ? 'Zullen we de planning aanpassen?' : 'Ja, de planning moet anders.',
}));

const MEETING = {
    id: 'm1',
    durationSeconds: 660,
    segments: turns,
    speakers: [
        { id: 'Tom', speakingSeconds: 240, summary: 'Stelde de vragen.' },
        { id: 'Ans de Vries', speakingSeconds: 240 },
    ],
    chapters: [
        { title: 'Opening', start: '00:00' },
        { title: 'Planning', start: '04:00' },
    ],
    tags: ['planning'],
    attendees: ['Tom', 'Ans de Vries', 'Karel'],
    actionItems: [{ text: 'Plan sturen', assignee: 'Tom', timestamp: '05:00' }],
    decisions: [{ text: 'Door' }],
    questions: [{ text: 'Wie betaalt?', timestamp: '06:00', open: true }],
    perPersonInsights: true,
} as unknown as Transcription;

describe('InsightsSection', () => {
    it('shows balance, interactivity and silence on the note', async () => {
        await renderWithProviders(<InsightsSection meeting={MEETING} />);
        expect(screen.getByText('Insights')).toBeTruthy();
        expect(screen.getByLabelText('Balance, 100%')).toBeTruthy();
        expect(screen.getByText('Interactivity')).toBeTruthy();
        expect(screen.getByText('Silence')).toBeTruthy();
    });

    it('opens the details on the Overview, and each tab says its part', async () => {
        const seek = jest.fn();
        await renderWithProviders(<InsightsSection meeting={MEETING} onSeek={seek} />);
        await fireEvent.press(screen.getByTestId('insights-details'));
        expect(screen.getByText('People who spoke')).toBeTruthy();
        expect(screen.getByText('Biggest topic')).toBeTruthy();
        await fireEvent.press(screen.getByText('Topics'));
        expect(screen.getByText('Time per topic')).toBeTruthy();
        await fireEvent.press(screen.getByText('Follow-up'));
        expect(screen.getByText('Left unanswered')).toBeTruthy();
        await fireEvent.press(screen.getByText('Wie betaalt?'));
        expect(seek).toHaveBeenCalledWith(360);
    });

    it('puts the viewer first among the people, and names who did not speak', async () => {
        await renderWithProviders(<InsightsSection meeting={MEETING} />);
        await fireEvent.press(screen.getByTestId('insights-details'));
        await fireEvent.press(screen.getByText('People'));
        expect(screen.getByText('you')).toBeTruthy();
        const names = screen.getAllByText(/^(Tom|Ans de Vries)$/).map((node) => node.props.children);
        expect(names[0]).toBe('Ans de Vries');
        expect(screen.getByText('Karel')).toBeTruthy();
    });

    it('keeps every named statistic off the screen when the organisation switched them off', async () => {
        await renderWithProviders(<InsightsSection meeting={{ ...MEETING, perPersonInsights: false }} />);
        await fireEvent.press(screen.getByTestId('insights-details'));
        expect(screen.queryByText('Most questions asked')).toBeNull();
        expect(screen.getByText('Per-person statistics are disabled by your organization.')).toBeTruthy();
        await fireEvent.press(screen.getByText('People'));
        expect(screen.queryByText('you')).toBeNull();
    });

    it('says so when there is too little speech for insights', async () => {
        await renderWithProviders(<InsightsSection meeting={{ ...MEETING, segments: [] }} />);
        expect(screen.getByText('Not enough data for insights on this meeting.')).toBeTruthy();
        expect(screen.queryByTestId('insights-details')).toBeNull();
    });
});
