import { render, screen, waitFor, within } from '@testing-library/react';
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

    it('a field the person is working in stays where it is; one that someone else fills in moves to "Filled in"', async () => {
        const user = userEvent.setup();
        const fields = [f('mine', 'text', { required: true }), f('theirs', 'text', { required: true }), f('later', 'text', { required: true })];
        const groupOf = (label: RegExp) => screen.getByLabelText(label).closest('section')?.getAttribute('data-testid');
        const { rerender } = render(<TemplateFillFields fields={fields} values={{}} issues={{}} onChange={() => {}} />);
        // The person clicks into MINE; meanwhile the assistant (or a colleague) fills in THEIRS, and then MINE too.
        await user.click(screen.getByLabelText(/MINE/));
        rerender(<TemplateFillFields fields={fields} values={{ mine: 'typed elsewhere', theirs: 'filled in' }} issues={{}} onChange={() => {}} />);
        expect(groupOf(/MINE/)).toBe('template-fill-group-missing');
        expect(groupOf(/LATER/)).toBe('template-fill-group-missing');
        // THEIRS moved to "Filled in", which is folded away while something is still needed: its count says so.
        expect(screen.queryByLabelText(/THEIRS/)).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Filled in \(1\)/ })).toBeInTheDocument();
    });

    it('leaving the fields with a click regroups them only after the click has landed, so the button clicked does not move away', async () => {
        const user = userEvent.setup();
        const fields = [f('mine', 'text', { required: true }), f('later', 'text', { required: true })];
        const onClick = vi.fn();
        render(
            <>
                <Harness fields={fields} onChange={() => {}} />
                <button type="button" onClick={onClick}>Below the fields</button>
            </>,
        );
        const missing = () => within(screen.getByTestId('template-fill-group-missing'));
        await user.type(screen.getByLabelText(/MINE/), 'filled in');
        const below = screen.getByRole('button', { name: 'Below the fields' });
        // Pressed, not let go yet: the typed value is committed (blur), and nothing has moved.
        await user.pointer({ keys: '[MouseLeft>]', target: below });
        expect(missing().getByLabelText(/MINE/)).toHaveValue('filled in');
        await user.pointer({ keys: '[/MouseLeft]', target: below });
        expect(onClick).toHaveBeenCalledTimes(1);
        // The click landed: now the field joins the filled-in ones.
        await waitFor(() => expect(missing().queryByLabelText(/MINE/)).not.toBeInTheDocument());
        expect(missing().getByLabelText(/LATER/)).toBeInTheDocument();
    });

    it('leaving the fields with the keyboard regroups them at once', async () => {
        const user = userEvent.setup();
        const fields = [f('mine', 'text', { required: true }), f('later', 'text', { required: true })];
        render(
            <>
                <Harness fields={fields} onChange={() => {}} />
                <button type="button">Below the fields</button>
            </>,
        );
        await user.type(screen.getByLabelText(/MINE/), 'filled in');
        await user.tab();
        // Still inside the fields: MINE stays where the person left it.
        expect(within(screen.getByTestId('template-fill-group-missing')).getByLabelText(/MINE/)).toBeInTheDocument();
        await user.tab();
        expect(screen.getByRole('button', { name: 'Below the fields' })).toHaveFocus();
        expect(within(screen.getByTestId('template-fill-group-missing')).queryByLabelText(/MINE/)).not.toBeInTheDocument();
    });

    it('what a colleague asked for comes first, then what the final check remarked on, and what belongs to a field shows under it', () => {
        const fields = [f('plain', 'text', { required: true }), f('asked', 'text'), f('checked', 'text')];
        render(<TemplateFillFields fields={fields} values={{ checked: 'tbd' }} issues={{}} onChange={() => {}}
            asked={new Set(['asked'])} remarked={new Set(['checked'])}
            adornments={(field) => (field.key === 'checked' ? { below: <p>Is this right?</p>, actions: <button type="button">Note</button> } : null)} />);
        expect(screen.getAllByRole('region').map((s) => s.getAttribute('data-testid')))
            .toEqual(['template-fill-group-asked', 'template-fill-group-remarked', 'template-fill-group-missing']);
        expect(within(screen.getByTestId('template-fill-group-asked')).getByLabelText('ASKED')).toBeInTheDocument();
        expect(within(screen.getByTestId('template-fill-field-checked')).getByText('Is this right?')).toBeInTheDocument();
        expect(within(screen.getByTestId('template-fill-field-checked')).getByRole('button', { name: 'Note' })).toBeInTheDocument();
        expect(within(screen.getByTestId('template-fill-field-asked')).queryByRole('button')).not.toBeInTheDocument();
        expect(screen.getByRole('heading', { name: 'Asked of you (1)' })).toBeInTheDocument();
    });

    it('once nothing is left to do, "Filled in" opens by itself', () => {
        const fields = [f('a', 'text', { required: true }), f('b', 'text')];
        const { rerender } = render(<TemplateFillFields fields={fields} values={{ b: 'x' }} issues={{}} onChange={() => {}} />);
        expect(screen.queryByLabelText('B')).not.toBeInTheDocument();
        rerender(<TemplateFillFields fields={fields} values={{ a: 'y', b: 'x' }} issues={{}} onChange={() => {}} />);
        expect(screen.getByLabelText('B')).toBeInTheDocument();
        expect(screen.getByLabelText(/^A/)).toBeInTheDocument();
    });

    it('a text is one box however long it gets: typing past a line never moves the cursor out of it', async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        render(<Harness fields={[f('scope', 'text')]} onChange={onChange} />);
        const box = screen.getByLabelText('SCOPE');
        const long = 'We set up the workspace and train twelve people, and we stay on call for the first month after delivery.';
        await user.type(box, long);
        expect(screen.getByLabelText('SCOPE')).toBe(box);
        expect(box).toHaveFocus();
        // Shift+Enter is a new line in the text; Enter alone is "done with this field".
        await user.keyboard('{Shift>}{Enter}{/Shift}Second line');
        expect(onChange).not.toHaveBeenCalled();
        await user.keyboard('{Enter}');
        expect(onChange).toHaveBeenCalledWith('scope', `${long}\nSecond line`);
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

    it('offers the template default as a suggestion, filled in only when accepted', async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        render(<Harness fields={[f('authority', 'text', { required: true, suggestion: 'Data protection authority' })]} onChange={onChange} />);
        const offer = screen.getByTestId('template-fill-suggestion-authority');
        expect(offer.textContent).toContain('Data protection authority');
        await user.click(within(offer).getByRole('button', { name: 'Accept' }));
        expect(onChange).toHaveBeenCalledWith('authority', 'Data protection authority');
        expect(screen.queryByTestId('template-fill-suggestion-authority')).not.toBeInTheDocument();
    });

    it('keeps the long instructions behind the "i" and the short help in view', async () => {
        const user = userEvent.setup();
        render(<Harness fields={[f('name', 'text', { help: 'The legal name.', details: 'Use the name from the trade register, without a full stop.' })]} onChange={() => {}} />);
        expect(screen.getByText('The legal name.')).toBeInTheDocument();
        expect(screen.queryByText(/trade register/)).not.toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'More about this field' }));
        expect(screen.getByText(/trade register/)).toBeInTheDocument();
    });

    it('folds what is filled in away while something is still needed, and marks required with a star', async () => {
        const user = userEvent.setup();
        render(<Harness fields={[f('done', 'text', { required: true }), f('need', 'text', { required: true })]} initial={{ done: 'x' }} onChange={() => {}} />);
        expect(screen.queryByLabelText(/DONE/)).not.toBeInTheDocument();
        expect(screen.getByLabelText(/NEED/)).toBeInTheDocument();
        expect(screen.getByText('*')).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: /Filled in \(1\)/ }));
        expect(screen.getByLabelText(/DONE/)).toBeInTheDocument();
    });
});
