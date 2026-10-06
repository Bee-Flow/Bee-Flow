import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FormDensityContext } from './settings/formDensity';
import SettingsForm from './SettingsForm';
import { editorWithValue } from '../../../../test/refEditor';
import scopedStorage from '../../../../utils/scopedStorage';
import { VariablePickerProvider } from '../mapping/VariablePickerContext';

/**
 * The unified Filter form: If / Switch / Filter are ONE editor, the runtime
 * step type follows the shape the user describes, and the technical surface
 * (mode override, raw source path, generated expression) lives under Advanced.
 */

const noIssues = { errors: [], warnings: [] };

const GMAIL_GROUP = {
    id: 'g', label: 'gmail search', kind: 'integration_action', basePath: 'steps.g.output',
    sample: { results: [{ subject: 'Nextcloud ISV contract', from_email: 'a@b.nl' }] },
    fields: [{ key: 'results', path: 'steps.g.output.results', sample: [{ subject: 'Nextcloud ISV contract', from_email: 'a@b.nl' }] }],
};
const SAMPLE_ROOT = { steps: { g: { output: { results: [{ subject: 'Nextcloud ISV contract', from_email: 'a@b.nl' }] } } } };

function renderForm(step, { onPatch = vi.fn(), groups = [GMAIL_GROUP], previewSample = SAMPLE_ROOT, wiredCaseNames = null, density = undefined } = {}) {
    render(
        <FormDensityContext.Provider value={{ density: density || 'full', onHiddenSection: null }}>
        <VariablePickerProvider groups={groups} previewSample={previewSample} stepLabelById={new Map()}>
            <SettingsForm
                step={step} modelTiers={{}} stepIssues={noIssues} saving={false} saveError={null}
                onPatch={onPatch} catalog={null} groups={groups} previewSample={previewSample}
                wiredCaseNames={wiredCaseNames}
            />
        </VariablePickerProvider>
        </FormDensityContext.Provider>,
    );
    return { onPatch };
}

const save = () => fireEvent.click(screen.getByText('Save'));
// Advanced is a mode now (the header's switch), not a button: its settings show in the full view.
const openAdvanced = () => {};

describe('SettingsForm — Filter (unified If/Switch/Filter)', () => {
    beforeEach(() => {
        cleanup();
        scopedStorage.setCurrentUser('route-test-user');
        try { localStorage.clear(); } catch { /* ignore */ }
    });

    const IF_STEP = { id: 'r1', type: 'condition', expr: 'trigger.output.amount > 100' };
    const FILTER_STEP = { id: 'f1', type: 'filter', arrayRef: 'steps.g.output.results', expr: 'contains(item.subject, "isv")' };

    it('keeps the mode out of the main form — it lives under Advanced', () => {
        renderForm(IF_STEP);
        expect(screen.queryByText('What is this step deciding about?')).toBeNull();
        openAdvanced();
        expect(screen.getByText('Deciding about')).toBeTruthy();
        expect(screen.getByDisplayValue('The whole run')).toBeTruthy();
    });

    it('never shows a raw path or a compiled expression in the main form', () => {
        renderForm(FILTER_STEP, { density: 'quick' });
        // The field reads as a name, not `item.subject`.
        expect(screen.getByText('Subject')).toBeTruthy();
        expect(screen.queryByText('item.subject')).toBeNull();
        expect(screen.queryByText('contains(item.subject, "isv")')).toBeNull();
        // …but it IS available for the curious, in the Advanced mode.
        cleanup();
        renderForm(FILTER_STEP);
        expect(screen.getByText('contains(item.subject, "isv")')).toBeTruthy();
    });

    it('summarises the detected source list in one line instead of a form field', () => {
        renderForm(FILTER_STEP);
        expect(screen.getByText('Working through')).toBeTruthy();
        expect(screen.getByText('gmail search')).toBeTruthy();
        expect(screen.getByText('Results')).toBeTruthy();
        expect(screen.getAllByText(/1 item/).length).toBeGreaterThan(0);
        // The raw picker is one click away, not on screen by default.
        expect(screen.queryByDisplayValue('steps.g.output.results')).toBeNull();
        fireEvent.click(screen.getByText('change'));
        expect(editorWithValue(document.body, 'steps.g.output.results')).toBeTruthy();
    });

    it('offers the item\'s fields by name in the rule row', () => {
        renderForm(FILTER_STEP);
        fireEvent.click(screen.getByText('Subject'));
        const list = screen.getByPlaceholderText('Search fields…').closest('div').parentElement;
        expect(within(list).getByText('From email')).toBeTruthy();
    });

    it('has no "items that match no rule" setting — a second rule is what adds the output', async () => {
        const { onPatch } = renderForm(FILTER_STEP);
        openAdvanced();
        expect(screen.queryByText('Items that match no rule')).toBeNull();

        fireEvent.click(screen.getByText('Add output'));
        save();
        await waitFor(() => expect(onPatch).toHaveBeenCalled());
        const patch = onPatch.mock.calls[0][0];
        expect(patch.type).toBe('switch');
        expect(patch.cases).toHaveLength(2);
    });

    it('adding a second rule to an If turns the step into a switch on save', async () => {
        const { onPatch } = renderForm(IF_STEP);
        fireEvent.click(screen.getByText('Add output'));
        save();
        await waitFor(() => expect(onPatch).toHaveBeenCalled());
        const patch = onPatch.mock.calls[0][0];
        expect(patch.type).toBe('switch');
        // O3: the If's internal first name becomes "Output 1" once it is a port.
        expect(patch.cases[0]).toEqual({ name: 'Output 1', expr: IF_STEP.expr });
        expect(patch.cases[1]).toEqual({ name: 'Output 2', expr: '' });
    });

    it('the Advanced mode override still flips the runtime type', async () => {
        const { onPatch } = renderForm(IF_STEP);
        openAdvanced();
        fireEvent.change(screen.getByDisplayValue('The whole run'), { target: { value: 'items' } });
        save();
        await waitFor(() => expect(onPatch).toHaveBeenCalled());
        const patch = onPatch.mock.calls[0][0];
        expect(patch.type).toBe('filter');
        expect(patch.arrayRef).toBe('');
        expect('expr' in patch).toBe(false); // carried over unchanged, never cleared
    });

    it('removing a rule from a two-rule switch collapses it back to an If', async () => {
        const step = {
            id: 's1', type: 'switch',
            cases: [{ name: 'big', expr: 'a > 10' }, { name: 'small', expr: 'a <= 10' }],
        };
        const { onPatch } = renderForm(step);
        fireEvent.click(screen.getAllByTitle(/Remove output/)[1]);
        save();
        await waitFor(() => expect(onPatch).toHaveBeenCalled());
        const patch = onPatch.mock.calls[0][0];
        expect(patch.type).toBe('condition');
        expect(patch.expr).toBe('a > 10');
        expect(patch.cases).toBeUndefined();
    });

    it('tells the user that text comparisons ignore case', () => {
        renderForm(IF_STEP);
        expect(screen.getByText(/ignore upper\/lower case/)).toBeTruthy();
    });
});

/**
 * BFSF-356 — the number of outputs is an UP-FRONT choice.
 *
 * "+ Add rule" used to flip the node into an undocumented routing mode with a
 * "Value to check" expression and per-rule "value to match", and nothing in the
 * UI said so. One Condition node still covers both jobs (the palette stays
 * short), but which job it is doing is now stated before anything else — and
 * because there is no documentation for this node anywhere, the editor is also
 * where the shape has to be explained.
 */
describe('SettingsForm — Filter: how many outputs (BFSF-356)', () => {
    beforeEach(() => {
        cleanup();
        scopedStorage.setCurrentUser('route-test-user');
        try { localStorage.clear(); } catch { /* ignore */ }
    });

    const IF_STEP = { id: 'r1', type: 'condition', expr: 'trigger.output.amount > 100' };
    const TWO_OUTPUT_SWITCH = {
        id: 's1', type: 'switch',
        cases: [{ name: 'big', expr: 'a > 10' }, { name: 'small', expr: 'a <= 10' }],
    };

    const chooser = () => screen.getByText('How many outputs does this node have?');

    it('asks the question first, and keeps a running count', () => {
        renderForm(IF_STEP);
        expect(chooser()).toBeTruthy();
        // O1: the shared SegmentedControl — a radio group, the selected option checked.
        expect(screen.getByRole('radiogroup', { name: 'Number of outputs' })).toBeTruthy();
        expect(screen.getByRole('radio', { name: 'One output' }).getAttribute('aria-checked')).toBe('true');
        expect(screen.getByRole('radio', { name: 'Several outputs' }).getAttribute('aria-checked')).toBe('false');
        // A whole-run Condition: one output, and its else port as “Otherwise”.
        expect(screen.getByText('This node has 1 output plus “Otherwise”.')).toBeTruthy();
    });

    it('explains what an output IS — there is no documentation for this node anywhere', async () => {
        renderForm(IF_STEP);
        // Said where it applies: with one output there is no Output 2.
        expect(screen.queryByText(/Each output is a filter with its own destination/)).toBeNull();
        await userEvent.click(screen.getByRole('radio', { name: 'Several outputs' }));
        expect(screen.getByText(/Each output is a filter with its own destination/)).toBeTruthy();
        expect(screen.getByText(/Output 1: Subject contains urgent/)).toBeTruthy();
    });

    it('"Several outputs" grows the node and labels every output', async () => {
        const { onPatch } = renderForm(IF_STEP);
        await userEvent.click(screen.getByRole('radio', { name: 'Several outputs' }));
        expect(screen.getByText('This node has 2 outputs.')).toBeTruthy();
        // O3: "Output 1", "Output 2" (the Advanced "When nothing matches" menu names them too).
        expect(screen.getByText('Output 1', { selector: 'div' })).toBeTruthy();
        expect(screen.getByText('Output 2', { selector: 'div' })).toBeTruthy();
        // "+ Add output" grows the list further.
        fireEvent.click(screen.getByText('Add output'));
        expect(screen.getByText('This node has 3 outputs.')).toBeTruthy();

        save();
        await waitFor(() => expect(onPatch).toHaveBeenCalled());
        expect(onPatch.mock.calls[0][0].cases).toHaveLength(3);
    });

    it('tells one story about what matches no output (O2)', async () => {
        renderForm(IF_STEP);
        // A whole-run Condition decides for the run: then, or “Otherwise”.
        expect(screen.getByText('When the rule holds, the run continues; when it doesn’t, the run goes to “Otherwise”; leave “Otherwise” unconnected to stop it there.')).toBeTruthy();
        expect(screen.queryByText(/the rest stops here/)).toBeNull();
        await userEvent.click(screen.getByRole('radio', { name: 'Several outputs' }));
        expect(screen.getByText(/Each output is checked on its own, so one item can go down several outputs\. What matches no output goes to “Otherwise”; leave “Otherwise” unconnected to drop it\./)).toBeTruthy();
        expect(screen.queryByText(/counted as rejected/)).toBeNull();
    });

    it('states the canvas consequences of growing and shrinking the list', () => {
        renderForm(TWO_OUTPUT_SWITCH);
        expect(screen.getByText(/an output that keeps its name keeps its connection/)).toBeTruthy();
        expect(screen.getByText(/disappears takes its connection with it/)).toBeTruthy();
    });

    it('collapsing to one output NAMES the wired outputs it would cost, and waits', async () => {
        const { onPatch } = renderForm(TWO_OUTPUT_SWITCH, { wiredCaseNames: new Set(['big', 'small']) });
        await userEvent.click(screen.getByRole('radio', { name: 'One output' }));
        // Nothing has changed yet — the node still has both outputs.
        expect(screen.getByText('This node has 2 outputs.')).toBeTruthy();
        expect(screen.getByText(/Going back to one output removes/)).toBeTruthy();
        expect(screen.getByText(/Output 2 \(small\)/)).toBeTruthy();
        // Output 1 survives a collapse, so it is not listed as a casualty.
        expect(screen.queryByText(/Output 1 \(big\)/)).toBeNull();

        // Backing out leaves the node exactly as it was.
        fireEvent.click(screen.getByText('Keep several outputs'));
        expect(screen.queryByText(/Going back to one output removes/)).toBeNull();
        expect(screen.getByText('This node has 2 outputs.')).toBeTruthy();

        // Confirming does what it said it would.
        await userEvent.click(screen.getByRole('radio', { name: 'One output' }));
        fireEvent.click(screen.getByText('Remove them anyway'));
        expect(screen.getByText('This node has 1 output plus “Otherwise”.')).toBeTruthy();
        save();
        await waitFor(() => expect(onPatch).toHaveBeenCalled());
        const patch = onPatch.mock.calls[0][0];
        expect(patch.type).toBe('condition');
        expect(patch.expr).toBe('a > 10');
    });

    it('collapsing costs nothing when the extra outputs are unwired — no warning, no click', async () => {
        renderForm(TWO_OUTPUT_SWITCH, { wiredCaseNames: new Set(['big']) });
        await userEvent.click(screen.getByRole('radio', { name: 'One output' }));
        expect(screen.queryByText(/Going back to one output removes/)).toBeNull();
        expect(screen.getByText('This node has 1 output plus “Otherwise”.')).toBeTruthy();
    });
});

/**
 * BFSF-356 — the fan-out opt-in, from the editor's side.
 *
 * Outputs are meant to be non-exclusive, but every switch already in a
 * customer database was evaluated first-match-wins. Opting one in has to be a
 * deliberate act, or those routers start sending duplicate mails/tickets/API
 * writes for customers who changed nothing.
 */
describe('SettingsForm — Filter: fan-out is opt-in per node (BFSF-356)', () => {
    beforeEach(() => {
        cleanup();
        scopedStorage.setCurrentUser('route-test-user');
        try { localStorage.clear(); } catch { /* ignore */ }
    });

    const IF_STEP = { id: 'r1', type: 'condition', expr: 'trigger.output.amount > 100' };
    const STORED_ROUTER = {
        id: 's1', type: 'switch',
        cases: [{ name: 'big', expr: 'a > 10' }, { name: 'small', expr: 'a <= 10' }],
    };

    it('a router BUILT here fans out — that is the semantic the ticket describes', async () => {
        const { onPatch } = renderForm(IF_STEP);
        await userEvent.click(screen.getByRole('radio', { name: 'Several outputs' }));
        save();
        await waitFor(() => expect(onPatch).toHaveBeenCalled());
        expect(onPatch.mock.calls[0][0].matchMode).toBe('all');
    });

    it('adding a THIRD output to a stored router does not opt it in', async () => {
        const { onPatch } = renderForm(STORED_ROUTER);
        fireEvent.click(screen.getByText('Add output'));
        save();
        await waitFor(() => expect(onPatch).toHaveBeenCalled());
        const patch = onPatch.mock.calls[0][0];
        expect(patch.cases).toHaveLength(3);
        expect(patch.matchMode).toBeUndefined();
    });

    it('reads the stored choice back and lets Advanced change it in both directions', async () => {
        const { onPatch } = renderForm({ ...STORED_ROUTER, matchMode: 'all' });
        openAdvanced();
        expect(screen.getByDisplayValue('Send it to every matching output')).toBeTruthy();
        fireEvent.change(screen.getByDisplayValue('Send it to every matching output'), { target: { value: 'first' } });
        save();
        await waitFor(() => expect(onPatch).toHaveBeenCalled());
        // Turning it off CLEARS the key rather than pinning 'first' forever.
        expect(onPatch.mock.calls[0][0].matchMode).toBeUndefined();
    });

    it('a stored first-match router can be opted in on purpose', async () => {
        const { onPatch } = renderForm(STORED_ROUTER);
        openAdvanced();
        const select = screen.getByDisplayValue('Send it to the first matching output only');
        fireEvent.change(select, { target: { value: 'all' } });
        save();
        await waitFor(() => expect(onPatch).toHaveBeenCalled());
        expect(onPatch.mock.calls[0][0].matchMode).toBe('all');
    });

    it('a one-output node has no fan-out choice to make', () => {
        renderForm(IF_STEP);
        openAdvanced();
        expect(screen.queryByText('When several outputs match')).toBeNull();
    });
});
