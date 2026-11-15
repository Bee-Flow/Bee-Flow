// One day of data drew a diagonal from that day's value to the far corner,
// which read as a fall. A single point is said in words; the axis is in the
// app's language ("11 Nov", not "11-11").
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SvgAreaChart, periodLabel } from './SvgAreaChart';
import { localeFormat } from '@/hooks/useLocaleFormat';

describe('SvgAreaChart', () => {
    it('one point: its value and a note, no line', () => {
        const { container } = render(<SvgAreaChart data={[{ period: '2026-11-11', total_tokens: 1200 }]} />);
        expect(screen.getByTestId('chart-single-point')).toHaveTextContent('1.2K');
        expect(screen.getByText(/One day of data in this period/)).toBeTruthy();
        expect(container.querySelector('path')).toBeNull();
    });

    it('labels the axis with locale days', () => {
        render(<SvgAreaChart data={[{ period: '2026-11-10', total_tokens: 1 }, { period: '2026-11-11', total_tokens: 2 }]} />);
        expect(screen.getByText('10 Nov')).toBeTruthy();
        expect(screen.getByText('11 Nov')).toBeTruthy();
    });

    it('names an hourly period by its hour', () => {
        expect(periodLabel('2026-11-11 14:00', localeFormat('en'))).toBe('14:00');
    });
});
