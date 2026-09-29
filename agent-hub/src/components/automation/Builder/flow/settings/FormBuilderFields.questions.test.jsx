import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import FormBuilderFields, {
    slugifyFieldName,
    normaliseOptions,
    fillTemplate,
    defaultFormDeclaration,
    defaultFormPageDeclaration,
    defaultFormEndingDeclaration,
    THEME_PRESETS,
} from './FormBuilderFields';

/**
 * The question list itself: adding, reordering, removing and retyping a
 * question, and the two per-type control sets underneath.
 *
 * Characterisation only (FRM-0). The one invariant the panel is built around —
 * `name` is slugged once and never re-derived — already has its test at the
 * SettingsForm level; what is pinned here is everything around it, including
 * the shapes the helper functions produce for an AI-authored declaration.
 */

const form = (fields, over = {}) => ({
    title: 'Get in touch',
    description: '',
    submitLabel: 'Submit',
    successMessage: 'Thanks!',
    fields,
    theme: null,
    ...over,
});

const text = (name, label) => ({ name, type: 'text', label, required: false, placeholder: '' });

function renderEditor(declaration, props = {}) {
    const onChange = vi.fn();
    const utils = render(<FormBuilderFields form={declaration} onChange={onChange} bindingBase="trigger.output" {...props} />);
    return { ...utils, onChange };
}

describe('FormBuilderFields — the question list', () => {
    beforeEach(cleanup);

    it('warns that a form with no questions cannot be submitted by anyone', () => {
        renderEditor(form([]));
        expect(screen.getByText('No questions yet — nobody can submit this form.')).toBeTruthy();
    });

    it('adds a question that already works, without opening a dialog', () => {
        const { onChange } = renderEditor(form([]));
        fireEvent.click(screen.getByText('Add a question'));
        expect(onChange.mock.calls[0][0].fields).toEqual([
            { name: 'new_question', type: 'text', label: 'New question', required: false, placeholder: '' },
        ]);
    });

    it('moves a question up and down, and greys the arrows out at the ends', () => {
        const { onChange } = renderEditor(form([text('one', 'One'), text('two', 'Two')]));
        const up = screen.getAllByLabelText('Move question up');
        const down = screen.getAllByLabelText('Move question down');
        expect(up[0].disabled).toBe(true);
        expect(down[1].disabled).toBe(true);

        fireEvent.click(down[0]);
        expect(onChange.mock.calls[0][0].fields.map(f => f.name)).toEqual(['two', 'one']);
        fireEvent.click(up[1]);
        expect(onChange.mock.calls[1][0].fields.map(f => f.name)).toEqual(['two', 'one']);
    });

    it('removes the question the visitor is looking at, by its own name', () => {
        const { onChange } = renderEditor(form([text('one', 'One'), text('two', 'Two')]));
        fireEvent.click(screen.getByLabelText('Remove Two'));
        expect(onChange.mock.calls[0][0].fields.map(f => f.name)).toEqual(['one']);
    });

    it('offers exactly the eleven types the server accepts, in one fixed order', () => {
        renderEditor(form([text('one', 'One')]));
        const options = [...screen.getByLabelText('Question 1 type').querySelectorAll('option')];
        expect(options.map(o => o.value)).toEqual([
            'text', 'textarea', 'email', 'number', 'date', 'select', 'checkbox', 'file', 'app_pick', 'download', 'notebook',
        ]);
        expect(options.map(o => o.textContent)).toContain('Short text');
    });

    it('keeps the binding name when a question changes type', () => {
        const { onChange } = renderEditor(form([text('colour', 'Colour')]));
        fireEvent.change(screen.getByLabelText('Question 1 type'), { target: { value: 'select' } });
        expect(onChange.mock.calls[0][0].fields[0]).toMatchObject({ name: 'colour', type: 'select' });
    });

    it('ticks a question as required from the card, without touching anything else', () => {
        const { onChange } = renderEditor(form([text('one', 'One')]));
        fireEvent.click(screen.getByText('Required').querySelector('input'));
        expect(onChange.mock.calls[0][0].fields[0]).toMatchObject({ name: 'one', required: true });
    });

    it('names the card after the question, falling back to the binding name', () => {
        renderEditor(form([{ name: 'orphan', type: 'text', label: '' }]));
        expect(screen.getByText('orphan')).toBeTruthy();
    });
});

describe('FormBuilderFields — the per-type controls', () => {
    beforeEach(cleanup);

    it('asks a file question what it accepts and how big it may be', () => {
        const { onChange } = renderEditor(form([{ name: 'proof', type: 'file', label: 'Proof' }]));
        expect(screen.getByText('Accepted types')).toBeTruthy();

        const max = screen.getByText('Max MB').parentElement.querySelector('input');
        // wart: the box shows 10 while the declaration has no maxSizeMb at all,
        // so what the author reads is not what is stored — the number only
        // becomes real once it is touched. The server defaults to the same 10,
        // which is why nobody has noticed.
        expect(max.value).toBe('10');
        fireEvent.change(max, { target: { value: '3' } });
        expect(onChange.mock.calls[0][0].fields[0].maxSizeMb).toBe(3);
    });

    it('falls back to 10 MB rather than storing a nonsense limit', () => {
        const { onChange } = renderEditor(form([{ name: 'proof', type: 'file', label: 'Proof', maxSizeMb: 5 }]));
        fireEvent.change(screen.getByText('Max MB').parentElement.querySelector('input'), { target: { value: '' } });
        expect(onChange.mock.calls[0][0].fields[0].maxSizeMb).toBe(10);
    });

    it('hides the placeholder and the binding name until Advanced is opened', () => {
        renderEditor(form([text('one', 'One')]));
        expect(screen.queryByText('Binding name')).toBeNull();

        fireEvent.click(screen.getByText('Advanced'));
        expect(screen.getByText('Binding name')).toBeTruthy();
        expect(screen.getByText('trigger.output.one')).toBeTruthy();
        expect(screen.getByLabelText('Question 1 placeholder')).toBeTruthy();
        // No onRenameField here — that is the standalone Forms editor, which can
        // see the form but not the steps that bind it. The name is read-only
        // there, and says where the rename does live.
        expect(screen.getByText(/Rename it from the routine that uses this form/)).toBeTruthy();
    });

    it('lets the binding name be renamed where the whole routine is in scope', () => {
        const onRenameField = vi.fn(() => 3);
        const { onChange } = renderEditor(form([text('one', 'One'), text('two', 'Two')]), { onRenameField });
        fireEvent.click(screen.getAllByText('Advanced')[0]);

        const box = screen.getByLabelText('Binding name for One');
        fireEvent.change(box, { target: { value: 'contactpersoon' } });
        fireEvent.click(screen.getByRole('button', { name: 'Rename' }));

        // The shell rewrites the routine; the panel also renames its own copy,
        // or the node's autosave would put the old name straight back.
        expect(onRenameField).toHaveBeenCalledWith('one', 'contactpersoon');
        expect(onChange.mock.calls.at(-1)[0].fields[0].name).toBe('contactpersoon');
        expect(screen.getByText(/3 bindings in this routine now point at it/)).toBeTruthy();
    });

    it('refuses a name the server would reject, or one the page already uses', () => {
        const onRenameField = vi.fn(() => 0);
        renderEditor(form([text('one', 'One'), text('two', 'Two')]), { onRenameField });
        fireEvent.click(screen.getAllByText('Advanced')[0]);
        const box = screen.getByLabelText('Binding name for One');

        fireEvent.change(box, { target: { value: '2naam' } });
        fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
        expect(screen.getByText(/Start with a letter/)).toBeTruthy();

        fireEvent.change(box, { target: { value: 'two' } });
        fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
        expect(screen.getByText(/already binds that name/)).toBeTruthy();

        // Neither attempt reached the routine.
        expect(onRenameField).not.toHaveBeenCalled();
    });

    it('shows the binding base it was given, so a form_page reads as its own step', () => {
        renderEditor(form([text('one', 'One')]), { bindingBase: 'steps.fp_1.output' });
        fireEvent.click(screen.getByText('Advanced'));
        expect(screen.getByText('steps.fp_1.output.one')).toBeTruthy();
    });
});

describe('slugifyFieldName — the binding name, minted once', () => {
    it('turns a question into a name a downstream step can bind to', () => {
        expect(slugifyFieldName('Your name')).toBe('your_name');
        expect(slugifyFieldName('Wat is uw straat & huisnummer?')).toBe('wat_is_uw_straat_huisnummer');
    });

    it('drops leading digits, because the server insists on a letter first', () => {
        expect(slugifyFieldName('12 items')).toBe('items');
    });

    it('falls back to "field" when nothing usable is left', () => {
        expect(slugifyFieldName('123')).toBe('field');
        expect(slugifyFieldName('   ')).toBe('field');
        expect(slugifyFieldName('')).toBe('field');
    });

    it('numbers a name that is already taken instead of colliding', () => {
        expect(slugifyFieldName('Your name', new Set(['your_name']))).toBe('your_name_2');
        expect(slugifyFieldName('Your name', new Set(['your_name', 'your_name_2']))).toBe('your_name_3');
    });

    it('splits an accented word into pieces', () => {
        // wart: NFKD decomposes é into e + a combining mark, and the mark is
        // then replaced by a SPACE — so a Dutch, French or German label breaks
        // apart mid-word. The name is permanent once minted, so every binding
        // downstream carries the damage. Pinned as-is; a stage that fixes this
        // has to keep existing names working.
        expect(slugifyFieldName('Naïve café')).toBe('nai_ve_cafe');
        expect(slugifyFieldName('Ünïcôde')).toBe('u_ni_co_de');
    });
});

describe('normaliseOptions — what a dropdown\'s choices become', () => {
    it('accepts a plain list of strings, which is what the editor writes', () => {
        expect(normaliseOptions(['Red', 'Green'])).toEqual([
            { value: 'Red', label: 'Red' }, { value: 'Green', label: 'Green' },
        ]);
    });

    it('keeps a value/label pair, and labels a pair that has only a value', () => {
        expect(normaliseOptions([{ value: 'r', label: 'Red' }, { value: 'g' }])).toEqual([
            { value: 'r', label: 'Red' }, { value: 'g', label: 'g' },
        ]);
    });

    it('drops a choice with no value — an AI-authored { label } only', () => {
        expect(normaliseOptions([{ label: 'Red' }, 'Green', null, 42])).toEqual([{ value: 'Green', label: 'Green' }]);
    });

    it('answers with an empty list for anything that is not one', () => {
        expect(normaliseOptions(undefined)).toEqual([]);
        expect(normaliseOptions('Red')).toEqual([]);
    });
});

describe('fillTemplate — the preview\'s stand-in for the server', () => {
    const sample = { steps: { s1: { output: { name: 'Jane' } } } };

    it('resolves a path against the builder\'s sample tree', () => {
        expect(fillTemplate('Hello {{steps.s1.output.name}}', sample)).toBe('Hello Jane');
    });

    it('leaves a path it cannot resolve standing, so a typo stays visible', () => {
        expect(fillTemplate('Hello {{steps.s1.output.nam}}', sample)).toBe('Hello {{steps.s1.output.nam}}');
    });

    it('leaves plain text and an empty sample tree alone', () => {
        expect(fillTemplate('Hello', sample)).toBe('Hello');
        expect(fillTemplate('Hello {{steps.s1.output.name}}', null)).toBe('Hello {{steps.s1.output.name}}');
        expect(fillTemplate(null, sample)).toBe('');
    });
});

describe('the declarations a new node starts with', () => {
    it('a trigger starts publishable: three questions and the Clean preset', () => {
        const d = defaultFormDeclaration();
        expect(d.fields.map(f => [f.name, f.type])).toEqual([['name', 'text'], ['email', 'email'], ['message', 'textarea']]);
        expect(d.submitLabel).toBe('Submit');
        // The five theme values are asserted LITERALLY. Comparing against
        // `THEME_PRESETS[0].theme` would pin nothing: the declaration spreads
        // that very object, so both sides move together whenever the preset
        // is edited. The id is checked separately — that is what makes the
        // preset the trigger starts on the *Clean* one.
        expect(THEME_PRESETS[0].id).toBe('clean');
        expect(d.theme).toEqual({
            primary: '#0F766E',
            radius: 'md',
            density: 'comfortable',
            fontScale: 'md',
            appearance: 'light',
        });
    });

    it('a later page inherits the first page\'s look rather than restyling itself', () => {
        expect(defaultFormPageDeclaration().theme).toBeNull();
        expect(defaultFormPageDeclaration().fields).toHaveLength(1);
    });

    it('a closing page asks nothing at all', () => {
        const d = defaultFormEndingDeclaration();
        expect(d.fields).toEqual([]);
        expect(d.submitLabel).toBeUndefined();
    });
});
