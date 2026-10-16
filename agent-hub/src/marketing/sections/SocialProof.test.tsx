import { render, cleanup } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import SocialProof from './SocialProof';

const STATS = [{ number: '100%', label: 'EU hosted' }, { number: 'AES-256', label: 'Encryption' }];
const CHIPS = [{ label: 'Open source', icon: 'Code' }, { label: 'GDPR' }];
const LOGOS = [{ src: '/a.png', alt: 'Logo A' }];

function mount(data: object) {
    return render(<SocialProof data={{ enabled: true, ...data }} />).container;
}

describe('SocialProof modes', () => {
    afterEach(() => cleanup());

    it('classic keeps the logo wall and ignores stats and chips', () => {
        const c = mount({ variant: 'classic', logos: LOGOS, stats: STATS, chips: CHIPS });
        expect(c.querySelector('.social-proof-logos')).not.toBeNull();
        expect(c.querySelector('.social-proof-stats')).toBeNull();
        expect(c.querySelector('.social-proof-chips')).toBeNull();
    });

    it('numbers renders the stats row above the wall when there are logos', () => {
        const c = mount({ variant: 'numbers', logos: LOGOS, stats: STATS });
        expect(c.querySelectorAll('.social-proof-stat')).toHaveLength(2);
        expect(c.querySelector('.social-proof-logos')).not.toBeNull();
    });

    it('numbers without logos renders no logo strip and no reserved height', () => {
        const c = mount({ variant: 'numbers', logos: [], stats: STATS });
        expect(c.querySelectorAll('.social-proof-stat')).toHaveLength(2);
        expect(c.querySelector('.social-proof-logos')).toBeNull();
    });

    it('stats renders the numbers only, even when logos exist', () => {
        const c = mount({ variant: 'stats', logos: LOGOS, stats: STATS });
        expect(c.querySelectorAll('.social-proof-stat')).toHaveLength(2);
        expect(c.querySelector('.social-proof-logos')).toBeNull();
    });

    it('chips renders text chips, an optional icon each, and no logos', () => {
        const c = mount({ variant: 'chips', logos: LOGOS, chips: CHIPS });
        const chips = c.querySelectorAll('.social-proof-chip');
        expect(chips).toHaveLength(2);
        expect(chips[0].textContent).toBe('Open source');
        expect(chips[0].querySelector('svg')).not.toBeNull();
        expect(chips[1].querySelector('svg')).toBeNull();
        expect(c.querySelector('.social-proof-logos')).toBeNull();
        expect(c.querySelector('.social-proof-stats')).toBeNull();
    });

    it('drops chips without a label and treats an unknown variant as classic', () => {
        const c = mount({ variant: 'chips', chips: [{ label: '' }, { label: 'GDPR' }] });
        expect(c.querySelectorAll('.social-proof-chip')).toHaveLength(1);
        const d = mount({ variant: 'bogus', logos: LOGOS, stats: STATS });
        expect(d.querySelector('.social-proof-logos')).not.toBeNull();
    });
});
