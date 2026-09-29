import { screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';

// NDV fetches the tool catalog on mount — stub the API.
const { api } = vi.hoisted(() => ({
    api: { getCatalog: vi.fn().mockResolvedValue({ apps: [], triggerOutputs: {} }) },
}));
vi.mock('../../../hooks/useAutomationApi', () => ({ default: () => api }));

import {
    AI_STEP as step, AI_DEFINITION as definition, aiStepProps as baseProps, renderInQueryClient as render,
} from './ndv/ndvTestProps';
import NodeDetailView from './NodeDetailView';

/**
 * The hand-written-output sheet, as a FIELD LIST.
 *
 * The sheet used to be one raw textarea: the only screen in the Builder where
 * a non-programmer was asked to type a brace, kept that way by a comment
 * saying the contract had been copied from SettingsTab's JSON row on purpose.
 * The CONTRACT is not what was wrong with it — no commit per keystroke, one
 * parse on an explicit Save, the 64 KB cap before the PUT — and every one of
 * those is asserted still standing below, including through the new face.
 * What changed is the INPUT METHOD: a pinned output is a handful of fields or
 * a couple of sample records, so that is what the author now edits, with the
 * raw editor demoted to a disclosure rather than deleted.
 *
 * Run against the OLD sheet, everything in the first three describes fails on
 * a missing `ndv-output-fields`/`ndv-output-field`; "the raw editor survives"
 * and "the cap survives" pass there, which is the point of having them.
 */

const withPin = (pinnedOutput) => {
    const pinned = { ...step, pinnedOutput, pinnedAt: 'now', pinnedSource: 'edited' };
    return { step: pinned, definition: { ...definition, steps: [pinned] } };
};

/** Mount with a pinned output and open the sheet on it. */
const openOn = (pinnedOutput, onSaveStep = vi.fn().mockResolvedValue(undefined)) => {
    const { step: pinned, definition: def } = withPin(pinnedOutput);
    render(<NodeDetailView {...baseProps({ step: pinned, definition: def, rootDefinition: def, onSaveStep })} />);
    fireEvent.click(screen.getByTestId('ndv-edit-output'));
    return onSaveStep;
};

const textarea = () => screen.getByLabelText('Output JSON');
const save = () => fireEvent.click(screen.getByText('Save output'));
// What the NDV saves is the whole next DEFINITION, not the patch.
const savedOutput = (onSaveStep) => onSaveStep.mock.calls.at(-1)[0].steps[0].pinnedOutput;
const rows = () => screen.getAllByTestId('ndv-output-field');

beforeEach(() => { cleanup(); try { localStorage.clear(); } catch { /* ignore */ } });

describe('NodeDetailView — the output sheet opens on fields, not on JSON text', () => {
    it('shows a named row per field, with the raw editor closed behind a disclosure', () => {
        openOn({ subject: 'Hi', id: 7 });

        expect(screen.getByTestId('ndv-output-fields')).toBeTruthy();
        expect(rows()).toHaveLength(2);
        // The raw editor is DEMOTED, not deleted: still exactly one textarea,
        // still carrying the text, but behind a closed disclosure.
        expect(screen.getByTestId('ndv-output-raw-toggle').getAttribute('aria-expanded')).toBe('false');
        expect(JSON.parse(textarea().value)).toEqual({ subject: 'Hi', id: 7 });
    });

    it('names each value control after its field, and its kind in the tree\'s words', () => {
        openOn({ subject: 'Hi', id: 7, urgent: true });

        expect(screen.getByLabelText('subject value').value).toBe('Hi');
        expect(screen.getByLabelText('id value').value).toBe('7');
        // Not "string / integer / boolean" anywhere the author looks — the
        // words are mapping/fieldKinds.js's, the ones the variable tree shows
        // for the very same data one column to the left.
        const kinds = screen.getAllByTestId('ndv-field-kind').map(el => el.selectedOptions[0].textContent);
        expect(kinds).toEqual(['text', 'number', 'yes/no']);
    });

    it('opens a step that returns ONE value on one box, not on a quoted string', () => {
        // The commonest seed in the drawer: an AI step with no declared output
        // fields describes itself as the single string "<AI response>". On the
        // raw editor that is a pair of quotes the author has to type inside and
        // must not delete.
        render(<NodeDetailView {...baseProps()} />);
        fireEvent.click(screen.getByTestId('ndv-edit-output'));

        expect(screen.getByTestId('ndv-output-fields')).toBeTruthy();
        expect(screen.getByLabelText('Value').value).toBe('<AI response>');
        // No name box, no "Add field": one value has neither.
        expect(screen.queryByLabelText('Name')).toBeNull();
        expect(screen.queryByTestId('ndv-add-field')).toBeNull();
        expect(textarea().value).toBe('"<AI response>"');
    });

    it('saves that one value as the scalar it is', async () => {
        const onSaveStep = vi.fn().mockResolvedValue(undefined);
        render(<NodeDetailView {...baseProps({ onSaveStep })} />);
        fireEvent.click(screen.getByTestId('ndv-edit-output'));
        fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'Dear Ada,' } });
        save();

        await waitFor(() => expect(onSaveStep).toHaveBeenCalledTimes(1));
        expect(savedOutput(onSaveStep)).toBe('Dear Ada,');
    });

    it('seeds a never-run step from the shape the pickers already promise', () => {
        // The seed is describeNode's, so the field names in this sheet are the
        // ones every picker downstream already offers for this step. Nothing
        // has run; there is still something to edit.
        const declared = { ...step, outputSchema: { summary: 'text', total: 'number' } };
        const def = { ...definition, steps: [declared] };
        render(<NodeDetailView {...baseProps({ step: declared, definition: def, rootDefinition: def })} />);
        fireEvent.click(screen.getByTestId('ndv-edit-output'));

        expect(screen.getAllByLabelText('Name').map(el => el.value)).toEqual(['summary', 'total']);
        expect(screen.getByTestId('ndv-add-field')).toBeTruthy();
    });
});

describe('NodeDetailView — editing fields writes the JSON the author never typed', () => {
    it('saves a changed value, and leaves the other fields and their types alone', async () => {
        const onSaveStep = openOn({ subject: 'Hi', id: 7 });

        fireEvent.change(screen.getByLabelText('subject value'), { target: { value: 'Invoice 42' } });
        save();

        await waitFor(() => expect(onSaveStep).toHaveBeenCalledTimes(1));
        // `id` must still be the NUMBER 7. A field list that round-tripped
        // every value through its text box would hand the steps downstream a
        // string, and a condition on it would quietly stop matching.
        expect(savedOutput(onSaveStep)).toEqual({ subject: 'Invoice 42', id: 7 });
        expect(onSaveStep.mock.calls.at(-1)[0].steps[0].pinnedSource).toBe('edited');
    });

    it('adds a field, and writes nothing for it until it has a name', async () => {
        const onSaveStep = openOn({ subject: 'Hi' });

        fireEvent.click(screen.getByTestId('ndv-add-field'));
        expect(rows()).toHaveLength(2);
        // Unnamed: it is on screen, and it is not in the JSON.
        expect(JSON.parse(textarea().value)).toEqual({ subject: 'Hi' });

        const fresh = rows()[1];
        fireEvent.change(within(fresh).getByLabelText('Name'), { target: { value: 'amount' } });
        fireEvent.change(within(rows()[1]).getByLabelText('amount value'), { target: { value: '19.5' } });
        fireEvent.change(within(rows()[1]).getByLabelText('Type'), { target: { value: 'number' } });
        save();

        await waitFor(() => expect(onSaveStep).toHaveBeenCalledTimes(1));
        expect(savedOutput(onSaveStep)).toEqual({ subject: 'Hi', amount: 19.5 });
    });

    it('removes a field', async () => {
        const onSaveStep = openOn({ subject: 'Hi', id: 7 });
        fireEvent.click(within(rows()[1]).getByLabelText('Remove'));
        save();
        await waitFor(() => expect(onSaveStep).toHaveBeenCalledTimes(1));
        expect(savedOutput(onSaveStep)).toEqual({ subject: 'Hi' });
    });

    it('keeps a half-typed number on screen while it is still half-typed', () => {
        // `1.` serialises to `1`. A draft rebuilt from the text on every
        // keystroke would put "1" back in the box and delete the dot the author
        // just typed — so the row keeps its own typing buffer.
        openOn({ amount: 1 });
        fireEvent.change(screen.getByLabelText('amount value'), { target: { value: '1.' } });
        expect(screen.getByLabelText('amount value').value).toBe('1.');
        fireEvent.change(screen.getByLabelText('amount value'), { target: { value: '1.5' } });
        expect(JSON.parse(textarea().value)).toEqual({ amount: 1.5 });
    });

    it('switches a value to yes/no with a picker, not with the word "true"', async () => {
        const onSaveStep = openOn({ urgent: 'yes' });
        fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'yesno' } });
        fireEvent.change(screen.getByLabelText('urgent value'), { target: { value: 'false' } });
        save();
        await waitFor(() => expect(onSaveStep).toHaveBeenCalledTimes(1));
        expect(savedOutput(onSaveStep)).toEqual({ urgent: false });
    });

    it('shows a nested value as what it is, and never flattens it into a text box', async () => {
        const onSaveStep = openOn({ subject: 'Hi', sender: { name: 'Ada', email: 'ada@example.org' } });

        // "[object Object]" in a text box, saved, is a data loss one click
        // away. The group is shown and left alone; the raw editor below is
        // where it gets edited.
        expect(screen.getByTestId('ndv-field-nested').textContent).toContain('Ada');
        expect(screen.getAllByTestId('ndv-field-kind').map(el => el.value ?? el.textContent)).toEqual(['text', 'group']);

        fireEvent.change(screen.getByLabelText('subject value'), { target: { value: 'Bye' } });
        save();
        await waitFor(() => expect(onSaveStep).toHaveBeenCalledTimes(1));
        expect(savedOutput(onSaveStep)).toEqual({ subject: 'Bye', sender: { name: 'Ada', email: 'ada@example.org' } });
    });
});

describe('NodeDetailView — a list of records edits as records', () => {
    it('gives each record its own block, and saves the list as a list', async () => {
        const onSaveStep = openOn([{ name: 'Ada', seats: 2 }, { name: 'Alan', seats: 1 }]);

        expect(screen.getAllByTestId('ndv-record-no').map(el => el.textContent)).toEqual(['#1', '#2']);
        const second = screen.getAllByTestId('ndv-output-field')[2]; // record #2, first field
        fireEvent.change(within(second).getByLabelText('name value'), { target: { value: 'Grace' } });
        save();

        await waitFor(() => expect(onSaveStep).toHaveBeenCalledTimes(1));
        expect(savedOutput(onSaveStep)).toEqual([{ name: 'Ada', seats: 2 }, { name: 'Grace', seats: 1 }]);
    });

    it('adds a record with the fields the first one already has', async () => {
        const onSaveStep = openOn([{ name: 'Ada', seats: 2 }]);
        fireEvent.click(screen.getByTestId('ndv-add-record'));
        expect(screen.getAllByTestId('ndv-record-no')).toHaveLength(2);
        save();
        await waitFor(() => expect(onSaveStep).toHaveBeenCalledTimes(1));
        expect(savedOutput(onSaveStep)).toEqual([{ name: 'Ada', seats: 2 }, { name: '', seats: '' }]);
    });
});

describe('NodeDetailView — the raw editor survives as the escape hatch', () => {
    it('opens on ask, and what is typed there still saves', async () => {
        const onSaveStep = openOn({ subject: 'Hi' });

        fireEvent.click(screen.getByTestId('ndv-output-raw-toggle'));
        expect(screen.getByTestId('ndv-output-raw-toggle').getAttribute('aria-expanded')).toBe('true');
        fireEvent.change(textarea(), { target: { value: '{"subject":"Hi","cc":["a@b.c"]}' } });
        save();

        await waitFor(() => expect(onSaveStep).toHaveBeenCalledTimes(1));
        expect(savedOutput(onSaveStep)).toEqual({ subject: 'Hi', cc: ['a@b.c'] });
    });

    it('feeds the field list back from the raw text', () => {
        openOn({ subject: 'Hi' });
        fireEvent.click(screen.getByTestId('ndv-output-raw-toggle'));
        fireEvent.change(textarea(), { target: { value: '{"subject":"Hi","id":7}' } });
        expect(rows()).toHaveLength(2);
        expect(screen.getByLabelText('id value').value).toBe('7');
    });

    it('IS the sheet for a shape a field list cannot honestly show', () => {
        // A list of strings has no field names to show, and inventing some
        // would save something other than what the author saw.
        openOn(['a@b.c', 'd@e.f']);
        expect(screen.queryByTestId('ndv-output-fields')).toBeNull();
        expect(screen.queryByTestId('ndv-output-raw-toggle')).toBeNull();
        expect(JSON.parse(textarea().value)).toEqual(['a@b.c', 'd@e.f']);
    });
});

describe('NodeDetailView — the 64 KB cap still stands in front of the PUT', () => {
    it('refuses an oversized value typed into a FIELD, before any save', () => {
        // Load-bearing, and the reason the cap is not a style choice: the
        // inspector PUTs the WHOLE definition on every save, so one oversized
        // pin 400s every later, unrelated edit to this routine and the
        // failed-patch retry walks straight back into it. A friendlier input
        // method must not become a way around it.
        const onSaveStep = openOn({ body: 'x' });
        fireEvent.change(screen.getByLabelText('body value'), { target: { value: 'x'.repeat(70_000) } });
        save();

        expect(screen.getByRole('alert').textContent).toMatch(/Too big to save/);
        expect(onSaveStep).not.toHaveBeenCalled();
    });

    it('still refuses the truncation sentinel built out of fields', () => {
        const onSaveStep = openOn({ __truncated__: true });
        save();
        expect(screen.getByRole('alert').textContent).toMatch(/placeholder, not data/);
        expect(onSaveStep).not.toHaveBeenCalled();
    });
});
