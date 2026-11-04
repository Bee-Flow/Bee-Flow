/**
 * The speaker editor follows the organisation's per-person switch: with it off
 * the rows keep their names and merge chips but show no airtime or turn count
 * per colleague; with it on they do.
 */

import { screen } from '@testing-library/react-native';
import React from 'react';

import { renderWithProviders } from '@/shared/testing/renderWithProviders';

import { SpeakersSheet } from './SpeakersSheet';
import { readTranscription } from '../api/readers';
import type { Transcription } from '../model/types';

const meeting = (perPersonInsights: boolean): Transcription => {
    const note = readTranscription({
        id: 't1',
        status: 'completed',
        isOwner: true,
        perPersonInsights,
        speakers: [
            { id: 'Alice', speakingTime: '12:34', speakingSeconds: 754, segments: 41 },
            { id: 'Bob', speakingTime: '01:02', speakingSeconds: 62, segments: 3 },
        ],
    });
    if (!note) throw new Error('fixture did not parse');
    return note;
};

const open = (note: Transcription) =>
    renderWithProviders(
        <SpeakersSheet
            visible
            meeting={note}
            saving={false}
            reidentifying={false}
            error={null}
            onSave={jest.fn()}
            onReidentify={jest.fn()}
            onClose={jest.fn()}
        />,
    );

describe('SpeakersSheet per-person statistics', () => {
    it('hides each speaker\'s airtime and turns when the organisation switched them off', async () => {
        await open(meeting(false));
        expect(screen.getAllByText('Select to merge')).toHaveLength(2);
        expect(screen.queryByText(/12:34/)).toBeNull();
        expect(screen.queryByText(/41 turns/)).toBeNull();
        expect(screen.queryByText(/01:02/)).toBeNull();
    });

    it('shows them when the organisation allows per-person statistics', async () => {
        await open(meeting(true));
        expect(screen.getByText('12:34 · 41 turns')).toBeTruthy();
        expect(screen.getByText('01:02 · 3 turns')).toBeTruthy();
    });
});
