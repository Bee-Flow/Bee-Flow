import { render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import ConnectionBand from './ConnectionBand';
import * as live from './ProjectLiveContext';

const withStatus = (status: 'connecting' | 'live' | 'polling' | 'stopped') => {
    vi.spyOn(live, 'useProjectLive').mockReturnValue({
        online: [], typing: {}, subscribe: () => () => {}, notifyTyping: () => {}, status, projectId: null, viewing: {}, setViewing: () => {},
    });
};

describe('ConnectionBand', () => {
    it.each(['live', 'connecting', 'stopped'] as const)('shows nothing while %s', (status) => {
        withStatus(status);
        render(<ConnectionBand />);
        expect(screen.queryByTestId('connection-band')).toBeNull();
    });

    it('says the page refreshes on its own while polling, without a button', () => {
        withStatus('polling');
        render(<ConnectionBand />);
        expect(screen.getByTestId('connection-band')).toHaveTextContent('Reconnecting… this page refreshes every 15 s');
        expect(screen.queryByRole('button')).toBeNull();
    });
});
