/**
 * A share link's state and a page's reach — the same judgement the list row,
 * the card and the reach total all make, pinned in one place.
 */

import { isShareLive, reachOf, shareStatus } from './format';
import type { WebpageShare } from './types';

const NOW = Date.parse('2026-09-24T12:00:00Z');

const share = (over: Partial<WebpageShare> = {}): WebpageShare => ({
    id: 'sh1',
    webpageId: 'wp1',
    createdBy: 'u1',
    accessMode: 'unlisted',
    hasPassword: false,
    expiresAt: null,
    revokedAt: null,
    title: '',
    viewCount: 0,
    lastViewedAt: null,
    createdAt: null,
    url: 'https://example.com/share/t',
    ...over,
});

describe('isShareLive and shareStatus', () => {
    it('treats a revoked, expired or unparseable expiry as gone', () => {
        expect(isShareLive(share({ revokedAt: '2026-09-01' }), NOW)).toBe(false);
        expect(isShareLive(share({ expiresAt: '2026-09-01T00:00:00Z' }), NOW)).toBe(false);
        expect(isShareLive(share({ expiresAt: 'soon' }), NOW)).toBe(false);
        expect(isShareLive(share({ expiresAt: '2026-10-01T00:00:00Z' }), NOW)).toBe(true);
    });

    it('labels the access mode of a live link', () => {
        expect(shareStatus(share(), NOW).label).toBe('Live');
        expect(shareStatus(share({ accessMode: 'password' }), NOW).label).toBe('Password');
        expect(shareStatus(share({ accessMode: 'email' }), NOW).label).toBe('Invite only');
        expect(shareStatus(share({ revokedAt: 'x' }), NOW).label).toBe('Revoked');
    });
});

describe('reachOf', () => {
    it('sums views, counts live links and finds the latest view', () => {
        const reach = reachOf(
            [
                share({ viewCount: 3, lastViewedAt: '2026-09-20T10:00:00Z' }),
                share({ id: 'sh2', viewCount: 8, lastViewedAt: '2026-09-22T10:00:00Z', revokedAt: 'x' }),
                share({ id: 'sh3', viewCount: 0 }),
            ],
            NOW,
        );
        expect(reach).toEqual({ views: 11, lastViewedAt: '2026-09-22T10:00:00Z', live: 2 });
    });

    it('says nothing was opened when there are no views', () => {
        expect(reachOf([], NOW)).toEqual({ views: 0, lastViewedAt: null, live: 0 });
    });
});
