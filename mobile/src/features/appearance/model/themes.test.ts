import { PICKABLE_THEMES } from '@/core/theme/tokens';

import { themeHint, themeLabel, themeName } from './themes';

describe('theme words', () => {
    it('has a name and a line for every theme the picker offers', () => {
        for (const name of PICKABLE_THEMES) {
            expect(themeName(name).length).toBeGreaterThan(0);
            expect(themeHint(name).length).toBeGreaterThan(0);
        }
    });

    it('calls the two themes Day and Night, and system "Match my phone"', () => {
        expect(themeLabel('light')).toBe('Day');
        expect(themeLabel('dark')).toBe('Night');
        expect(themeLabel('system')).toBe('Match my phone');
    });
});
