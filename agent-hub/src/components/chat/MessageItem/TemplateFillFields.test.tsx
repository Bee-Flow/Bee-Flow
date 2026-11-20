import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';

import TemplateFillFields from './TemplateFillFields';
import type { TemplateFillField } from './templateFillTypes';

/**
 * The fields of a template being filled in: grouped (still needed first), one
 * control per type, and each control reports a value of the field's type.
 */

const f = (key: string, type: TemplateFillField['type'], extra: Partial<TemplateFillField> = {}): TemplateFillField =>
    ({ key, label: key.toUpperCase(), type, required: false, ...extra });

function Harness({ fields, initial = {}, onChange, issues = {} }: {
    fields: TemplateFillField[]; initial?: Record<string, unknown>; onChange: (k: string, v: unknown) => void; issues?: Record<string, string>;
}) {
    const [values, setValues] = useState(initial);
    return (
        <TemplateFillFields fields={fields} values={values} issues={issues}
            onChange={(k, v) => { onChange(k, v); setValues((prev) => ({ ...prev, [k]: v })); }} />
    );
}

describe('<TemplateFillFields>', () => {
    it('groups missing required fields first, then filled, then optional, and hides empty groups', () => {
        const fields = [f('opt', 'text'), f('done', 'text', { required: true }), f('need', 'text', { required: true })];
        const { rerender } = render(<TemplateFillFields fields={fields} values={{ done: 'x' }} issues={{}} onChange={() => {}} />);
        const ids = screen.getAllByRole('region').map((s) => s.getAttribute('data-testid'));
        expect(ids).toEqual(['template-fill-group-missing', 'template-fill-group-filled', 'template-fill-group-optional']);
        expect(within(screen.getByTestId('template-fill-group-missing')).getByLabelText(/NEED/)).toBeInTheDocument();

        rerender(<TemplateFillFields fields={fields} values={{ done: 'x', need: 'y', opt: 'z' }} issues={{}} saving onChange={() => {}} />);
        expect(screen.getByRole('status').textContent).toBe('Saving…');
    });

    it('keeps the groups of when the form opened while values change, so a field does not jump away mid-edit', () => {
        const fields = [f('done', 'text', { required: true }), f('need', 'text', { required: true })];
        const { rerender, unmount } = render(<TemplateFillFields fields={fields} values={{ done: 'x' }} issues={{}} onChange={() => {}} />);
        rerender(<TemplateFillFields fields={fields} values={{ done: 'x', need: 'y' }} issues={{}} onChange={() => {}} />);
        expect(within(screen.getByTestId('template-fill-group-missing')).getByLabelText(/NEED/)).toBeInTheDocument();
        unmount();
        render(<TemplateFillFields fields={fields} values={{ done: 'x', need: 'y' }} issues={{}} onChange={() => {}} />);
        expect(screen.getAllByRole('region').map((s) => s.getAttribute('data-testid'))).toEqual(['template-fill-group-filled']);
    });

    it('text reports on blur, number reports a number on Enter', async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        render(<Harness fields={[f('name', 'text', { example: 'Jan' }), f('amount', 'number')]} onChange={onChange} />);
        const name = screen.getByLabelText('NAME');
        expect(name).toHaveAttribute('placeholder', 'Jan');
        await user.type(name, 'Ada');
        expect(onChange).not.toHaveBeenCalled();
        await user.tab();
        expect(onChange).toHaveBeenCalledWith('name', 'Ada');
        await user.type(screen.getByLabelText('AMOUNT'), '12.5{Enter}');
        expect(onChange).toHaveBeenLastCalledWith('amount', 12.5);
    });

    it('date, choice and boolean report at once with the right types', async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        render(<Harness fields={[f('when', 'date'), f('kind', 'choice', { options: ['A', 'B'] }), f('vat', 'boolean')]} onChange={onChange} />);
        await user.type(screen.getByLabelText('WHEN'), '2026-11-20');
        expect(onChange).toHaveBeenLastCalledWith('when', '2026-11-20');
        await user.selectOptions(screen.getByLabelText('KIND'), 'B');
        expect(onChange).toHaveBeenLastCalledWith('kind', 'B');
        const sw = screen.getByRole('switch', { name: 'VAT' });
        expect(sw).toHaveAttribute('aria-checked', 'false');
        await user.click(sw);
        expect(onChange).toHaveBeenLastCalledWith('vat', true);
        // Filled in now, so it moved to the "Filled in" group (a fresh element).
        expect(screen.getByRole('switch', { name: 'VAT' })).toHaveAttribute('aria-checked', 'true');
    });

    it('a list reports the whole array after Add row and typing, and Remove drops the row', async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        const lines = f('lines', 'list', { fields: [f('item', 'text'), f('qty', 'number')] });
        render(<Harness fields={[lines]} onChange={onChange} />);
        await user.click(screen.getByRole('button', { name: 'Add row' }));
        expect(onChange).toHaveBeenLastCalledWith('lines', [{}]);
        await user.type(screen.getByLabelText('ITEM 1'), 'Pen');
        await user.type(screen.getByLabelText('QTY 1'), '3');
        expect(onChange).toHaveBeenLastCalledWith('lines', [{ item: 'Pen', qty: 3 }]);
        await user.click(screen.getByRole('button', { name: 'Remove' }));
        expect(onChange).toHaveBeenLastCalledWith('lines', []);
    });

    it('shows an issue under the field and links it with aria-describedby', () => {
        render(<TemplateFillFields fields={[f('amount', 'number', { required: true, help: 'In euros' })]} values={{}}
            issues={{ amount: 'Not a number' }} onChange={() => {}} />);
        const input = screen.getByLabelText(/AMOUNT/);
        expect(input).toHaveAttribute('aria-invalid', 'true');
        expect(input).toHaveAccessibleDescription('In euros Not a number');
        expect(screen.getByText('Not a number').className).toContain('text-[var(--error)]');
    });
});
