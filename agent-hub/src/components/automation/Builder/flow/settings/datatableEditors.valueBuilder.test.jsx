import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import DatatableFields from './datatableEditors';
import { VariablePickerProvider } from '../../mapping/VariablePickerContext';

/**
 * The datatable step's two value slots now render the VISUAL editor, and —
 * the part that matters — each one says what it wants from the COLUMN and the
 * OPERATOR rather than assuming.
 *
 * Both directions are failures, and both are silent:
 *   claiming too little — a list bound into a `text` column goes in as
 *   "[object Object]" and nobody is asked;
 *   claiming too much — asking "this wants one value, what did you mean?"
 *   about `is one of`, whose right-hand side really is a list, teaches the
 *   author to click past the question that matters.
 */
const ADDRESSES = ['a@b.nl', 'c@d.nl'];
const SAMPLE = { steps: { s1: { output: { addresses: ADDRESSES, name: 'Ada' } } } };
const GROUPS = [{
    id: 's1', label: 'gmail search', kind: 'integration_action',
    basePath: 'steps.s1.output', sample: SAMPLE.steps.s1.output,
    fields: [
        { key: 'addresses', path: 'steps.s1.output.addresses', sample: ADDRESSES },
        { key: 'name', path: 'steps.s1.output.name', sample: 'Ada' },
    ],
}];
const CATALOG = {
    datatables: [{
        id: 'tbl1', name: 'Contacts',
        columns: [
            { key: 'name', name: 'Name', type: 'text' },
            { key: 'tags', name: 'Tags', type: 'multiselect' },
            { key: 'status', name: 'Status', type: 'select' },
        ],
    }],
    datatableOps: [],
};

function renderFields(draft) {
    const set = vi.fn();
    const focus = { current: [] };
    render(
        <VariablePickerProvider groups={GROUPS} previewSample={SAMPLE} stepLabelById={new Map([['s1', 'gmail search']])}>
            <DatatableFields
                draft={draft} set={set} groups={GROUPS}
                previewSample={SAMPLE} catalog={CATALOG}
                onFocusField={(h) => { focus.current = [...focus.current.filter(x => x.label !== h.label), h]; }}
            />
        </VariablePickerProvider>,
    );
    const insertInto = (label, path, opts) => {
        const box = screen.getByLabelText(label);
        fireEvent.focus(box);
        const handle = focus.current.find(h => h.label === label);
        expect(handle, `no insert handle published for "${label}"`).toBeTruthy();
        act(() => { handle.insert(path, opts); });
    };
    return { set, insertInto };
}

const writeDraft = () => ({ datatableId: 'tbl1', op: 'insert_row', values: {} });
const whereDraft = (op) => ({ datatableId: 'tbl1', op: 'update_rows', values: {}, where: [{ field: 'name', op, value: '' }] });

describe('the datatable step writes values through the visual editor', () => {
    beforeEach(cleanup);

    it('renders a labelled slot per column, not a raw binding box', () => {
        renderFields(writeDraft());
        expect(screen.getByLabelText('Name')).toBeTruthy();
        expect(screen.getByLabelText('Tags')).toBeTruthy();
    });

    it('answers a list in a TEXT column without asking, and shows the other answers under the field', () => {
        const { insertInto } = renderFields(writeDraft());
        insertInto('Name', 'steps.s1.output.addresses');
        // Answered at once; the other answers show under the field (Advanced).
        expect(screen.getByTestId('mismatch-resolver')).toBeTruthy();
    });

    it('asks nothing when the same list lands in a MULTISELECT column', () => {
        // The column declares that it holds several values. Asking here would
        // be a question with no right answer.
        const { insertInto } = renderFields(writeDraft());
        insertInto('Tags', 'steps.s1.output.addresses');
        expect(document.querySelector('[data-list-pick-chooser]')).toBeNull();
        expect(screen.queryByTestId('mismatch-resolver')).toBeNull();
    });

    it('asks nothing when a single value lands in a text column', () => {
        const { insertInto } = renderFields(writeDraft());
        insertInto('Name', 'steps.s1.output.name');
        expect(document.querySelector('[data-list-pick-chooser]')).toBeNull();
    });
});

describe('the datatable filter asks per OPERATOR, not per slot', () => {
    beforeEach(cleanup);

    it('treats a list on "is" as a mismatch — that comparison takes one value — and answers it quietly', () => {
        const { insertInto } = renderFields(whereDraft('eq'));
        insertInto('Value', 'steps.s1.output.addresses');
        // Answered at once; the other answers show under the field (Advanced).
        expect(screen.getByTestId('mismatch-resolver')).toBeTruthy();
    });

    it('stays quiet on "is one of" — that comparison IS a list', () => {
        const { insertInto } = renderFields(whereDraft('in'));
        insertInto('Value', 'steps.s1.output.addresses');
        expect(document.querySelector('[data-list-pick-chooser]')).toBeNull();
        expect(screen.queryByTestId('mismatch-resolver')).toBeNull();
    });

    it('stays quiet on "is none of" — the operator the OTHER copies of this list forget', () => {
        // `notIn` is where a hand-rolled operator set drifts: the BI filter
        // editor's own copy says {in, between} and leaves it out, which would
        // pop the "this wants one value" question on a filter that is right.
        // The panel asks the SHARED helper (opTakesList) instead of keeping a
        // list of its own, and this case is what pins that.
        const { insertInto } = renderFields(whereDraft('notIn'));
        insertInto('Value', 'steps.s1.output.addresses');
        expect(document.querySelector('[data-list-pick-chooser]')).toBeNull();
        expect(screen.queryByTestId('mismatch-resolver')).toBeNull();
    });

    it('stays quiet on "is between" too', () => {
        const { insertInto } = renderFields(whereDraft('between'));
        insertInto('Value', 'steps.s1.output.addresses');
        expect(document.querySelector('[data-list-pick-chooser]')).toBeNull();
    });

    it('drops the value slot entirely on "is empty" — the row IS the condition', () => {
        // The same shared source (opTakesNoValue) decides this; a slot here
        // would invite a value that the filter then ignores.
        renderFields(whereDraft('isNull'));
        expect(screen.queryByLabelText('Value')).toBeNull();
        cleanup();
        renderFields(whereDraft('eq'));
        expect(screen.getByLabelText('Value')).toBeTruthy();
    });
});
