/** "Run it again" follows the server's canStart: a viewer sees why it is off, everyone else can press it. */

import { fireEvent, screen } from '@testing-library/react-native';
import React from 'react';

import { renderScreen } from '@/shared/testing/renderWithProviders';

import { RunActions } from './RunActions';

const HINT = 'You can view this automation but not start it. Ask the owner for run access.';

const props = () => ({
    awaitingApproval: false,
    live: false,
    decide: { run: jest.fn(), pending: false },
    stop: { run: jest.fn(), pending: false },
    retry: { run: jest.fn(), pending: false },
});

describe('RunActions: run it again', () => {
    it('is disabled, with the reason on screen, for a viewer', async () => {
        const p = props();
        await renderScreen(<RunActions {...p} canRetry={false} />);
        expect(screen.getByText(HINT)).toBeTruthy();
        fireEvent.press(screen.getByText('Run it again'));
        expect(p.retry.run).not.toHaveBeenCalled();
    });

    it('runs it again for a run-role user or an editor', async () => {
        const p = props();
        await renderScreen(<RunActions {...p} canRetry />);
        expect(screen.queryByText(HINT)).toBeNull();
        fireEvent.press(screen.getByText('Run it again'));
        expect(p.retry.run).toHaveBeenCalledTimes(1);
    });
});
