import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import NavCountBadge, { badgeCount } from './NavCountBadge';

/**
 * The badge exists to answer one question — "is there anything here worth
 * opening?" — so the interesting half of it is everything it does NOT draw.
 * `undefined` (the endpoint has not answered, or withheld the key) and `0`
 * (nothing to do) are two different facts about the world that produce the
 * same pixels: none. Anything else would put a permanent "0" on a nav row, or
 * invent a number while the count is still unknown.
 */
describe('NavCountBadge — what it refuses to render', () => {
    it.each([
        ['undefined', undefined],
        ['null', null],
        ['zero', 0],
        ['a negative count', -3],
        ['NaN', Number.NaN],
        ['Infinity', Number.POSITIVE_INFINITY],
        ['an empty string', ''],
        ['a non-numeric string', 'lots'],
        ['a boolean', true],
        ['an object', { n: 4 }],
    ])('renders nothing for %s', (_label, count) => {
        const { container } = render(<NavCountBadge count={count} />);
        expect(container.innerHTML).toBe('');
    });

    it('draws the number the moment there is one to act on', () => {
        render(<NavCountBadge count={1} />);
        expect(screen.getByTestId('nav-count-badge')).toHaveTextContent('1');
    });

    it('badgeCount is the whole rule, and it floors rather than rounds', () => {
        expect(badgeCount(undefined)).toBeNull();
        expect(badgeCount(0)).toBeNull();
        expect(badgeCount(3)).toBe(3);
        // A count arriving as a string ('7' from a header or a query param)
        // still counts; 0.9 is not "1 open".
        expect(badgeCount('7')).toBe(7);
        expect(badgeCount(0.9)).toBeNull();
        expect(badgeCount(3.7)).toBe(3);
    });
});

describe('NavCountBadge — how it looks when it does render', () => {
    it('takes its colours from the status tokens, never a hex', () => {
        render(<NavCountBadge count={3} tone="warning" />);
        const el = screen.getByTestId('nav-count-badge');
        expect(el.dataset.tone).toBe('warning');
        expect(el.style.borderColor).toBe('var(--warning)');
        expect(el.style.color).toBe('var(--warning-ink)');
        expect(el.getAttribute('style')).not.toMatch(/#[0-9a-f]{3,8}/i);
    });

    it('defaults to the neutral tone and falls back to it for an unknown one', () => {
        const { rerender } = render(<NavCountBadge count={3} />);
        let el = screen.getByTestId('nav-count-badge');
        expect(el.dataset.tone).toBe('neutral');
        expect(el.style.borderColor).toBe('var(--border-default)');
        expect(el.style.color).toBe('var(--text-tertiary)');

        rerender(<NavCountBadge count={3} tone="chartreuse" />);
        el = screen.getByTestId('nav-count-badge');
        expect(el.dataset.tone).toBe('neutral');
        expect(el.style.borderColor).toBe('var(--border-default)');
    });

    it('carries the 10px/600 tabular-nums pill classes the nav rows are drawn with', () => {
        render(<NavCountBadge count={3} className="ml-2" />);
        const el = screen.getByTestId('nav-count-badge');
        for (const cls of ['rounded-full', 'px-1.5', 'text-[10px]', 'font-semibold', 'tabular-nums', 'ml-2']) {
            expect(el.className).toContain(cls);
        }
    });

    it('caps a runaway count instead of widening the row', () => {
        const { rerender } = render(<NavCountBadge count={99} />);
        expect(screen.getByTestId('nav-count-badge')).toHaveTextContent('99');
        rerender(<NavCountBadge count={412} />);
        expect(screen.getByTestId('nav-count-badge')).toHaveTextContent('99+');
        rerender(<NavCountBadge count={412} max={999} />);
        expect(screen.getByTestId('nav-count-badge')).toHaveTextContent('412');
    });

    it('answers to its own test id so two badges on one screen stay apart', () => {
        render(<NavCountBadge count={3} testId="nav-compliance-count" />);
        expect(screen.getByTestId('nav-compliance-count')).toHaveTextContent('3');
    });
});
