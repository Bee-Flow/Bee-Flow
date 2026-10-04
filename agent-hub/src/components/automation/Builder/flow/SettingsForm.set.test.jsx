import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { editor, editors, editorValue, editorWithValue, typeInEditor } from '../../../../test/refEditor';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import SettingsForm from './SettingsForm';
import { extractFormState, buildPatch, sanitizeOperations } from './settings/formState';
import { FormDensityContext } from './settings/formDensity';
import { VariablePickerProvider } from '../mapping/VariablePickerContext';
import scopedStorage from '../../../../utils/scopedStorage';

/**
 * The "Edit data" (set) editor — two modes derived from `arrayRef` presence.
 * Single mode must stay byte-compatible with every saved automation; list mode
 * adds the per-row fields (Current row scope) and the Table tools.
 */

const noIssues = { errors: [], warnings: [] };

const RESULTS = [{ subject: 'Nextcloud ISV contract', from_email: 'a@b.nl', body: '{"order":{"total":42}}' }];
const GMAIL_GROUP = {
    id: 'g', label: 'gmail search', kind: 'integration_action', basePath: 'steps.g.output',
    sample: { results: RESULTS },
    fields: [{ key: 'results', path: 'steps.g.output.results', sample: RESULTS }],
};
const SAMPLE_ROOT = { steps: { g: { output: { results: RESULTS } } } };

function renderForm(step, { onPatch = vi.fn(), groups = [GMAIL_GROUP], previewSample = SAMPLE_ROOT, density = 'full', runStep = null } = {}) {
    render(
        <FormDensityContext.Provider value={{ density, onHiddenSection: null }}>
            <VariablePickerProvider groups={groups} previewSample={previewSample} stepLabelById={new Map([['g', 'gmail search']])}>
                <SettingsForm
                    step={step} modelTiers={{}} stepIssues={noIssues} saving={false} saveError={null}
                    onPatch={onPatch} catalog={null} groups={groups} previewSample={previewSample}
                    runStep={runStep}
                />
            </VariablePickerProvider>
        </FormDensityContext.Provider>,
    );
    return { onPatch };
}

const save = () => fireEvent.click(screen.getByText('Save'));

const SINGLE_STEP = { id: 's1', type: 'set', fields: { name: { kind: 'literal', value: 'Alice' } } };
const LIST_STEP = {
    id: 's1', type: 'set', arrayRef: 'steps.g.output.results',
    fields: { sender: { kind: 'ref', path: 'item.from_email' } },
    operations: [{ op: 'rowId', target: 'id' }],
};

describe('formState — set draft/patch shapes', () => {
    it('extracts legacy single-mode defaults (arrayRef null, operations [])', () => {
        const d = extractFormState(SINGLE_STEP);
        expect(d.arrayRef).toBeNull();
        expect(d.operations).toEqual([]);
        expect(d.maxItems).toBe('');
    });

    it('an untouched legacy save emits NO list-mode keys at all', () => {
        const d = extractFormState(SINGLE_STEP);
        const patch = buildPatch(SINGLE_STEP, d);
        expect('arrayRef' in patch).toBe(false);
        expect('operations' in patch).toBe(false);
        expect('maxItems' in patch).toBe(false);
    });

    it('list mode persists arrayRef + operations; forEach is cleared explicitly', () => {
        const legacy = { ...SINGLE_STEP, forEach: { overRef: 'steps.g.output.results', itemVar: 'item' } };
        const d = { ...extractFormState(legacy), arrayRef: 'steps.g.output.results', operations: [{ op: 'rowId', target: 'id' }] };
        const patch = buildPatch(legacy, d);
        expect(patch.arrayRef).toBe('steps.g.output.results');
        expect(patch.operations).toEqual([{ op: 'rowId', target: 'id' }]);
        expect(patch.forEach).toBeNull();
    });

    it('switching back to single mode deletes the list keys via explicit undefined', () => {
        const d = { ...extractFormState(LIST_STEP), arrayRef: null };
        const patch = buildPatch(LIST_STEP, d);
        expect('arrayRef' in patch).toBe(true);
        expect(patch.arrayRef).toBeUndefined();
        expect(patch.operations).toBeUndefined();
    });

    it('sanitizeOperations keeps half-typed rows, drops junk, normalises shapes', () => {
        expect(sanitizeOperations([
            { op: 'groupId', target: '', keys: [' to ', ''] },      // incomplete → survives, keys trimmed
            { op: 'rowId', target: 'id', start: '' },               // '' start → omitted (not 0!)
            { op: 'rowId', target: 'id', start: 5 },
            { op: 'sort', key: 'a', direction: 'weird' },           // direction normalised to asc (omitted)
            { op: 'explode' },                                      // unknown op → dropped
            'junk', null,
        ])).toEqual([
            { op: 'groupId', target: '', keys: ['to'] },
            { op: 'rowId', target: 'id' },
            { op: 'rowId', target: 'id', start: 5 },
            { op: 'sort', key: 'a' },
        ]);
    });
});

describe('SettingsForm — Edit data (set)', () => {
    beforeEach(() => {
        cleanup();
        scopedStorage.setCurrentUser('set-test-user');
        try { localStorage.clear(); } catch { /* ignore */ }
    });

    it('single mode is exactly the classic form — no list chrome anywhere', () => {
        renderForm(SINGLE_STEP);
        expect(screen.getAllByText('Fields').length).toBeGreaterThan(0);
        expect(screen.queryByText('Working through')).toBeNull();
        expect(screen.queryByText('Table tools')).toBeNull();
        // forEach still offered under Advanced for single mode.
        fireEvent.click(screen.getByText('Advanced'));
        expect(screen.getByText('Run once per item')).toBeTruthy();
    });

    it('list mode summarises the source in one line, under Advanced, with the change reveal', () => {
        renderForm(LIST_STEP);
        // Not in the way of the actual work: the source lives with the other
        // overrides, one line, named — never as a raw path.
        expect(screen.queryByText('Working through')).toBeNull();
        fireEvent.click(screen.getByText('Advanced'));
        expect(screen.getByText('Working through')).toBeTruthy();
        expect(screen.getByText('gmail search')).toBeTruthy();
        expect(screen.getByText('Results')).toBeTruthy();
        expect(screen.queryByDisplayValue('steps.g.output.results')).toBeNull();
        fireEvent.click(screen.getByLabelText('Change the source list'));
        expect(editorWithValue(document.body, 'steps.g.output.results')).toBeTruthy();
    });

    it('list mode hides forEach and shows the Table tools section instead', () => {
        renderForm(LIST_STEP);
        expect(screen.getByText('Table tools')).toBeTruthy();
        fireEvent.click(screen.getByText('Advanced'));
        expect(screen.queryByText('Run once per item')).toBeNull();
    });

    it('a bound field reads as a named chip — never a raw path — with a live example', async () => {
        renderForm(LIST_STEP);
        // The `sender` field is bound to item.from_email: the value slot shows
        // the humanised chip and the value it would produce, and the path
        // itself appears nowhere on screen.
        expect(screen.getByText('Current row')).toBeTruthy();
        expect(screen.getByText('▸ From email')).toBeTruthy();
        expect(await screen.findByText(/a@b\.nl/)).toBeTruthy();
        expect(screen.queryByText(/item\.from_email/)).toBeNull();
        expect(screen.queryByText(/steps\.g\.output/)).toBeNull();
        // The slots say what they are for.
        expect(screen.getByText('Column name')).toBeTruthy();
        expect(screen.getByText('What goes in it')).toBeTruthy();
    });

    it('picking data is visual: the picker offers "Current row" and lands a chip', async () => {
        const { onPatch } = renderForm({ ...LIST_STEP, fields: { sender: { kind: 'literal', value: '' } } });
        fireEvent.click(screen.getByText('Use data from a step'));
        expect(await screen.findByText('Current row')).toBeTruthy();
        // 'Subject', not 'subject': the picker leaf reads as words now, like
        // the chip on the next line already did. What lands is unchanged — the
        // expr below is still the raw `item.subject`.
        fireEvent.click(await screen.findByText('Subject'));
        expect(screen.getByText('▸ Subject')).toBeTruthy();
        save();
        await waitFor(() => expect(onPatch).toHaveBeenCalled());
        // `item` isn't a runtime ref ROOT, so a row path lands as the expr the
        // rest of the editor writes for it (bindingFromInput owns that call).
        expect(onPatch.mock.calls[0][0].fields.sender).toEqual({ kind: 'expr', value: 'item.subject' });
    });

    it('“Adjust it” turns a picked value into a formula without anyone typing one', async () => {
        const { onPatch } = renderForm(LIST_STEP);
        // The field's own options sit under "More": a plain drag never needs them.
        fireEvent.click(screen.getAllByRole('button', { name: 'More ways to use this value' })[0]);
        fireEvent.change(screen.getByLabelText('Adjust the value'), { target: { value: 'lower' } });
        save();
        await waitFor(() => expect(onPatch).toHaveBeenCalled());
        expect(onPatch.mock.calls[0][0].fields.sender).toEqual({ kind: 'expr', value: 'lower(item.from_email)' });
    });

    it('draws the VISUAL value editor because that is the default — no flag asks for it', () => {
        // The Set editor used to pass `visualValues: true` down to
        // ToolInputForm. That flag has been the DEFAULT since the visual
        // editor became the renderer for every step-bound slot, so passing it
        // said "this surface is special" about a surface that is not — and the
        // sibling action editor already passed nothing. What has to stay true
        // is the RESULT, not the flag: both modes get ValueBuilder's own
        // controls ("Use data from a step", the "Use it as / Adjust it"
        // select) and never the raw binding box's mode toggle.
        renderForm(LIST_STEP);
        expect(screen.getAllByText(/Use data from a step|Add data/).length).toBeGreaterThan(0);
        fireEvent.click(screen.getAllByRole('button', { name: 'More ways to use this value' })[0]);
        expect(screen.getByLabelText('Adjust the value')).toBeTruthy();
        expect(screen.queryByRole('group', { name: 'Value mode' })).toBeNull();

        cleanup();
        renderForm(SINGLE_STEP);
        expect(screen.getAllByText(/Use data from a step|Add data/).length).toBeGreaterThan(0);
        expect(screen.queryByRole('group', { name: 'Value mode' })).toBeNull();
    });

    it('the raw formula editor is offered in the full view only', () => {
        renderForm(LIST_STEP);
        fireEvent.click(screen.getAllByRole('button', { name: 'More ways to use this value' })[0]);
        expect(screen.getAllByLabelText('Write this value as a formula').length).toBe(1);
    });

    it('the quick view keeps the fields and the table tools, and drops the plumbing', () => {
        renderForm(LIST_STEP, { density: 'quick' });
        // What the step DOES stays…
        expect(screen.getByText('Fields added to each row')).toBeTruthy();
        expect(screen.getByText('Table tools')).toBeTruthy();
        expect(screen.getByText('Current row')).toBeTruthy();
        // …the source it was wired to, the overrides and the formula escape go.
        expect(screen.queryByText('Working through')).toBeNull();
        expect(screen.queryByText('Advanced')).toBeNull();
        expect(screen.queryByLabelText('Write this value as a formula')).toBeNull();
    });

    it('an unpicked source still shows in the quick view — hiding it would dead-end the step', () => {
        renderForm({ ...LIST_STEP, arrayRef: '' }, { density: 'quick' });
        expect(screen.getByText('Working through')).toBeTruthy();
        expect(screen.getByText('No list picked yet')).toBeTruthy();
    });

    it('the fields section names itself once, not twice', () => {
        renderForm(LIST_STEP);
        expect(screen.getAllByText('Fields added to each row').length).toBe(1);
    });

    it('every table tool round-trips through Save with the exact operations array', async () => {
        const step = { ...LIST_STEP, operations: [] };
        const { onPatch } = renderForm(step);
        const add = () => fireEvent.click(screen.getByText('Add a table tool'));

        add(); fireEvent.click(screen.getByText('Number the rows'));
        add(); fireEvent.click(screen.getByText('Give matching rows a shared ID'));
        add(); fireEvent.click(screen.getByText('Sort the rows'));

        save();
        await waitFor(() => expect(onPatch).toHaveBeenCalled());
        const patch = onPatch.mock.calls[0][0];
        expect(patch.operations).toEqual([
            { op: 'rowId', target: 'id' },
            { op: 'groupId', target: 'groupId', keys: [] },
            { op: 'sort', key: '' },
        ]);
    });

    it('the ▲▼ chevrons reorder operations in the patch', async () => {
        const step = {
            ...LIST_STEP,
            operations: [{ op: 'rowId', target: 'id' }, { op: 'sort', key: 'id' }],
        };
        const { onPatch } = renderForm(step);
        fireEvent.click(screen.getAllByLabelText('Move operation up')[1]); // move sort above rowId
        save();
        await waitFor(() => expect(onPatch).toHaveBeenCalled());
        expect(onPatch.mock.calls[0][0].operations).toEqual([
            { op: 'sort', key: 'id' },
            { op: 'rowId', target: 'id' },
        ]);
    });

    it('the Advanced "Works on" select flips modes; leaving list mode warns about table tools', async () => {
        const { onPatch } = renderForm(LIST_STEP);
        fireEvent.click(screen.getByText('Advanced'));
        expect(screen.getByText(/also removes the table tools/)).toBeTruthy();
        fireEvent.change(screen.getByDisplayValue('Each row of a list'), { target: { value: 'single' } });
        save();
        await waitFor(() => expect(onPatch).toHaveBeenCalled());
        const patch = onPatch.mock.calls[0][0];
        expect('arrayRef' in patch).toBe(true);
        expect(patch.arrayRef).toBeUndefined();
    });

    it('a legacy forEach in list mode shows the supersession note and is cleared on save', async () => {
        const step = { ...LIST_STEP, forEach: { overRef: 'steps.g.output.results', itemVar: 'item' } };
        const { onPatch } = renderForm(step);
        fireEvent.click(screen.getByText('Advanced'));
        expect(screen.getByText(/List mode replaces/)).toBeTruthy();
        // Make the form dirty (Save is a no-op on an untouched draft), then
        // check the save carries the explicit forEach clear along.
        fireEvent.click(screen.getByText('Add a table tool'));
        fireEvent.click(screen.getByText('Sort the rows'));
        save();
        await waitFor(() => expect(onPatch).toHaveBeenCalled());
        expect(onPatch.mock.calls[0][0].forEach).toBeNull();
    });

    it('JSON text in the row offers "Pick fields from it" and a pick adds a parseJson expr field', async () => {
        const { onPatch } = renderForm(LIST_STEP);
        fireEvent.click(screen.getByText('Pick fields from it'));
        // The tree shows the parsed body of the current row: order → total.
        const total = await screen.findByText('total');
        fireEvent.click(total);
        // The new field reads as a chip in the user's words — the parseJson
        // call it actually stores is never shown as text.
        expect(screen.getByText('· from the JSON: order.total')).toBeTruthy();
        expect(screen.queryByText(/parseJson/)).toBeNull();
        save();
        await waitFor(() => expect(onPatch).toHaveBeenCalled());
        const patch = onPatch.mock.calls[0][0];
        expect(patch.fields.total).toEqual({ kind: 'expr', value: 'parseJson(item.body, "order.total")' });
    });

    it('no JSON-looking sample → the affordance stays away entirely', () => {
        const plain = [{ subject: 'hi', from_email: 'a@b.nl' }];
        renderForm(
            { ...LIST_STEP, fields: {} },
            {
                groups: [{ ...GMAIL_GROUP, sample: { results: plain }, fields: [{ key: 'results', path: 'steps.g.output.results', sample: plain }] }],
                previewSample: { steps: { g: { output: { results: plain } } } },
            },
        );
        expect(screen.queryByText('Pick fields from it')).toBeNull();
    });
});

/**
 * BFSF-363 — a source list that is SET but no longer found. Only an EMPTY
 * source used to be promoted above the fields; a broken one stayed under
 * Advanced behind a small "change" link, and in Simple mode Advanced is not
 * even there. It now sits on top, saying why, whenever the step's own run or
 * the preview shows the list is missing.
 */
describe('SettingsForm — Edit data with a source list that is not found (BFSF-363)', () => {
    beforeEach(() => {
        cleanup();
        scopedStorage.setCurrentUser('set-test-user');
        try { localStorage.clear(); } catch { /* ignore */ }
    });

    // What the runner records when the list did not resolve: a skip with its
    // sentence on `output.skipped` (the code itself is not persisted).
    const SKIPPED_RUN = {
        stepId: 's1', status: 'skipped',
        output: { items: [], count: 0, skipped: 'This step works through a list, but its source list did not resolve to one (found nothing).' },
    };
    const WARNING = /This list was not found in the latest data/;

    it('the run skipped for want of the list: on top, even when the preview does resolve it', () => {
        renderForm(LIST_STEP, { runStep: SKIPPED_RUN });
        // Visible without opening anything, named, with the reason beside it.
        expect(screen.getByText('Working through')).toBeTruthy();
        expect(screen.getByText('gmail search')).toBeTruthy();
        expect(screen.getByText(WARNING)).toBeTruthy();
        expect(screen.getByLabelText('Change the source list')).toBeTruthy();
    });

    it('a path the upstream data does not have: on top, without any run', () => {
        // The upstream step ran (its group carries real output) and no list
        // sits at the path.
        renderForm({ ...LIST_STEP, arrayRef: 'steps.g.output.messages' }, { groups: [{ ...GMAIL_GROUP, hasRealData: true }] });
        expect(screen.getByText('Working through')).toBeTruthy();
        expect(screen.getByText(WARNING)).toBeTruthy();
    });

    it('an upstream step that never ran: its design sample is no evidence, so it stays under Advanced', async () => {
        // The preview root holds a design sample for every upstream step,
        // run or not; a path that sample lacks is not a lost list.
        const user = userEvent.setup();
        renderForm({ ...LIST_STEP, arrayRef: 'steps.g.output.messages' });
        expect(screen.queryByText('Working through')).toBeNull();
        expect(screen.queryByText(WARNING)).toBeNull();
        await user.click(screen.getByText('Advanced'));
        expect(screen.getByText('Working through')).toBeTruthy();
        expect(screen.queryByText(WARNING)).toBeNull();
    });

    it('no upstream data and no run: nothing to judge, so it stays under Advanced', async () => {
        const user = userEvent.setup();
        renderForm({ ...LIST_STEP, arrayRef: 'steps.g.output.messages' }, { previewSample: null });
        expect(screen.queryByText('Working through')).toBeNull();
        expect(screen.queryByText(WARNING)).toBeNull();
        await user.click(screen.getByText('Advanced'));
        expect(screen.getByText('Working through')).toBeTruthy();
        expect(screen.queryByText(WARNING)).toBeNull();
    });

    it('a healthy source with a successful run stays under Advanced', () => {
        renderForm(LIST_STEP, { runStep: { stepId: 's1', status: 'success', output: { items: [], count: 0 } } });
        expect(screen.queryByText('Working through')).toBeNull();
    });

    it('Simple mode, where Advanced is hidden, still shows it', () => {
        renderForm(LIST_STEP, { density: 'quick', runStep: SKIPPED_RUN });
        expect(screen.queryByText('Advanced')).toBeNull();
        expect(screen.getByText('Working through')).toBeTruthy();
        expect(screen.getByText(WARNING)).toBeTruthy();
    });

    it('is shown once: not again under Advanced', async () => {
        const user = userEvent.setup();
        renderForm(LIST_STEP, { runStep: SKIPPED_RUN });
        await user.click(screen.getByText('Advanced'));
        expect(screen.getAllByText('Working through').length).toBe(1);
    });
});
