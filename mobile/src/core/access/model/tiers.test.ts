/** The tier ladder, including the retired Pro tier and names nobody knows. */

import { normalizeTier, tierAtLeast } from './tiers';

describe('normalizeTier', () => {
    it('reads a legacy pro as enterprise and nothing as community', () => {
        expect(normalizeTier('pro')).toBe('enterprise');
        expect(normalizeTier('full')).toBe('full');
        expect(normalizeTier(undefined)).toBe('community');
        expect(normalizeTier('')).toBe('community');
    });
});

describe('tierAtLeast', () => {
    it('climbs the ladder', () => {
        expect(tierAtLeast('enterprise', 'community')).toBe(true);
        expect(tierAtLeast('enterprise', 'enterprise')).toBe(true);
        expect(tierAtLeast('enterprise', 'full')).toBe(false);
        expect(tierAtLeast('pro', 'enterprise')).toBe(true);
    });

    it('reads an unknown name on either side as no', () => {
        expect(tierAtLeast('platinum', 'community')).toBe(false);
        expect(tierAtLeast('full', 'platinum')).toBe(false);
    });
});
