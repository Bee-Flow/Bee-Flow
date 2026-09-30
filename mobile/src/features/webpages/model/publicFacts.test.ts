import { translate } from '@/core/i18n';

import type { WebpageAudience } from './audienceTypes';
import { publicFacts } from './publicFacts';

const audience = (pub: Partial<WebpageAudience['public']>): WebpageAudience => ({
    internal: { mode: 'personal', isPublished: false, sharedGroups: [] },
    public: {
        on: true,
        known: true,
        accessMode: 'unlisted',
        hasPassword: false,
        allowedEmails: [],
        expiresAt: null,
        viewCount: 0,
        lastViewedAt: null,
        ...pub,
    },
    address: null,
    columnGate: { tables: [], anyBound: false, sharingCount: 0 },
    shareCount: null,
});

describe('publicFacts', () => {
    it('counts views in the singular and the plural', () => {
        expect(publicFacts(audience({ viewCount: 1 }), translate)).toContain('1 view');
        expect(publicFacts(audience({ viewCount: 0 }), translate)).toContain('0 views');
        expect(publicFacts(audience({ viewCount: 12 }), translate)).toContain('12 views');
    });

    it('says an expiry a week away as a date, never "now"', () => {
        const expiresAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
        const expiry = publicFacts(audience({ expiresAt }), translate).find((f) => f.startsWith('expires '));
        expect(expiry).toBeDefined();
        expect(expiry).not.toMatch(/now/);
        expect(expiry).not.toBe('expires ');
    });

    it('leaves the expiry out when the address does not expire', () => {
        expect(publicFacts(audience({}), translate).some((f) => f.startsWith('expires'))).toBe(false);
    });
});
