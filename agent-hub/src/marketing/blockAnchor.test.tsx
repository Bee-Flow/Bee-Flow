import { describe, expect, it } from 'vitest';
import { blockWrapStyle } from './ProductWebsite';

describe('block anchor', () => {
    it('keeps an anchored block clear of the sticky header', () => {
        expect(blockWrapStyle({ anchor: 'install' })?.scrollMarginTop).toBe('5rem');
    });

    it('adds nothing for a missing or illegal anchor', () => {
        expect(blockWrapStyle({ anchor: 'not a slug' })).toBeUndefined();
        expect(blockWrapStyle({})).toBeUndefined();
    });
});
