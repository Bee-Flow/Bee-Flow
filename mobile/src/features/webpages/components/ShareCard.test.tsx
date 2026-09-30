/**
 * A live share link: its views counted in the singular and plural, and its
 * expiry said as a date. It used to read "Expires now" for a link with a week
 * left (the relative-age helper clamped a future time to zero) and "1 views".
 */

import { screen } from '@testing-library/react-native';
import React from 'react';

import { renderWithProviders } from '@/shared/testing/renderWithProviders';

import { ShareCard } from './ShareCard';
import type { WebpageShare } from '../model/types';

const share = (over: Partial<WebpageShare> = {}): WebpageShare => ({
    id: 's1',
    webpageId: 'w1',
    createdBy: 'u1',
    accessMode: 'unlisted',
    hasPassword: false,
    expiresAt: null,
    revokedAt: null,
    title: 'Pricing',
    viewCount: 1,
    lastViewedAt: null,
    createdAt: '2026-09-01T10:00:00Z',
    url: null,
    ...over,
});

const render = (s: WebpageShare) =>
    renderWithProviders(<ShareCard share={s} owned={false} busy={false} onRefresh={() => undefined} onRevoke={() => undefined} />);

describe('ShareCard', () => {
    it('says a live link’s expiry a week away as a date, never "now"', async () => {
        await render(share({ expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString() }));
        const line = screen.getByText(/^Expires /);
        expect(line).toBeTruthy();
        expect(screen.queryByText(/Expires now/)).toBeNull();
        expect(screen.queryByText(/^Expires $/)).toBeNull();
    });

    it('counts one view as one view', async () => {
        await render(share({ viewCount: 1 }));
        expect(screen.getByText('1 view')).toBeTruthy();
    });

    it('counts several views in the plural', async () => {
        await render(share({ viewCount: 3 }));
        expect(screen.getByText('3 views')).toBeTruthy();
    });
});
