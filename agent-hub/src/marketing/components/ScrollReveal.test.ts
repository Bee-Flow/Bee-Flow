// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { REVEAL_OBSERVER_OPTIONS } from './ScrollReveal';

describe('scroll reveal observer', () => {
    it('fires before the element enters the viewport, so it is never seen as a blank gap', () => {
        const margins = REVEAL_OBSERVER_OPTIONS.rootMargin.split(' ');
        expect(margins).toHaveLength(4);
        expect(parseFloat(margins[2])).toBeGreaterThan(0);
    });
});
