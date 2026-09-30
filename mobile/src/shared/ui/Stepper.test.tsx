import { fireEvent, screen } from '@testing-library/react-native';
import React from 'react';

import { renderWithProviders } from '@/shared/testing/renderWithProviders';

import { Stepper, stepValue } from './Stepper';

describe('stepValue', () => {
    it('steps on the grid and clamps to the bounds', () => {
        expect(stepValue(300, 60, { min: 60, max: 3600, step: 60 })).toBe(360);
        expect(stepValue(60, -60, { min: 60, max: 3600, step: 60 })).toBe(60);
        expect(stepValue(3590, 60, { min: 60, max: 3600, step: 60 })).toBe(3600);
        expect(stepValue(0.7, 0.05, { min: 0, max: 1, step: 0.05 })).toBe(0.75);
    });
});

describe('Stepper', () => {
    it('raises and lowers the value, and stops at a bound', async () => {
        const onChange = jest.fn();
        await renderWithProviders(<Stepper label="Budget" value={50} min={10} max={50} step={5} onChange={onChange} format={(v) => `${v}%`} />);
        expect(screen.getByText('50%')).toBeTruthy();
        await fireEvent.press(screen.getByLabelText('Less'));
        expect(onChange).toHaveBeenCalledWith(45);
        expect(screen.getByLabelText('More')).toBeDisabled();
    });
});
