import { render, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import ConditionField from './ConditionField';

const NODE = { id: 'cmp_in', type: 'input_number', props: { name: 'quantity' } };

/** A definition where cmp_in sits inside a form, so the scope has form fields. */
const DEF_WITH_FORM = {
    schemaVersion: 2,
    meta: { name: 'T' },
    screens: [{
        id: 'scr_a',
        name: 'Order',
        sections: [{
            id: 'sec_a',
            children: [{
                id: 'cmp_form',
                type: 'form',
                children: [NODE, { id: 'cmp_note', type: 'input_text', props: { name: 'note' } }],
            }],
        }],
    }],
};

describe('ConditionField — round-trip', () => {
    // The left-hand side used to be a raw reference editor: an author had to
    // know the condition is spelled `form.quantity`. It is now a field picker
    // showing names, with the path stored invisibly — so the assertion is what
    // the row SAYS, not what a hidden editor holds.
    it('shows the parsed field by name', () => {
        const { getByRole } = render(
            <ConditionField value="form.quantity > 0" onChange={() => {}} definition={null} node={NODE} />,
        );
        expect(getByRole('button', { name: /quantity/i })).toBeTruthy();
    });

    it('re-serializes to an expression string when the operator changes', async () => {
        const onChange = vi.fn();
        const { getAllByRole } = render(
            <ConditionField value="form.quantity > 0" onChange={onChange} definition={null} node={NODE} />,
        );
        // The operator is the row's own select; the field slot is a button now.
        // App Studio shares the Condition node's menus: "is not" is `!equals()`,
        // which the shared engine both runs evaluate the same way.
        await userEvent.setup().selectOptions(getAllByRole('combobox')[0], 'isNot');
        expect(onChange).toHaveBeenCalled();
        const emitted = onChange.mock.calls.at(-1)[0];
        expect(typeof emitted).toBe('string');
        expect(emitted).toBe('!equals(form.quantity, 0)');
    });

    it('keeps a saved `!=` rule exactly as it was (old rules keep their meaning)', () => {
        const onChange = vi.fn();
        const { getAllByRole } = render(
            <ConditionField value='form.note != "x"' onChange={onChange} definition={null} node={NODE} />,
        );
        // The legacy exact-case operator stays on that row's menu, named as such,
        // and opening the rule never rewrites it.
        const select = getAllByRole('combobox')[0];
        expect(select.value).toBe('neq');
        expect(select.selectedOptions[0].textContent).toMatch(/exactly/);
        expect(onChange).not.toHaveBeenCalled();
    });

    it('offers the fields that actually exist in the app’s scope', () => {
        const { getByRole, baseElement } = render(
            <ConditionField value="form.quantity > 0" onChange={() => {}} definition={DEF_WITH_FORM} node={NODE} />,
        );
        fireEvent.click(getByRole('button', { name: /quantity/i }));

        // The enclosing form's other input, and the current user, are both
        // pickable — that is the whole point of feeding it the Studio scope.
        const list = within(baseElement);
        expect(list.getByText('Note')).toBeTruthy();
        expect(list.getByText('Email')).toBeTruthy();
    });

    it('picking a field rewrites the expression against that path', () => {
        const onChange = vi.fn();
        const { getByRole, baseElement } = render(
            <ConditionField value="form.quantity > 0" onChange={onChange} definition={DEF_WITH_FORM} node={NODE} />,
        );
        fireEvent.click(getByRole('button', { name: /quantity/i }));
        // The option commits on mouseDown, so the search box cannot blur the
        // list shut before the pick lands.
        fireEvent.mouseDown(within(baseElement).getByText('Note'));

        const emitted = onChange.mock.calls.at(-1)[0];
        expect(emitted).toContain('form.note');
    });

    it('an option can also be chosen from the keyboard', () => {
        const onChange = vi.fn();
        const { getByRole, baseElement } = render(
            <ConditionField value="form.quantity > 0" onChange={onChange} definition={DEF_WITH_FORM} node={NODE} />,
        );
        fireEvent.click(getByRole('button', { name: /quantity/i }));
        fireEvent.keyDown(within(baseElement).getByText('Note'), { key: 'Enter' });

        expect(onChange.mock.calls.at(-1)[0]).toContain('form.note');
    });
});
