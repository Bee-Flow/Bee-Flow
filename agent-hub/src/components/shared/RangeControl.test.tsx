import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import RangeControl, { defaultRange } from './RangeControl';
import LegacyRangeControl, { defaultRange as legacyDefaultRange } from '@/pages/settings/usage/RangeControl';

describe('RangeControl', () => {
    it('marks the chosen preset and switches to another', async () => {
        const onChange = vi.fn();
        const range = defaultRange('7d');
        render(<RangeControl range={range} onChange={onChange} />);
        const active = screen.getByRole('button', { name: '7d' });
        expect(active).toHaveAttribute('aria-pressed', 'true');
        expect(active.className).toContain('text-[var(--text-primary)]');
        expect(active.className).not.toMatch(/#|text-white|accent-primary/);
        await userEvent.click(screen.getByRole('button', { name: '30d' }));
        expect(onChange).toHaveBeenCalledWith({ ...range, preset: '30d' });
    });

    it('shows only the presets asked for', () => {
        render(<RangeControl range={defaultRange()} onChange={() => {}} presets={['7d', '90d']} />);
        expect(screen.getAllByRole('button').map(b => b.textContent)).toEqual(['7d', '90d']);
    });

    it('edits a custom range through two labelled date inputs', async () => {
        const onChange = vi.fn();
        const range = { preset: 'custom', customStart: '2026-01-01T00:00', customEnd: '2026-01-31T00:00' };
        render(<RangeControl range={range} onChange={onChange} />);
        expect(screen.getByLabelText('From')).toHaveValue('2026-01-01T00:00');
        expect(screen.getByLabelText('To')).toHaveValue('2026-01-31T00:00');
    });

    it('seeds the custom pickers with the last 30 days, as datetime-local values', () => {
        const r = defaultRange();
        expect(r.preset).toBe('30d');
        expect(r.customStart).toMatch(/^\d{4}-\d{2}-\d{2}T00:00$/);
        expect(r.customEnd).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    });

    it('is still served from its old path', () => {
        expect(LegacyRangeControl).toBe(RangeControl);
        expect(legacyDefaultRange).toBe(defaultRange);
    });
});
