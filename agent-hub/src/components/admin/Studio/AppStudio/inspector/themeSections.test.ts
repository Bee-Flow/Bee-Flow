import { describe, it, expect } from 'vitest';
import { THEME_SECTIONS, collectThemeSections } from './themeSections';
import type { ThemeSectionEntry, ThemeSectionProps } from './themeSections';

const Section = (_props: ThemeSectionProps) => null;
const late: ThemeSectionEntry = { Section, order: 200 };

describe('theme panel sections added as files', () => {
    it('every shipped section is a component under its own name, in panel order', () => {
        // Nothing, or any number of files: the panel draws them between its own sections.
        for (const section of THEME_SECTIONS) expect(typeof section.Section, section.name).toBe('function');
        const names = THEME_SECTIONS.map((s) => s.name);
        expect(new Set(names).size).toBe(names.length);
        const order = THEME_SECTIONS.map((s) => s.order ?? 100);
        expect(order).toEqual([...order].sort((a, b) => a - b));
    });

    it('orders by `order`, then by file name', () => {
        const sections = collectThemeSections({
            './themeSections/tokens.tsx': { default: { Section } },
            './themeSections/css.tsx': { default: late },
            './themeSections/fonts.tsx': { default: { Section, order: 20 } },
            './themeSections/assets.tsx': { default: { Section } },
        });
        expect(sections.map((s) => s.name)).toEqual(['fonts', 'assets', 'tokens', 'css']);
    });

    it('refuses a file without a Section', () => {
        expect(() => collectThemeSections({ './themeSections/broken.tsx': {} })).toThrow(/broken\.tsx/);
    });
});
