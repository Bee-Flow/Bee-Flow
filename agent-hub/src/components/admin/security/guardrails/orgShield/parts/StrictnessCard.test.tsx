import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, it, expect, vi } from 'vitest';

import type { TranslateFn } from '../../../../../../hooks/useTranslation';
import StrictnessCard from './StrictnessCard';

const t: TranslateFn = (key, fallbackOrParams, paramsArg) => {
    const hasStringFallback = typeof fallbackOrParams === 'string';
    const params = hasStringFallback ? paramsArg : fallbackOrParams;
    let out = hasStringFallback ? fallbackOrParams : key;
    if (params && typeof params === 'object') {
        for (const [k, v] of Object.entries(params)) out = out.replace(`{${k}}`, String(v));
    }
    return out;
};

function setup(value: number | undefined, readOnly = false) {
    const onChange = vi.fn();
    render(<StrictnessCard value={value} onChange={onChange} readOnly={readOnly} t={t} />);
    return { onChange, group: screen.getByRole('radiogroup', { name: 'How strict should we be?' }) };
}

describe('StrictnessCard', () => {
    it('offers the three levels as one radio group, short on screen and full to a screen reader', () => {
        const { group } = setup(0.7);
        const radios = within(group).getAllByRole('radio');
        expect(radios.map(r => r.getAttribute('aria-label'))).toEqual(['Low sensitivity', 'Balanced', 'High sensitivity']);
        expect(within(group).getByText('Low')).toBeInTheDocument();
        expect(within(group).getByText('High')).toBeInTheDocument();
        expect(within(group).getByText('Recommended')).toBeInTheDocument();
        expect(screen.getByRole('radio', { name: 'Balanced' })).toBeChecked();
    });

    it('keeps each level\'s description as its tooltip', () => {
        setup(0.7);
        expect(screen.getByRole('radio', { name: 'Balanced' }))
            .toHaveAttribute('title', expect.stringMatching(/^The tested setting/));
    });

    it('writes the chosen level\'s value', async () => {
        const user = userEvent.setup();
        const { onChange } = setup(0.7);
        await user.click(screen.getByRole('radio', { name: 'High sensitivity' }));
        expect(onChange).toHaveBeenCalledWith(0.45);
        await user.click(screen.getByText('Low'));
        expect(onChange).toHaveBeenCalledWith(0.85);
    });

    it('moves between levels with the arrow keys', async () => {
        // Native radios: one tab stop and arrow keys, as a radio group should.
        const user = userEvent.setup();
        const { onChange } = setup(0.7);
        await user.tab();
        await user.tab();
        expect(screen.getByRole('radio', { name: 'Balanced' })).toHaveFocus();
        await user.keyboard('{ArrowRight}');
        expect(onChange).toHaveBeenLastCalledWith(0.45);
    });

    it('shows a custom value honestly: no level checked, the percentage, the slider open', () => {
        setup(0.5);
        for (const radio of screen.getAllByRole('radio')) expect(radio).not.toBeChecked();
        expect(screen.getByText(/Custom · 50%/)).toBeInTheDocument();
        expect(screen.getByRole('slider', { name: 'Detection sensitivity' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Hide the advanced setting' })).toHaveAttribute('aria-expanded', 'true');
    });

    it('folds the slider away once a level is chosen', async () => {
        const user = userEvent.setup();
        setup(0.5);
        await user.click(screen.getByRole('radio', { name: 'Balanced' }));
        expect(screen.queryByRole('slider')).toBeNull();
        expect(screen.getByRole('button', { name: 'Advanced: exact percentage' })).toHaveAttribute('aria-expanded', 'false');
    });

    it('opens the exact percentage on request for a preset value', async () => {
        const user = userEvent.setup();
        setup(0.7);
        expect(screen.queryByRole('slider')).toBeNull();
        expect(screen.queryByText(/Custom/)).toBeNull();
        await user.click(screen.getByRole('button', { name: 'Advanced: exact percentage' }));
        expect(screen.getByRole('slider')).toHaveValue('0.7');
    });

    it('warns about an off-scale custom value, never about a named level', () => {
        setup(0.95);
        expect(screen.getByText(/almost nothing is hidden/)).toBeInTheDocument();
    });

    it('does not scold the Low level it offers', () => {
        setup(0.85);
        expect(screen.queryByText(/almost nothing is hidden/)).toBeNull();
    });

    it('disables every level and the slider in read-only mode', () => {
        setup(0.5, true);
        for (const radio of screen.getAllByRole('radio')) expect(radio).toBeDisabled();
        expect(screen.getByRole('slider')).toBeDisabled();
    });
});
