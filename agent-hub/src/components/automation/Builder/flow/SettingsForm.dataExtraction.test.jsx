import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import SettingsForm from './SettingsForm';
import { VariablePickerProvider } from '../mapping/VariablePickerContext';
import scopedStorage from '../../../../utils/scopedStorage';
import { editor, editorValue } from '../../../../test/refEditor';
import {
    extractFormState, buildPatch, sanitizeExtractionFields, coerceExtractionName,
    isEmptyExtractionSource, EXTRACTION_FIELD_TYPES, MAX_EXTRACTION_FIELDS, FOREACH_FORM_TYPES,
} from './settings/formState';
import { buildStepFromPayload } from '../DiagramPane';

/**
 * The Extract data step's editor and its form state.
 *
 * What is pinned, and why:
 *   - the persisted step never carries a row the server would refuse: blank
 *     names and duplicates are dropped from the wire (`field_name_invalid` /
 *     `fields_duplicate` are integrity codes and would 400 the autosave), while
 *     the DRAFT keeps the row so it does not vanish under the author;
 *   - names are coerced to lowercase snake as typed, so what is on screen is
 *     what is saved and the server never sees an invalid one;
 *   - an unbound source is ABSENT, not null — `typeof null === 'object'` is the
 *     shape a "must be a binding" rule lets through and then trips over;
 *   - the model is not a setting here: one static line, config key in the tip.
 */

const noIssues = { errors: [], warnings: [] };

function renderForm(step, { onPatch = vi.fn(), previewSample = null, groups = [] } = {}) {
    return render(
        <VariablePickerProvider groups={groups} previewSample={previewSample} stepLabelById={new Map()}>
            <SettingsForm step={step} modelTiers={{ fast: { label: 'Fast' } }} stepIssues={noIssues} saving={false} saveError={null} onPatch={onPatch} catalog={null} groups={groups} previewSample={previewSample} />
        </VariablePickerProvider>,
    );
}

const freshStep = () => ({ ...buildStepFromPayload({ kind: 'data_extraction', label: 'Extract data' }), id: 'ex_1' });

describe('data_extraction — form state', () => {
    it('a freshly dropped step opens on one blank row and an empty ref source', () => {
        const step = freshStep();
        expect(step.type).toBe('data_extraction');
        expect(step.id).toMatch(/^ex_/);
        expect(step.fields).toEqual([{ name: '', type: 'string', description: '', required: false }]);
        expect('source' in step).toBe(false);
        const draft = extractFormState(step);
        // Expression mode from the start, so a dragged value lands as a bare ref.
        expect(draft.source).toEqual({ kind: 'ref', path: '' });
        expect(draft.fields).toEqual([{ name: '', type: 'string', description: '', required: false }]);
        expect(draft.instructions).toBe('');
        expect(draft.forEach).toBeNull();
    });

    it('a step with no fields at all still opens on one blank row (the seed is draft-only)', () => {
        expect(extractFormState({ id: 'ex_1', type: 'data_extraction', fields: [] }).fields).toHaveLength(1);
        expect(extractFormState({ id: 'ex_1', type: 'data_extraction' }).fields).toHaveLength(1);
    });

    it('persisted rows come back in the full four-key shape, unknown types as string, order kept', () => {
        const draft = extractFormState({
            id: 'ex_1', type: 'data_extraction',
            fields: [{ name: 'totaal', type: 'number' }, { name: 'datum', type: 'date', description: 'Invoice date', required: true }, { name: 'x', type: 'blob' }],
        });
        expect(draft.fields).toEqual([
            { name: 'totaal', type: 'number', description: '', required: false },
            { name: 'datum', type: 'date', description: 'Invoice date', required: true },
            { name: 'x', type: 'string', description: '', required: false },
        ]);
    });

    it('buildPatch drops the blank seed row, dedupes, coerces names and writes only what says something', () => {
        const step = { id: 'ex_1', type: 'data_extraction', fields: [{ name: '', type: 'string', description: '', required: false }] };
        const patch = buildPatch(step, {
            ...extractFormState(step),
            source: { kind: 'ref', path: 'steps.read.output.content' },
            fields: [
                { name: '', type: 'string', description: '', required: false },
                { name: 'datum', type: 'date', description: ' Invoice date ', required: true },
                { name: 'Totaal', type: 'number', description: '', required: false },
                { name: 'datum', type: 'string', description: 'dupe', required: false },
                { name: 'ok', type: 'nope', description: '', required: false },
            ],
            instructions: 'Amounts are in euros.',
        });
        expect(patch.source).toEqual({ kind: 'ref', path: 'steps.read.output.content' });
        expect(patch.fields).toEqual([
            { name: 'datum', type: 'date', description: 'Invoice date', required: true },
            { name: 'totaal', type: 'number' },
            { name: 'ok', type: 'string' },
        ]);
        expect(patch.instructions).toBe('Amounts are in euros.');
    });

    it('an unbound source is not sent at all, and never as null', () => {
        const step = { id: 'ex_1', type: 'data_extraction', source: { kind: 'ref', path: 'steps.a.output.text' }, fields: [{ name: 'a', type: 'string' }] };
        for (const empty of [{ kind: 'ref', path: '' }, { kind: 'literal', value: '' }, { kind: 'template', value: '  ' }, null, undefined]) {
            const patch = buildPatch(step, { ...extractFormState(step), source: empty });
            expect('source' in patch, JSON.stringify(empty)).toBe(true);
            expect(patch.source).toBeUndefined();
        }
        expect(isEmptyExtractionSource({ kind: 'ref', path: 'steps.a.output.text' })).toBe(false);
        expect(isEmptyExtractionSource({ kind: 'literal', value: 'x' })).toBe(false);
    });

    it('instructions are capped at 2000 characters and omitted when blank; forEach round-trips', () => {
        const step = { id: 'ex_1', type: 'data_extraction', fields: [{ name: 'a', type: 'string' }], instructions: 'old' };
        const long = buildPatch(step, { ...extractFormState(step), instructions: 'x'.repeat(2500) });
        expect(long.instructions).toHaveLength(2000);
        const blank = buildPatch(step, { ...extractFormState(step), instructions: '' });
        expect('instructions' in blank).toBe(true);
        expect(blank.instructions).toBeUndefined();

        const fe = buildPatch(step, { ...extractFormState(step), forEach: { overRef: 'steps.read.output.results', itemVar: 'f', maxIterations: 5000 } });
        expect(fe.forEach).toEqual({ overRef: 'steps.read.output.results', itemVar: 'f', maxIterations: 1000 });
        expect(FOREACH_FORM_TYPES.has('data_extraction')).toBe(true);
        const off = buildPatch({ ...step, forEach: { overRef: 'x', itemVar: 'item', maxIterations: 100 } }, { ...extractFormState(step), forEach: null });
        expect(off.forEach).toBeNull();
    });

    it('coerceExtractionName turns what a person types into a legal output key', () => {
        expect(coerceExtractionName('Invoice Date')).toBe('invoice_date');
        expect(coerceExtractionName('€ totaal incl. BTW')).toBe('totaal_incl_btw');
        expect(coerceExtractionName('2nd line')).toBe('nd_line');
        expect(coerceExtractionName('a-b--c')).toBe('a_b_c');
        expect(coerceExtractionName('x'.repeat(60))).toHaveLength(40);
        expect(coerceExtractionName('')).toBe('');
        expect(coerceExtractionName(null)).toBe('');
    });

    it('sanitizeExtractionFields caps the list at 30 and ignores garbage rows', () => {
        const many = Array.from({ length: 40 }, (_, i) => ({ name: `f${i}`, type: 'string' }));
        expect(sanitizeExtractionFields([null, 'junk', ...many])).toHaveLength(MAX_EXTRACTION_FIELDS);
        expect(EXTRACTION_FIELD_TYPES).toEqual(['string', 'number', 'boolean', 'date']);
    });
});

describe('SettingsForm — DataExtractionFields', () => {
    beforeEach(() => {
        cleanup();
        vi.clearAllMocks();
        scopedStorage.setCurrentUser('data-extraction-test-user');
        try { localStorage.clear(); } catch {}
    });

    it('renders source, fields, instructions — and the model as one static line naming the config key', () => {
        renderForm(freshStep());
        expect(screen.getByRole('button', { name: /Text to read/ })).toBeTruthy();
        expect(screen.getByRole('button', { name: /Fields to extract/ })).toBeTruthy();
        expect(screen.getByRole('button', { name: /Extra instructions/ })).toBeTruthy();
        // The source is a binding control (the RefTokenInput host), not a plain input.
        expect(editor(document.body)).toBeTruthy();
        const note = screen.getByTestId('extraction-model-note');
        expect(note.textContent).toBe('Runs on the extraction model set by your administrator');
        expect(note.getAttribute('title')).toContain('data_extraction_model');
        // Nothing to pick a model or a tier with.
        expect(screen.queryByText('Model tier')).toBeNull();
        expect(screen.queryByText(/Structured output/)).toBeNull();
    });

    it('opens on one blank row; Add field appends; the type menu offers exactly the four types', () => {
        renderForm(freshStep());
        expect(screen.getAllByTestId('extraction-field-row')).toHaveLength(1);
        fireEvent.click(screen.getByText('Add field'));
        expect(screen.getAllByTestId('extraction-field-row')).toHaveLength(2);
        const typeSelect = screen.getAllByLabelText('Type')[0];
        expect([...typeSelect.options].map(o => o.value)).toEqual(['string', 'number', 'boolean', 'date']);
    });

    it('coerces the name as it is typed, so the screen shows the key that will be saved', () => {
        renderForm(freshStep());
        const name = screen.getByLabelText('Name');
        fireEvent.change(name, { target: { value: 'Invoice Date' } });
        expect(name.value).toBe('invoice_date');
    });

    it('saves through onPatch with the blank seed row dropped and the named rows in the shape the runner reads', async () => {
        const onPatch = vi.fn(async () => {});
        renderForm(freshStep(), { onPatch });
        const rows = () => screen.getAllByTestId('extraction-field-row');
        fireEvent.change(within(rows()[0]).getByLabelText('Name'), { target: { value: 'datum' } });
        fireEvent.change(within(rows()[0]).getByLabelText('Type'), { target: { value: 'date' } });
        fireEvent.change(within(rows()[0]).getByLabelText('What to look for'), { target: { value: 'Invoice date' } });
        fireEvent.click(within(rows()[0]).getByRole('checkbox'));
        fireEvent.click(screen.getByText('Add field'));
        fireEvent.change(within(rows()[1]).getByLabelText('Name'), { target: { value: 'totaal' } });
        fireEvent.change(within(rows()[1]).getByLabelText('Type'), { target: { value: 'number' } });
        fireEvent.click(screen.getByText('Add field')); // left blank on purpose
        fireEvent.click(screen.getByText('Save'));
        await waitFor(() => expect(onPatch).toHaveBeenCalled());
        const patch = onPatch.mock.calls.at(-1)[0];
        expect(patch.fields).toEqual([
            { name: 'datum', type: 'date', description: 'Invoice date', required: true },
            { name: 'totaal', type: 'number' },
        ]);
        expect('source' in patch).toBe(false); // untouched → not sent
        // The blank third row is still on screen — draft-only, not lost.
        expect(rows()).toHaveLength(3);
    });

    it('flags a repeated name on the row and leaves it out of the save', async () => {
        const onPatch = vi.fn(async () => {});
        renderForm(freshStep(), { onPatch });
        const rows = () => screen.getAllByTestId('extraction-field-row');
        fireEvent.change(within(rows()[0]).getByLabelText('Name'), { target: { value: 'datum' } });
        fireEvent.click(screen.getByText('Add field'));
        fireEvent.change(within(rows()[1]).getByLabelText('Name'), { target: { value: 'datum' } });
        expect(within(rows()[1]).getByText(/already called datum/)).toBeTruthy();
        expect(within(rows()[0]).queryByText(/already called/)).toBeNull();
        fireEvent.click(screen.getByText('Save'));
        await waitFor(() => expect(onPatch).toHaveBeenCalled());
        expect(onPatch.mock.calls.at(-1)[0].fields).toEqual([{ name: 'datum', type: 'string' }]);
    });

    it('reorders with the arrows and removes with the bin — the order is the output order', async () => {
        const onPatch = vi.fn(async () => {});
        renderForm(freshStep(), { onPatch });
        const rows = () => screen.getAllByTestId('extraction-field-row');
        fireEvent.change(within(rows()[0]).getByLabelText('Name'), { target: { value: 'a' } });
        fireEvent.click(screen.getByText('Add field'));
        fireEvent.change(within(rows()[1]).getByLabelText('Name'), { target: { value: 'b' } });
        fireEvent.click(screen.getByText('Add field'));
        fireEvent.change(within(rows()[2]).getByLabelText('Name'), { target: { value: 'c' } });
        // The first row cannot move up, the last cannot move down.
        expect(within(rows()[0]).getByLabelText('Move up').disabled).toBe(true);
        expect(within(rows()[2]).getByLabelText('Move down').disabled).toBe(true);
        fireEvent.click(within(rows()[2]).getByLabelText('Move up'));
        expect(rows().map(r => within(r).getByLabelText('Name').value)).toEqual(['a', 'c', 'b']);
        fireEvent.click(within(rows()[0]).getByLabelText('Remove field'));
        expect(rows().map(r => within(r).getByLabelText('Name').value)).toEqual(['c', 'b']);
        fireEvent.click(screen.getByText('Save'));
        await waitFor(() => expect(onPatch).toHaveBeenCalled());
        expect(onPatch.mock.calls.at(-1)[0].fields.map(f => f.name)).toEqual(['c', 'b']);
    });

    it('a saved step comes back as it was saved: source, typed fields, instructions', () => {
        const step = {
            id: 'ex_1', type: 'data_extraction', label: 'Read the invoice',
            source: { kind: 'ref', path: 'loop.f.output.content' },
            fields: [{ name: 'datum', type: 'date', description: 'Invoice date', required: true }, { name: 'totaal', type: 'number' }],
            instructions: 'Amounts are in euros.',
            forEach: { overRef: 'steps.read.output.results', itemVar: 'f', maxIterations: 100 },
        };
        renderForm(step);
        const rows = screen.getAllByTestId('extraction-field-row');
        expect(rows).toHaveLength(2);
        expect(within(rows[0]).getByLabelText('Name').value).toBe('datum');
        expect(within(rows[0]).getByLabelText('Type').value).toBe('date');
        expect(within(rows[0]).getByLabelText('What to look for').value).toBe('Invoice date');
        expect(within(rows[0]).getByRole('checkbox').checked).toBe(true);
        expect(within(rows[1]).getByRole('checkbox').checked).toBe(false);
        expect(screen.getByLabelText('Extra instructions').value).toBe('Amounts are in euros.');
        // The bound source is on screen as a reference pill; the stored value is the raw path.
        expect(editorValue(editor(document.body))).toBe('loop.f.output.content');
    });

    it('Add field stops at the 30-field ceiling', () => {
        const fields = Array.from({ length: MAX_EXTRACTION_FIELDS }, (_, i) => ({ name: `f${i}`, type: 'string' }));
        renderForm({ id: 'ex_1', type: 'data_extraction', fields });
        expect(screen.getAllByTestId('extraction-field-row')).toHaveLength(MAX_EXTRACTION_FIELDS);
        const add = screen.getByText('Add field').closest('button');
        expect(add.disabled).toBe(true);
    });
});
