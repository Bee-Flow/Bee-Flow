import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { StepField } from './StepField';
import type { StepFieldProps } from '../StepSettings.types';

/**
 * An AI step in a sequence (spec-driven step settings): the schema v3 reliability fields get a
 * control from their type, and a blank one writes no value at all (never a stored null).
 */

function renderField(fieldKey: string, fs: StepFieldProps['fs'], value: unknown) {
    const onChange = vi.fn();
    const props = {
        fieldKey, fs, value, onChange,
        step: { kind: 'ai_generate' }, definition: { schemaVersion: 2, screens: [], actions: {} }, node: null,
        options: {}, references: {} as StepFieldProps['references'], formFields: [], disabled: false,
    } as StepFieldProps;
    render(<StepField {...props} />);
    return onChange;
}

describe('StepField — AI step reliability', () => {
    it('temperature is a decimal input; blank writes nothing', async () => {
        const user = userEvent.setup();
        const onChange = renderField('temperature', { type: 'number', min: 0, max: 2, since: 3 }, 0.5);
        const input = screen.getByRole('spinbutton', { name: 'Temperature' });
        expect(input.getAttribute('step')).toBe('0.1');
        await user.clear(input);
        expect(onChange).toHaveBeenLastCalledWith(undefined);
        expect(screen.getByText(/Lower answers vary less between runs/)).toBeTruthy();
    });

    it('repairRounds left blank is no field (a v3 int), while an older int keeps writing null', async () => {
        const user = userEvent.setup();
        const rounds = renderField('repairRounds', { type: 'int', min: 0, max: 3, since: 3 }, 2);
        await user.clear(screen.getByRole('spinbutton', { name: 'Repair rounds' }));
        expect(rounds).toHaveBeenLastCalledWith(undefined);
    });

    it('checks get the checks editor, not a text box', async () => {
        const user = userEvent.setup();
        const onChange = renderField('checks', { type: 'aiChecks', since: 3 }, undefined);
        await user.click(screen.getByRole('button', { name: 'Add a check' }));
        expect(onChange).toHaveBeenLastCalledWith([{ kind: 'allowedFrom', field: '' }]);
    });
});

describe('StepField — an int without since', () => {
    it('still writes null when cleared', async () => {
        const user = userEvent.setup();
        const onChange = renderField('maxIterations', { type: 'int', min: 1, max: 10 }, 3);
        await user.clear(screen.getByRole('spinbutton', { name: 'Max iterations' }));
        expect(onChange).toHaveBeenLastCalledWith(null);
    });
});
