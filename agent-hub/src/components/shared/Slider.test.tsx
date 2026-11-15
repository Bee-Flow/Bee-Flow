import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import Slider from './Slider';
import { RANGE_INPUT } from './adminUi';

describe('Slider', () => {
    it('is the themed range input: token classes, no inline accent colour', () => {
        render(<Slider value={30} min={0} max={100} onChange={() => {}} label="Threshold" id="thr" suffix="%" />);
        const input = screen.getByRole('slider', { name: 'Threshold' });
        expect(input.className).toContain(RANGE_INPUT);
        expect(input.getAttribute('style')).toBeNull();
        expect(RANGE_INPUT).toContain('[&::-webkit-slider-thumb]:bg-[var(--text-primary)]');
        expect(RANGE_INPUT).toContain('bg-[var(--control-track-off)]');
        expect(input).toHaveAttribute('aria-valuetext', '30%');
        expect(screen.getByText('30%')).toBeInTheDocument();
    });

    it('can drop the value pill and take an aria-label when there is no visible label', () => {
        render(<Slider value={2} min={0} max={5} onChange={() => {}} ariaLabel="Rounds" showValue={false} />);
        expect(screen.getByRole('slider', { name: 'Rounds' })).toHaveValue('2');
        expect(screen.queryByText('2')).toBeNull();
    });
});
