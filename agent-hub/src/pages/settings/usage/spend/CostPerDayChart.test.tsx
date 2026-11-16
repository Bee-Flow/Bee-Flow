// Cost per day: one day of data is said in words (a line to the corner read as a
// fall), and dates are in the app's language ("11 Nov", not "Nov 11").
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CostPerDayChart } from './CostPerDayChart';

describe('CostPerDayChart', () => {
    it('one day: its cost and a note instead of a line', () => {
        const { container } = render(<CostPerDayChart timeline={[{ date: '2026-11-11', total_cost: 0.34 }]} currency="€" />);
        expect(screen.getByTestId('cost-per-day-single')).toHaveTextContent('11 Nov');
        expect(screen.getByText(/One day of data in this period/)).toBeTruthy();
        expect(container.querySelector('polyline')).toBeNull();
    });

    it('names the peak day day-first', () => {
        render(<CostPerDayChart timeline={[{ date: '2026-11-10', total_cost: 0.1 }, { date: '2026-11-11', total_cost: 0.34 }]} currency="€" />);
        expect(screen.getByText(/peak €0\.34 on 11 Nov/)).toBeTruthy();
    });
});
