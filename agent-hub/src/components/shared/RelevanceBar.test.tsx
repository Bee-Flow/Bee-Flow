import { render, screen } from '@testing-library/react';
import React from 'react';
import { describe, it, expect } from 'vitest';
import RelevanceBar, { relativeWidth } from './RelevanceBar';

/**
 * Both citation surfaces used to render `Math.round(score * 100) + '%'`, and
 * that number is not a percentage of anything. With no reranker configured the
 * score is an RRF fusion score — about 0.016 for a good hit, being a sum of
 * 1/(60+rank) terms — so the BEST passage in a document showed "2%", and a bar
 * that coloured on absolute thresholds was grey for everything in the product.
 *
 * A person reading "2%" concludes the knowledge base is broken. A person
 * reading "68%" concludes it is a confidence, and asks for a threshold built
 * on it. Neither conclusion is available from the number.
 */

describe('relativeWidth', () => {
    it('scales against the best hit in the SAME answer, not against 1', () => {
        // The RRF case: 0.0164 is an excellent hit, and it must draw full.
        expect(relativeWidth(0.0164, 0.0164)).toBe(1);
        expect(relativeWidth(0.0082, 0.0164)).toBeCloseTo(0.5);
    });

    it('keeps the weakest hit visible rather than drawing an empty rail', () => {
        expect(relativeWidth(0.0001, 0.9)).toBeGreaterThan(0);
    });

    it('never exceeds full, even if a score somehow beats the best', () => {
        expect(relativeWidth(2, 1)).toBe(1);
    });

    it('draws nothing when there is nothing to compare', () => {
        for (const [s, b] of [[0, 0], [0.5, 0], [null, 1], [undefined, 1], [NaN, 1], [-1, 1], [1, NaN]]) {
            expect(relativeWidth(s, b)).toBe(0);
        }
    });
});

describe('RelevanceBar', () => {
    it('renders a bar, and no number anywhere in it', () => {
        const { container } = render(<RelevanceBar score={0.0082} best={0.0164} />);
        expect(screen.getByTestId('relevance-bar')).toBeTruthy();
        expect(container.textContent).toBe('');
    });

    it('renders nothing at all when there is no comparison to draw', () => {
        const { container } = render(<RelevanceBar score={0} best={0} />);
        expect(container.firstChild).toBeNull();
    });

    it('is decorative, so a screen reader is not read a meaningless ratio', () => {
        render(<RelevanceBar score={1} best={1} />);
        expect(screen.getByTestId('relevance-bar').getAttribute('aria-hidden')).toBe('true');
    });
});
