import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import DatatableFields from './datatableEditors';
import { VariablePickerProvider } from '../../mapping/VariablePickerContext';

/**
 * The datatable step's two value slots render the value slot, and — the part
 * that matters — each one says what it wants from the COLUMN and the
 * OPERATOR rather than assuming. What a picked list becomes is decided from
 * that once, at pick time, and stored with the pick:
 *
 *   a list into a `text` column is readable text ("Comes as text: …"), never
 *   "[object Object]" and never JSON;
 *   a list into `is one of` (or a multiselect column) stays a list: that
 *   comparison really is one, so nothing is turned into text there.
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
    // The last value the step wrote into a column / the filter's value.
    const lastValue = (key) => set.mock.calls.filter(([k]) => k === 'values').at(-1)?.[1]?.[key];
    const lastWhere = () => set.mock.calls.filter(([k]) => k === 'where').at(-1)?.[1]?.[0]?.value;
    const insertInto = (label, path, opts) => {
        const box = screen.getByLabelText(label);
        fireEvent.focus(box);
        const handle = focus.current.find(h => h.label === label);
        expect(handle, `no insert handle published for "${label}"`).toBeTruthy();
        act(() => { handle.insert(path, opts); });
    };
    return { set, insertInto, lastValue, lastWhere };
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

    it('a list into a TEXT column becomes readable text, said in one sentence', () => {
        const { insertInto, lastValue } = renderFields(writeDraft());
        insertInto('Name', 'steps.s1.output.addresses');
        expect(lastValue('name')).toMatchObject({ kind: 'pick', v: 1, take: 'all', as: 'text' });
    });

    it('the same list into a MULTISELECT column stays a list', () => {
        // The column declares that it holds several values: nothing to turn into text.
        const { insertInto, lastValue } = renderFields(writeDraft());
        insertInto('Tags', 'steps.s1.output.addresses');
        expect(lastValue('tags')).toMatchObject({ kind: 'pick', take: 'all', as: 'list' });
    });

    it('a single value into a text column is the value itself', () => {
        const { insertInto, lastValue } = renderFields(writeDraft());
        insertInto('Name', 'steps.s1.output.name');
        expect(lastValue('name')).toMatchObject({ kind: 'pick', take: 'one', as: 'text', from: { root: 'steps', id: 's1', path: ['name'] } });
    });
});

describe('the datatable filter asks per OPERATOR, not per slot', () => {
    beforeEach(cleanup);

    it('turns a list on "is" into one value — that comparison takes one', () => {
        const { insertInto, lastWhere } = renderFields(whereDraft('eq'));
        insertInto('Value', 'steps.s1.output.addresses');
        expect(lastWhere()).toMatchObject({ kind: 'pick', take: 'all', as: 'text' });
    });

    it('keeps the list on "is one of" — that comparison IS a list', () => {
        const { insertInto, lastWhere } = renderFields(whereDraft('in'));
        insertInto('Value', 'steps.s1.output.addresses');
        expect(lastWhere()).toMatchObject({ kind: 'pick', take: 'all', as: 'list' });
    });

    it('stays quiet on "is none of" — the operator the OTHER copies of this list forget', () => {
        // `notIn` is where a hand-rolled operator set drifts: the BI filter
        // editor's own copy says {in, between} and leaves it out, which would
        // turn the list into one value on a filter that is right.
        // The panel asks the SHARED helper (opTakesList) instead of keeping a
        // list of its own, and this case is what pins that.
        const { insertInto, lastWhere } = renderFields(whereDraft('notIn'));
        insertInto('Value', 'steps.s1.output.addresses');
        expect(lastWhere()).toMatchObject({ kind: 'pick', take: 'all', as: 'list' });
    });

    it('stays quiet on "is between" too', () => {
        const { insertInto, lastWhere } = renderFields(whereDraft('between'));
        insertInto('Value', 'steps.s1.output.addresses');
        expect(lastWhere()).toMatchObject({ kind: 'pick', take: 'all', as: 'list' });
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
