/**
 * A sitemap typed without `https://`: the button comes on, the hint says the
 * scheme is added, and the server gets the full address.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import React from 'react';

import { api } from '@/core/api/client';
import { renderScreen } from '@/shared/testing/renderWithProviders';

import { SitemapSheet } from './SitemapSheet';

jest.setTimeout(60_000);

jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());

describe('SitemapSheet', () => {
    it('takes an address without a scheme and sends it with https://', async () => {
        (api.post as jest.Mock).mockResolvedValue({ ingested: 3, skipped: 0, errors: 0, totalPages: 3 });
        const onClose = jest.fn();
        await renderScreen(<SitemapSheet kbId="kb1" visible onClose={onClose} />);
        expect(screen.getByText('You can leave out https:// — it is added for you.')).toBeTruthy();
        expect(screen.getByLabelText('Add source')).toBeDisabled();

        await fireEvent.changeText(screen.getByLabelText('Address'), 'example.com/sitemap.xml');
        await fireEvent.press(screen.getByLabelText('Add source'));
        await waitFor(() => expect(onClose).toHaveBeenCalled());
        expect(api.post).toHaveBeenCalledWith(
            '/api/kb/kb1/ingest/sitemap',
            { url: 'https://example.com/sitemap.xml', maxPages: 100 },
            expect.objectContaining({ retry: false }),
        );
    });
});
