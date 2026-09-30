import type { TranslateFn } from '@/core/i18n';

import { licenceSource, tierBadge } from './licence';
import type { LicenseStatus } from './types';

const status = (tier: string): LicenseStatus => ({
    tier,
    source: 'default',
    license: null,
    subscription: null,
    features: [],
    limits: {},
});

describe('tierBadge', () => {
    it('reads Community, neutral, when nothing is known', () => {
        expect(tierBadge(null)).toEqual({ label: 'Community', tone: 'neutral' });
        expect(tierBadge(status('community'))).toEqual({ label: 'Community', tone: 'neutral' });
    });

    it('accents a paid tier', () => {
        expect(tierBadge(status('enterprise'))).toEqual({ label: 'Enterprise', tone: 'accent' });
    });
});

const t = ((_key: string, fallback: string) => fallback) as TranslateFn;

describe('licenceSource', () => {
    it('names each source in words', () => {
        expect(licenceSource('license_key', t)).toBe('A licence key');
        expect(licenceSource('stripe_subscription', t)).toBe('Your subscription');
        expect(licenceSource('server_license', t)).toBe('This installation’s licence');
        expect(licenceSource(undefined, t)).toBe('Bee Flow Community');
    });
});
