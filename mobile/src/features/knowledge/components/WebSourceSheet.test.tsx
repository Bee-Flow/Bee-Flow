/**
 * A web page as a source, typed the way people type an address on a phone:
 * without `https://`. The button comes on for it, the hint says the scheme is
 * added, and the server gets the full address.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import React from 'react';

import { api } from '@/core/api/client';
import { renderScreen } from '@/shared/testing/renderWithProviders';

import { WebSourceSheet } from './WebSourceSheet';

jest.setTimeout(60_000);

jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());

describe('WebSourceSheet', () => {
    it('takes an address without a scheme and sends it with https://', async () => {
        (api.post as jest.Mock).mockResolvedValue(null);
        await renderScreen(<WebSourceSheet kbId="kb1" visible onClose={jest.fn()} />);
        expect(screen.getByText('You can leave out https:// — it is added for you.')).toBeTruthy();
        expect(screen.getByLabelText('Add source')).toBeDisabled();

        await fireEvent.changeText(screen.getByLabelText('Address'), 'example.com');
        expect(screen.getByLabelText('Add source')).toBeEnabled();
        await fireEvent.press(screen.getByLabelText('Add source'));
        await waitFor(() =>
            expect(api.post).toHaveBeenCalledWith(
                '/api/kb/kb1/sources',
                expect.objectContaining({ kind: 'webpage', config: { url: 'https://example.com' } }),
                { retry: false },
            ),
        );
    });

    it('keeps the button off for something that is not an address', async () => {
        await renderScreen(<WebSourceSheet kbId="kb1" visible onClose={jest.fn()} />);
        await fireEvent.changeText(screen.getByLabelText('Address'), 'example');
        expect(screen.getByLabelText('Add source')).toBeDisabled();
    });
});
