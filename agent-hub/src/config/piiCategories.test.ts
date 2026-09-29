/**
 * The Privacy Shield / consumer picker reads this single canonical list, so a
 * drift here silently hides or invents category toggles. BFSF-269 touched the
 * detector coverage; these tests pin the list the UI advertises.
 */
import { describe, it, expect } from 'vitest';
import {
    PII_CATEGORIES, piiCategoriesLocalized, piiCategoryById,
    colorTokenForCategory, PII_GROUP_COLOR_TOKEN, PII_OTHER_COLOR_TOKEN,
} from './piiCategories';

describe('PII_CATEGORIES', () => {
    it('exposes exactly 21 categories', () => {
        // Kept in lock-step with guard-service GLINER_LABELS_TO_CATEGORY +
        // the regex tier. Update both sides together if this changes.
        expect(PII_CATEGORIES).toHaveLength(21);
    });

    it('has unique ids and complete structure for every entry', () => {
        const ids = PII_CATEGORIES.map(c => c.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const c of PII_CATEGORIES) {
            expect(c.id).toBeTruthy();
            expect(c.group).toBeTruthy();
            expect(c.icon).toBeTruthy();
            expect(c.i18nKey).toBeTruthy();
        }
    });

    it('gives every category a renderable lucide icon', () => {
        // A missing `Icon` renders as a hole in every picker (the grid falls
        // back to the emoji, so it fails quietly rather than loudly).
        // Deliberately NOT `typeof === 'function'`: lucide icons are forwardRef
        // objects, so that assertion would fail for the wrong reason.
        for (const c of PII_CATEGORIES) {
            expect(c.Icon, `${c.id} has no Icon`).toBeTruthy();
        }
    });

    it('gives each category a distinct icon', () => {
        // The emoji set had real collisions — 🆔 stood for both the US SSN and
        // the national ID, 🌐 for both IBAN and IP address — so two different
        // categories were visually identical in a 21-row grid.
        const icons = PII_CATEGORIES.map(c => c.Icon);
        expect(new Set(icons).size).toBe(icons.length);
    });

    it('includes the core BFSF-269 categories', () => {
        const ids = new Set(PII_CATEGORIES.map(c => c.id));
        for (const id of ['Person', 'DateOfBirth', 'Address', 'Organization']) {
            expect(ids.has(id)).toBe(true);
        }
    });
});

describe('colorTokenForCategory / piiCategoryById', () => {
    it('every one of the 7 groups has a color token, and every category resolves to it', () => {
        for (const c of PII_CATEGORIES) {
            expect(PII_GROUP_COLOR_TOKEN[c.group]).toBeTruthy();
            expect(colorTokenForCategory(c.id)).toBe(PII_GROUP_COLOR_TOKEN[c.group]);
        }
    });

    it('categories in the same group share the same token (21 categories, 7 colors)', () => {
        const tokens = new Set(PII_CATEGORIES.map(c => colorTokenForCategory(c.id)));
        expect(tokens.size).toBe(new Set(PII_CATEGORIES.map(c => c.group)).size);
    });

    it('a category not in the catalog (manual mark, custom term) falls back to the "other" slot', () => {
        expect(colorTokenForCategory('UserMarked')).toBe(PII_OTHER_COLOR_TOKEN);
        expect(colorTokenForCategory('SomeCustomTermLabel')).toBe(PII_OTHER_COLOR_TOKEN);
        expect(piiCategoryById('UserMarked')).toBeNull();
    });

    it('piiCategoryById finds a known category by its stable id', () => {
        expect(piiCategoryById('Person')?.group).toBe('Personal');
    });
});

describe('piiCategoriesLocalized', () => {
    it('resolves labels via the i18n function, falling back when missing', () => {
        const t = (key: string, fallback?: string) => fallback ?? key;
        const localized = piiCategoriesLocalized(t);
        expect(localized).toHaveLength(21);
        for (const c of localized) {
            expect(typeof c.label).toBe('string');
            expect(c.label.length).toBeGreaterThan(0);
        }
    });
});
