import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import MiniBars from './MiniBars';
import { DAY_MS } from './miniBarsMath';

const NOW = new Date(2026, 8, 14, 12).getTime();
const row = (daysAgo, overall, extra = {}) => ({ captured_at: new Date(NOW - daysAgo * DAY_MS).toISOString(), overall_score: overall, ...extra });

describe('MiniBars — twelve bars, one emphasised, a signed caption', () => {
    it('renders 12 bars whose heights are the bucketed scores, the last in the tone colour, the rest on the border token', () => {
        render(<MiniBars history={[row(85, 70), row(1, 79)]} now={NOW} />);
        const bars = screen.getAllByTestId('mini-bars-bar');
        expect(bars).toHaveLength(12);
        expect(bars[0].style.height).toBe('70%');
        expect(bars[11].style.height).toBe('79%');
        expect(bars[11].style.background).toBe('var(--warning)'); // 79 → warning tone, derived from the last value
        // --border-default, not --bg-tertiary: the grey bars vanished into a dark card.
        for (const b of bars.slice(0, 11)) expect(b.style.background).toBe('var(--border-default)');
        expect(bars[5]).toHaveAttribute('data-fill', 'carried');
        expect(screen.getByTestId('mini-bars')).toHaveAttribute('data-tone', 'warning');
    });

    it('caption: "{delta} pts in {days} days" with a signed delta, or the caller’s own caption', () => {
        const { rerender } = render(<MiniBars history={[row(85, 70), row(1, 79)]} now={NOW} />);
        expect(screen.getByTestId('mini-bars-caption')).toHaveTextContent('+9 pts in 90 days');
        rerender(<MiniBars history={[row(85, 66), row(1, 58)]} now={NOW} />);
        expect(screen.getByTestId('mini-bars-caption')).toHaveTextContent('−8 pts in 90 days');
        rerender(<MiniBars history={[row(20, 40), row(1, 44)]} now={NOW} days={30} bars={6} />);
        expect(screen.getAllByTestId('mini-bars-bar')).toHaveLength(6);
        expect(screen.getByTestId('mini-bars-caption')).toHaveTextContent('+4 pts in 30 days');
        rerender(<MiniBars history={[row(1, 88)]} now={NOW} caption="ISMS since 10 Jun · 96 days" />);
        expect(screen.getByTestId('mini-bars-caption')).toHaveTextContent('ISMS since 10 Jun · 96 days');
    });

    it('an explicit tone wins over the derived one', () => {
        render(<MiniBars history={[row(1, 79)]} now={NOW} tone="success" />);
        expect(screen.getAllByTestId('mini-bars-bar')[11].style.background).toBe('var(--success)');
    });

    it('empty or absent history: twelve zero-height bars and "no trend yet" — never a crash, never "+0"', () => {
        const { rerender } = render(<MiniBars history={[]} now={NOW} />);
        const bars = screen.getAllByTestId('mini-bars-bar');
        expect(bars).toHaveLength(12);
        for (const b of bars) expect(b.style.height).toBe('0%');
        expect(screen.getByTestId('mini-bars-caption')).toHaveTextContent('90 days · no trend yet');
        expect(screen.getByTestId('mini-bars-caption')).not.toHaveTextContent('+0');
        rerender(<MiniBars now={NOW} />);
        expect(screen.getAllByTestId('mini-bars-bar')).toHaveLength(12);
        rerender(<MiniBars history="garbage" now={NOW} />);
        expect(screen.getAllByTestId('mini-bars-bar')).toHaveLength(12);
    });

    it('per framework: reads scores[frameworkId] so the AI Act card falls while the GDPR card rises', () => {
        const history = [
            { captured_at: new Date(NOW - 60 * DAY_MS).toISOString(), overall_score: 70, scores: { gdpr: 70, aia: 66 } },
            { captured_at: new Date(NOW - 1 * DAY_MS).toISOString(), overall_score: 79, scores: { gdpr: 79, aia: 58 } },
        ];
        const { rerender } = render(<MiniBars history={history} frameworkId="gdpr" now={NOW} />);
        expect(screen.getByTestId('mini-bars-caption')).toHaveTextContent('+9');
        expect(screen.getAllByTestId('mini-bars-bar')[11].style.height).toBe('79%');
        rerender(<MiniBars history={history} frameworkId="aia" now={NOW} />);
        expect(screen.getByTestId('mini-bars-caption')).toHaveTextContent('−8');
        expect(screen.getAllByTestId('mini-bars-bar')[11].style.height).toBe('58%');
        expect(screen.getAllByTestId('mini-bars-bar')[11].style.background).toBe('var(--error)');
    });
});
