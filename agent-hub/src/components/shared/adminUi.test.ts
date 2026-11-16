import { describe, it, expect } from 'vitest';
import * as adminUi from './adminUi';
import * as legacy from '@/components/mcpLibrary/ui';
import { PRIMARY_TONE } from './buttonClasses';

describe('adminUi class kit', () => {
    it('is still reachable through the old mcpLibrary/ui path', () => {
        expect(Object.keys(legacy).sort()).toEqual(Object.keys(adminUi).sort());
        expect(legacy.CHIP_ERROR).toBe(adminUi.CHIP_ERROR);
    });

    it('builds every recipe from theme tokens: no palette class, no hex, no text-white', () => {
        for (const [name, cls] of Object.entries(adminUi)) {
            expect(typeof cls, name).toBe('string');
            expect(cls, name).not.toMatch(/#[0-9a-f]{3,8}\b|text-white|(?:bg|text|border)-(?:blue|emerald|rose|amber|red|green|gray|slate)-\d/i);
        }
    });

    it('has the chip, alert and dot of every status tone', () => {
        expect(adminUi.CHIP_ERROR).toContain('text-[var(--error-ink)]');
        expect(adminUi.CHIP_SUCCESS).toContain('text-[var(--success-ink)]');
        expect(adminUi.CHIP_WARNING).toContain('text-[var(--warning-ink)]');
        expect(adminUi.ALERT_ERROR).toContain('text-[var(--error-ink)]');
        expect(adminUi.DOT_ERROR).toContain('bg-[var(--error)]');
    });

    it('shares the Button primary colours', () => {
        expect(adminUi.PRIMARY_BTN).toContain(PRIMARY_TONE);
    });
});
