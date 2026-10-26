import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ComponentType } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { VariablePickerProvider as ProviderJs } from '@/components/automation/Builder/mapping/VariablePickerContext';
import FormBuilderFieldsJs from '../FormBuilderFields';

// JavaScript components whose props TypeScript infers from their defaults.
const FormBuilderFields = FormBuilderFieldsJs as unknown as ComponentType<Record<string, unknown>>;
const VariablePickerProvider = ProviderJs as unknown as ComponentType<Record<string, unknown> & { children?: React.ReactNode }>;

type Field = Record<string, unknown>;
type Form = { title: string; description: string; fields: Field[]; theme: null };

const SAMPLE = { steps: { s1: { output: { rows: [{ id: 'a1', name: 'Alpha', note: 'First row' }, { id: 'b2', name: 'Beta', note: 'Second row' }] } } } };
const GROUPS = [{
    id: 's1', label: 'Lookup', kind: 'integration_action', basePath: 'steps.s1.output',
    sample: SAMPLE.steps.s1.output,
    fields: [{ key: 'rows', path: 'steps.s1.output.rows', sample: SAMPLE.steps.s1.output.rows }],
}];

const q = (name: string, type: string, label: string, extra: Field = {}): Field => ({ name, type, label, required: false, placeholder: '', ...extra });
const form = (fields: Field[]): Form => ({ title: 'Page', description: '', fields, theme: null });

/** A host that keeps the declaration, as the builder does, and reports every edit. */
function setup(initial: Form, props: Record<string, unknown> = {}, variant = 'input', ctxSample: unknown = SAMPLE) {
    const seen: Form[] = [];
    function Host() {
        const [value, setValue] = useState(initial);
        return (
            <VariablePickerProvider groups={GROUPS} previewSample={ctxSample} stepLabelById={new Map()} stepTypeById={new Map()}>
                <FormBuilderFields
                    form={value}
                    onChange={(next: Form) => { setValue(next); seen.push(next); }}
                    bindingBase="steps.p1.output"
                    variant={variant}
                    defaultExpanded
                    hidePreview
                    {...props}
                />
            </VariablePickerProvider>
        );
    }
    render(<Host />);
    return { seen, last: () => seen[seen.length - 1] as Form, user: userEvent.setup() };
}

afterEach(() => cleanup());

describe('the question type picker', () => {
    it('offers choice buttons, several choices and a text block', () => {
        setup(form([q('a', 'text', 'A')]));
        const picker = screen.getByLabelText('Question 1 type');
        const labels = within(picker).getAllByRole('option').map(o => o.textContent);
        expect(labels).toEqual(expect.arrayContaining(['Choice buttons', 'Several choices', 'Text block']));
    });

    it('adds a text block from the page and from a closing page', async () => {
        const input = setup(form([q('a', 'text', 'A')]));
        await input.user.click(screen.getByRole('button', { name: /Add a text block/ }));
        expect(input.last().fields[1]).toMatchObject({ type: 'info', content: '' });
        cleanup();
        const ending = setup(form([]), {}, 'ending');
        await ending.user.click(screen.getByRole('button', { name: /Add a text block/ }));
        expect(ending.last().fields[0]).toMatchObject({ type: 'info' });
    });

    it('clears the settings the new type does not use', async () => {
        const { user, last } = setup(form([q('n', 'number', 'Amount', { min: 1, max: 9 })]));
        await user.selectOptions(screen.getByLabelText('Question 1 type'), 'text');
        const field = last().fields[0] as Field;
        expect(field.type).toBe('text');
        expect(field.min).toBeUndefined();
        expect(field.max).toBeUndefined();
    });

    it('drops the list source when a question stops being a choice', async () => {
        const { user, last } = setup(form([q('c', 'select', 'Pick', { optionsFrom: { ref: 'steps.s1.output.rows' } })]), { allowVariables: true, previewSample: SAMPLE });
        await user.selectOptions(screen.getByLabelText('Question 1 type'), 'text');
        expect((last().fields[0] as Field).optionsFrom).toBeUndefined();
    });
});

describe('ChoiceOptionsEditor: fixed list', () => {
    it('writes plain strings for a simple list, on a radio question too', async () => {
        const { user, last } = setup(form([q('c', 'radio', 'Colour', { options: [] })]));
        await user.type(screen.getByLabelText('Question 1 choices'), 'Red{Enter}Blue');
        expect((last().fields[0] as Field).options).toEqual(['Red', 'Blue']);
    });

    it('writes an object only for a choice that gets its own label or hint', async () => {
        const { user, last } = setup(form([q('c', 'select', 'Country', { options: ['nl', 'be'] })]));
        await user.click(screen.getByRole('button', { name: 'Show a different label or a hint' }));
        await user.type(screen.getByLabelText('Question 1 choice 1 label'), 'Netherlands');
        expect((last().fields[0] as Field).options).toEqual([{ value: 'nl', label: 'Netherlands' }, 'be']);
        await user.type(screen.getByLabelText('Question 1 choice 2 hint'), 'Brussels office');
        expect((last().fields[0] as Field).options).toEqual([{ value: 'nl', label: 'Netherlands' }, { value: 'be', hint: 'Brussels office' }]);
    });

    it('writes the fewest and most choices of a several-choices question', async () => {
        const { user, last } = setup(form([q('t', 'multiselect', 'Topics', { options: ['a', 'b', 'c'] })]));
        await user.type(screen.getByLabelText('Question 1 minimum choices'), '1');
        await user.type(screen.getByLabelText('Question 1 maximum choices'), '2');
        expect(last().fields[0]).toMatchObject({ minSelected: 1, maxSelected: 2 });
    });

    it('says when the minimum is above the maximum', async () => {
        setup(form([q('t', 'multiselect', 'Topics', { options: ['a'], minSelected: 3, maxSelected: 1 })]));
        expect(screen.getByRole('alert').textContent).toMatch(/minimum is higher than the maximum/);
    });
});

describe('ChoiceOptionsEditor: from an earlier step', () => {
    const later = { allowVariables: true, previewSample: SAMPLE };

    it('switches the source and writes optionsFrom with the value and label keys', async () => {
        const { user, last } = setup(form([q('c', 'select', 'Pick one', { options: ['x'] })]), later);
        await user.click(screen.getByRole('button', { name: 'From an earlier step' }));
        expect((last().fields[0] as Field).optionsFrom).toEqual({ ref: '' });
        // The typed list stays where it is: switching back is one click.
        expect((last().fields[0] as Field).options).toEqual(['x']);

        await user.click(screen.getByTitle('steps.s1.output.rows'));
        expect((last().fields[0] as Field).optionsFrom).toEqual({ ref: 'steps.s1.output.rows' });

        const value = screen.getByLabelText('Question 1 choices value');
        expect(within(value).getAllByRole('option').map(o => o.textContent)).toEqual(['The item itself', 'id', 'name', 'note']);
        await user.selectOptions(value, 'id');
        await user.selectOptions(screen.getByLabelText('Question 1 choices label'), 'name');
        await user.selectOptions(screen.getByLabelText('Question 1 choices hint'), 'note');
        await user.type(screen.getByLabelText('Question 1 choices limit'), '5');
        expect((last().fields[0] as Field).optionsFrom).toEqual({ ref: 'steps.s1.output.rows', value: 'id', label: 'name', hint: 'note', limit: 5 });
        expect(screen.getByText(/answer is the value; the label is only what people read/i)).toBeTruthy();
    });

    it('goes back to the fixed list without losing it', async () => {
        const { user, last } = setup(form([q('c', 'select', 'Pick', { options: ['x'], optionsFrom: { ref: 'steps.s1.output.rows' } })]), later);
        await user.click(screen.getByRole('button', { name: 'Fixed list' }));
        expect((last().fields[0] as Field).optionsFrom).toBeUndefined();
        expect((screen.getByLabelText('Question 1 choices') as HTMLTextAreaElement).value).toBe('x');
    });

    it('types the item keys when there is no sample to read them from', async () => {
        const { user, last } = setup(form([q('c', 'select', 'Pick', { optionsFrom: { ref: 'steps.s1.output.rows' } })]), { allowVariables: true, previewSample: null }, 'input', null);
        const input = screen.getByLabelText('Question 1 choices value') as HTMLInputElement;
        expect(input.tagName).toBe('INPUT');
        await user.type(input, 'id');
        expect((last().fields[0] as Field).optionsFrom).toMatchObject({ value: 'id' });
    });

    it('is not offered on the first page', () => {
        setup(form([q('c', 'select', 'Pick', { options: ['x'] })]), { allowVariables: false });
        expect(screen.queryByRole('button', { name: 'From an earlier step' })).toBeNull();
        expect(screen.getByLabelText('Question 1 choices')).toBeTruthy();
    });
});

describe('FieldRulesEditor', () => {
    it('stays collapsed until asked, then writes min and max for a number', async () => {
        const { user, last } = setup(form([q('n', 'number', 'Amount')]));
        expect(screen.queryByLabelText('Question 1 min')).toBeNull();
        await user.click(screen.getByRole('button', { name: 'Answer rules' }));
        await user.type(screen.getByLabelText('Question 1 min'), '1');
        await user.type(screen.getByLabelText('Question 1 max'), '10');
        expect(last().fields[0]).toMatchObject({ min: 1, max: 10 });
    });

    it('writes a date range as YYYY-MM-DD', async () => {
        const { user, last } = setup(form([q('d', 'date', 'Start')]));
        await user.click(screen.getByRole('button', { name: 'Answer rules' }));
        await user.type(screen.getByLabelText('Question 1 min'), '2026-01-01');
        expect((last().fields[0] as Field).min).toBe('2026-01-01');
    });

    it('writes a length and a pattern with its message, and warns when min is above max', async () => {
        const { user, last } = setup(form([q('t', 'text', 'Code')]));
        await user.click(screen.getByRole('button', { name: 'Answer rules' }));
        await user.type(screen.getByLabelText('Question 1 minLength'), '5');
        await user.type(screen.getByLabelText('Question 1 maxLength'), '3');
        expect(screen.getByRole('alert').textContent).toMatch(/higher than the highest/);
        await user.type(screen.getByLabelText('Question 1 pattern'), '[[A-Z]+');
        await user.type(screen.getByLabelText('Question 1 pattern message'), 'Capitals only.');
        expect(last().fields[0]).toMatchObject({ minLength: 5, maxLength: 3, pattern: '[A-Z]+', patternMessage: 'Capitals only.' });
    });

    it('starts open on a question that already has a rule, and is absent for a choice', () => {
        setup(form([q('n', 'number', 'Amount', { min: 2 }), q('c', 'select', 'Pick', { options: ['a'] })]));
        expect((screen.getByLabelText('Question 1 min') as HTMLInputElement).value).toBe('2');
        expect(screen.getAllByRole('button', { name: /answer rules/i })).toHaveLength(1);
    });
});

describe('ShowIfEditor', () => {
    const three = () => form([
        q('contact', 'select', 'Contact by', { options: ['email', 'phone'] }),
        q('email', 'email', 'Your email'),
        q('note', 'textarea', 'Note'),
    ]);

    it('offers nothing on the first question and only earlier questions on the others', async () => {
        const { user } = setup(three());
        const add = screen.getAllByRole('button', { name: /Only show this question when/ });
        expect(add).toHaveLength(2);
        await user.click(add[1] as HTMLElement);
        const picker = screen.getByLabelText('Question 3 condition question');
        expect(within(picker).getAllByRole('option').map(o => o.textContent)).toEqual(['Contact by', 'Your email']);
    });

    it('writes the expression for the earlier question and its first choice', async () => {
        const { user, last } = setup(three());
        await user.click(screen.getAllByRole('button', { name: /Only show this question when/ })[0] as HTMLElement);
        // The nearest earlier question, with an `is` and its first choice, is a complete condition.
        expect((last().fields[1] as Field).showIf).toBe('!isEmpty(form.contact)'.replace('!isEmpty(form.contact)', 'form.contact == "email"'));
        await user.selectOptions(screen.getByLabelText('Question 2 condition value'), 'phone');
        expect((last().fields[1] as Field).showIf).toBe('form.contact == "phone"');
        await user.selectOptions(screen.getByLabelText('Question 2 condition operator'), 'ne');
        expect((last().fields[1] as Field).showIf).toBe('form.contact != "phone"');
    });

    it('writes an is-empty condition without a value', async () => {
        const { user, last } = setup(three());
        await user.click(screen.getAllByRole('button', { name: /Only show this question when/ })[1] as HTMLElement);
        await user.selectOptions(screen.getByLabelText('Question 3 condition question'), 'email');
        await user.selectOptions(screen.getByLabelText('Question 3 condition operator'), 'notEmpty');
        expect((last().fields[2] as Field).showIf).toBe('!isEmpty(form.email)');
        expect(screen.queryByLabelText('Question 3 condition value')).toBeNull();
    });

    it('shows a stored condition it cannot read as text, untouched', () => {
        const fields = three().fields;
        (fields[1] as Field).showIf = 'form.contact == "email" && len(form.note) > 2';
        setup({ ...three(), fields });
        const box = screen.getByLabelText('Question 2 condition') as HTMLTextAreaElement;
        expect(box.value).toBe('form.contact == "email" && len(form.note) > 2');
        expect(screen.getByText(/too detailed for the picker/)).toBeTruthy();
    });

    it('reads a stored condition into the picker and clears it', async () => {
        const fields = three().fields;
        (fields[1] as Field).showIf = 'form.contact == "phone"';
        const { user, last } = setup({ ...three(), fields });
        expect((screen.getByLabelText('Question 2 condition value') as HTMLSelectElement).value).toBe('phone');
        await user.click(screen.getByRole('button', { name: 'Always show it' }));
        expect((last().fields[1] as Field).showIf).toBeUndefined();
    });

    it('does not offer a text block or a per-item question as a thing to depend on', async () => {
        const fields = [q('intro', 'info', 'Intro', { content: 'Hello' }), q('rate', 'number', 'Rate', { fieldsFrom: { ref: 'steps.s1.output.rows' } }), q('x', 'text', 'X')];
        setup(form(fields), { allowVariables: true, previewSample: SAMPLE });
        expect(screen.queryByRole('button', { name: /Only show this question when/ })).toBeNull();
    });
});

describe('InfoFieldEditor', () => {
    it('writes the text of a block and asks for nothing else', async () => {
        const { user, last } = setup(form([q('note', 'info', 'Note', { content: '' })]));
        expect(screen.queryByText('Required')).toBeNull();
        await user.type(screen.getByLabelText('Text block 1'), 'Bring a photo ID.');
        expect((last().fields[0] as Field).content).toBe('Bring a photo ID.');
    });

    it('lives on a closing page next to the downloads', async () => {
        setup(form([q('note', 'info', 'Note', { content: 'See you soon.' })]), {}, 'ending');
        expect(screen.getByLabelText('Text block 1')).toBeTruthy();
    });
});

describe('PerItemEditor', () => {
    const later = { allowVariables: true, previewSample: SAMPLE };

    it('writes fieldsFrom and shows the shape of the answers', async () => {
        const { user, last } = setup(form([q('rating', 'number', 'Rate it')]), later);
        await user.click(screen.getByLabelText('Question 1 once per item'));
        expect((last().fields[0] as Field).fieldsFrom).toEqual({ ref: '' });
        await user.click(screen.getByTitle('steps.s1.output.rows'));
        await user.selectOptions(screen.getByLabelText('Question 1 items value'), 'id');
        await user.selectOptions(screen.getByLabelText('Question 1 items label'), 'name');
        expect((last().fields[0] as Field).fieldsFrom).toEqual({ ref: 'steps.s1.output.rows', value: 'id', label: 'name' });
        expect(screen.getByText('steps.p1.output.rating')).toBeTruthy();
        expect(screen.getByText('[{ key, label, answer }]')).toBeTruthy();
    });

    it('turns off again', async () => {
        const { user, last } = setup(form([q('rating', 'number', 'Rate it', { fieldsFrom: { ref: 'steps.s1.output.rows' } })]), later);
        await user.click(screen.getByLabelText('Question 1 once per item'));
        expect((last().fields[0] as Field).fieldsFrom).toBeUndefined();
    });

    it('is not offered for a question type that cannot repeat, nor on the first page', () => {
        setup(form([q('f', 'file', 'Upload')]), later);
        expect(screen.queryByLabelText('Question 1 once per item')).toBeNull();
        cleanup();
        setup(form([q('rating', 'number', 'Rate it')]), { allowVariables: false });
        expect(screen.queryByLabelText('Question 1 once per item')).toBeNull();
    });
});
