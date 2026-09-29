// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { SUITE_MIN_APPS, OTHER_CATEGORY, isSuite } from './appsRibbonLayout';

const app = (id) => ({ id, label: id, shortLabel: id, integrationId: id, actions: [] });
const group = (category, n) => ({ category, apps: Array.from({ length: n }, (_, i) => app(`${category.toLowerCase()}-${i}`)) });

describe('appsRibbonLayout', () => {
    it('a category is a suite (one pill of its own) at SUITE_MIN_APPS apps', () => {
        expect(SUITE_MIN_APPS).toBe(3);
        expect(isSuite(group('Google Workspace', 3))).toBe(true);
        expect(isSuite(group('Social', 2))).toBe(false);
        expect(isSuite(null)).toBe(false);
    });

    it('"Other" is a catch-all, not a vendor: never a suite, however many apps it holds', () => {
        expect(OTHER_CATEGORY).toBe('Other');
        expect(isSuite(group('Other', 9))).toBe(false);
    });
});
