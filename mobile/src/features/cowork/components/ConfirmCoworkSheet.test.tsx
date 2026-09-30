/**
 * The confirm sheet says a failed create through describeError: an offline
 * phone reads as offline, not as the raw sentence the error was built with.
 */

import { screen } from '@testing-library/react-native';
import React from 'react';

import { OfflineError } from '@/core/api/client';
import { renderScreen } from '@/shared/testing/renderWithProviders';

import { ConfirmCoworkSheet } from './ConfirmCoworkSheet';
import type { Proposal } from '../model/proposal';

jest.setTimeout(60_000);

const PROPOSAL: Proposal = {
    title: 'Weekly digest',
    prompt: 'Summarise the week.',
    scheduleSentence: 'Every Monday at 08:00',
    repeat: null,
    payload: null,
};

describe('ConfirmCoworkSheet', () => {
    it('says a failed create in describeError’s words', async () => {
        await renderScreen(
            <ConfirmCoworkSheet proposal={PROPOSAL} error={new OfflineError()} creating={false} onCreate={jest.fn()} onDismiss={jest.fn()} />,
        );
        expect(screen.getByText('Bee Flow will pick up where you left off once you are back on a network.')).toBeTruthy();
        expect(screen.queryByText('You appear to be offline.')).toBeNull();
    });
});
