/**
 * The shared chart kit: draws in jsdom (explicit width), carries every number
 * as text, and never emits a purple/violet/indigo hue.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import BarList from './BarList';
import { CHART_SERIES, chartSeriesVar } from './chartChrome';
import SplitBar from './SplitBar';
import TokenBarChart from './TokenBarChart';

const FORBIDDEN = [/#6366f1/i, /#4f46e5/i, /#818cf8/i, /#7c3aed/i, /#a855f7/i, /indigo/i, /violet/i, /purple/i];

describe('TokenBarChart', () => {
    it('renders a recharts surface with bars and lists the numbers for a screen reader', () => {
        const { container } = render(
            <TokenBarChart data={[{ x: '2026-09-01', n: 4 }, { x: '2026-09-02', n: 1 }]} ariaLabel="Responses over time" xTickFormatter={(x) => x.slice(5)} />,
        );
        expect(container.querySelector('svg.recharts-surface')).not.toBeNull();
        expect(container.querySelectorAll('.recharts-bar-rectangle').length).toBe(2);
        expect(screen.getByRole('img', { name: 'Responses over time' })).toBeTruthy();
        const items = Array.from(container.querySelectorAll('ul.sr-only li')).map(li => li.textContent);
        expect(items).toEqual(['09-01: 4', '09-02: 1']);
        for (const re of FORBIDDEN) expect(container.innerHTML).not.toMatch(re);
    });
});

describe('BarList', () => {
    it('shows label, count and share per row, and folds the tail behind a button', () => {
        const rows = Array.from({ length: 10 }, (_, i) => ({ label: `Option ${i}`, n: 10 - i, pct: 10 - i }));
        const { container } = render(<BarList rows={rows} maxRows={8} ariaLabel="How did you hear about us?" moreLabel={(n) => `${n} more`} />);
        expect(screen.getAllByRole('listitem').length).toBe(8);
        expect(screen.getByText('Option 0')).toBeTruthy();
        expect(screen.getByText('10%')).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: '2 more' }));
        expect(screen.getAllByRole('listitem').length).toBe(10);
        for (const re of FORBIDDEN) expect(container.innerHTML).not.toMatch(re);
    });
});

describe('SplitBar', () => {
    it('legends every segment with its count and percentage', () => {
        render(<SplitBar segments={[{ label: 'Yes', n: 61 }, { label: 'No', n: 25 }]} ariaLabel="Subscribe to updates?" />);
        const items = screen.getAllByRole('listitem').map(li => li.textContent);
        expect(items[0]).toContain('Yes');
        expect(items[0]).toContain('61');
        expect(items[0]).toContain('(70.9%)');
        expect(items[1]).toContain('(29.1%)');
    });
});

describe('chartChrome', () => {
    it('has eight token slots and wraps', () => {
        expect(CHART_SERIES.length).toBe(8);
        expect(chartSeriesVar(0)).toBe('var(--chart-1)');
        expect(chartSeriesVar(8)).toBe('var(--chart-1)');
        expect(chartSeriesVar(-1)).toBe('var(--chart-8)');
    });
});
