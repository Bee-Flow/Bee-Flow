/**
 * The stacked column chart: draws in jsdom, one segment per non-zero value,
 * a legend for every series, the numbers as text for a screen reader, the
 * incomplete period faded, and never a purple/violet/indigo hue.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import StackedColumnChart from './StackedColumnChart';

const FORBIDDEN = [/#6366f1/i, /#4f46e5/i, /#818cf8/i, /#7c3aed/i, /#a855f7/i, /indigo/i, /violet/i, /purple/i];

const SERIES = [
    { key: 'agents', label: 'Agents', color: 'var(--chart-1)' },
    { key: 'chat', label: 'Direct chat', color: 'var(--chart-2)' },
    { key: 'other', label: 'Other', color: 'var(--text-tertiary)' },
];

const DATA = [
    { x: '2026-W43', label: 'W43', values: { agents: 60, chat: 30, other: 5 } },
    { x: '2026-W44', label: 'W44', values: { agents: 50, chat: 0, other: 2 } },
    { x: '2026-W45', label: 'W45', values: { agents: 20, chat: 10, other: 0 }, faded: true },
];

describe('StackedColumnChart', () => {
    it('draws one segment per non-zero value, on the series colours, with a surface-coloured gap', () => {
        const { container } = render(<StackedColumnChart data={DATA} series={SERIES} ariaLabel="AI spend per week" />);
        expect(container.querySelector('svg.recharts-surface')).not.toBeNull();
        const paths = Array.from(container.querySelectorAll('.recharts-bar-rectangle path'));
        expect(paths.length).toBe(7);
        expect(paths.every(p => p.getAttribute('stroke') === 'var(--bg-secondary)')).toBe(true);
        expect(paths.every(p => p.getAttribute('stroke-width') === '2')).toBe(true);
        expect(paths.some(p => p.getAttribute('fill') === 'var(--chart-1)')).toBe(true);
        for (const re of FORBIDDEN) expect(container.innerHTML).not.toMatch(re);
    });

    it('fades the incomplete period only', () => {
        const { container } = render(<StackedColumnChart data={DATA} series={SERIES} ariaLabel="AI spend per week" />);
        const opacities = Array.from(container.querySelectorAll('.recharts-bar-rectangle path')).map(p => p.getAttribute('fill-opacity'));
        expect(opacities.filter(o => o === '0.45').length).toBe(2);
        expect(opacities.filter(o => o === '1').length).toBe(5);
    });

    it('is an image with a label, a legend for every series and the numbers as text', () => {
        const { container } = render(
            <StackedColumnChart data={DATA} series={SERIES} ariaLabel="AI spend per week" valueFormatter={(n) => `€ ${n}`} />,
        );
        expect(screen.getByRole('img', { name: 'AI spend per week' })).toBeTruthy();
        const legend = Array.from(container.querySelectorAll('ul[aria-hidden="true"] li')).map(li => li.textContent);
        expect(legend).toEqual(['Agents', 'Direct chat', 'Other']);
        const sr = Array.from(container.querySelectorAll('ul.sr-only li')).map(li => li.textContent);
        expect(sr[0]).toBe('W43: € 95 (Agents € 60, Direct chat € 30, Other € 5)');
        expect(sr[1]).toBe('W44: € 52 (Agents € 50, Other € 2)');
    });

    it('renders an empty frame without throwing when there is no data', () => {
        const { container } = render(<StackedColumnChart data={[]} series={SERIES} ariaLabel="Empty" />);
        expect(container.querySelectorAll('.recharts-bar-rectangle').length).toBe(0);
    });
});
