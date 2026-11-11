import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import ConditionField from './ConditionField';
import { inputValueOptions } from './inputValueOptions';

// A row whose left side is a radio (or select) input with fixed options offers those values on
// the right; any other field keeps the text box.
const RADIO = { id: 'cmp_rad', type: 'radio', props: { name: 'status', label: 'Status', options: [{ value: 'open', label: 'Open' }, { value: 'done', label: 'Done' }] } };
const TEXT = { id: 'cmp_txt', type: 'input_text', props: { name: 'note' } };
const DEF = {
    schemaVersion: 3,
    meta: { name: 'T' },
    screens: [{ id: 'scr_a', name: 'A', sections: [{ id: 'sec_a', children: [{ id: 'cmp_form', type: 'form', children: [RADIO, TEXT] }] }] }],
};

describe('ConditionField with radio option values', () => {
    it('collects the literal options of radio and select inputs by their form path', () => {
        expect(inputValueOptions(DEF).get('form.status')).toEqual([{ value: 'open', label: 'Open' }, { value: 'done', label: 'Done' }]);
        expect(inputValueOptions(DEF).has('form.note')).toBe(false);
    });

    it('offers the radio values on the right of an "is" row and writes the picked one', async () => {
        const onChange = vi.fn();
        render(<ConditionField value={'equals(form.status, "open")'} onChange={onChange} definition={DEF as never} node={TEXT as never} />);
        const choice = screen.getByRole('option', { name: 'Done' }).closest('select') as HTMLSelectElement;
        expect(choice.value).toBe('open');
        await userEvent.setup().selectOptions(choice, 'done');
        expect(onChange.mock.calls.at(-1)?.[0]).toBe('equals(form.status, "done")');
    });

    it('keeps the text box for a field without fixed values', () => {
        render(<ConditionField value={'equals(form.note, "x")'} onChange={() => {}} definition={DEF as never} node={TEXT as never} />);
        expect(screen.queryByRole('option', { name: 'Done' })).toBeNull();
    });
});
