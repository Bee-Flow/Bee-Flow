import { describe, it, expect } from 'vitest';
import { THEME_SECTIONS, collectThemeSections } from './themeSections';
import type { ThemeSectionEntry, ThemeSectionProps } from './themeSections';

const Section = (_props: ThemeSectionProps) => null;
const late: ThemeSectionEntry = { Section, order: 200 };

describe('theme panel sections added as files', () => {
    it('ships empty: the panel is exactly its own sections', () => {
        expect(THEME_SECTIONS).toEqual([]);
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
