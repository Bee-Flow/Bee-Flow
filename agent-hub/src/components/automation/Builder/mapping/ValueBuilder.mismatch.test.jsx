import fs from 'node:fs';
import path from 'node:path';
import { render, screen, fireEvent, cleanup, act, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import ValueBuilder from './ValueBuilder';
import { VariablePickerProvider } from './VariablePickerContext';

// vitest runs from the agent-hub root; resolving from cwd avoids import.meta
// URL schemes that differ between the .js and .jsx transforms.
const SRC = path.resolve(process.cwd(), 'src/components/automation/Builder/mapping/ValueBuilder.jsx');

/**
 * WHAT HAPPENS WHEN THE THING YOU PICKED DOES NOT FIT THE SLOT.
 *
 * ValueBuilder is the default renderer for a step-bound value, so this is the
 * surface where an author actually drops a list of e-mail addresses onto a
 * field that takes one. Three shapes, three different questions — and
 * `mapping/mismatch.js` is the ONE place that decides which:
 *
 *   list  → the list chooser (all / first / count / one run per item), which
 *           writes NOTHING until the author answers;
 *   table → the table menu ("as a table"), because joining rows of objects
 *           produces "[object Object]" and no author asked for that;
 *   group → "pick a field inside it", which before this round was simply not
 *           reachable from this editor at all — the object went in silently.
 *
 * The list route is pinned FIRST and in detail: it is the one with existing
 * behaviour, and a silent change there rewrites what live automations store.
 */
const RESULTS = [{ subject: 'ISV contract', from_email: 'a@b.nl' }, { subject: 'Renewal', from_email: 'c@d.nl' }];
const ADDRESSES = ['a@b.nl', 'c@d.nl', 'e@f.nl'];
const SENDER = { name: 'Ada', email: 'ada@b.nl' };
const SAMPLE = {
    steps: {
        s1: { output: { total: 201, results: RESULTS, addresses: ADDRESSES, sender: SENDER, subject: 'One value' } },
    },
};
const GROUPS = [{
    id: 's1', label: 'gmail search', kind: 'integration_action',
    basePath: 'steps.s1.output', sample: SAMPLE.steps.s1.output,
    fields: [
        { key: 'addresses', path: 'steps.s1.output.addresses', sample: ADDRESSES },
        { key: 'results', path: 'steps.s1.output.results', sample: RESULTS },
        { key: 'sender', path: 'steps.s1.output.sender', sample: SENDER },
        { key: 'subject', path: 'steps.s1.output.subject', sample: 'One value' },
    ],
}];
const LABELS = new Map([['s1', 'gmail search']]);

/**
 * Drive a pick the way the Incoming tree does: ValueBuilder publishes an
 * `insert(path, opts)` handle through onFocusField when the editor is focused.
 * That is the real entry point for click-to-insert and for drag-and-drop, so
 * the test exercises the pipeline rather than a private function.
 */
function renderEditor(props = {}) {
    const onChange = vi.fn();
    const onRequestForEach = vi.fn();
    const handle = { current: null };
    render(
        <VariablePickerProvider groups={GROUPS} previewSample={SAMPLE} stepLabelById={LABELS}>
            <ValueBuilder
                value={{ kind: 'literal', value: '' }}
                onChange={onChange}
                previewSample={SAMPLE}
                expectShape="scalar"
                expectKind="text"
                label="Subject"
                onFocusField={(h) => { handle.current = h; }}
                onRequestForEach={onRequestForEach}
                {...props}
            />
        </VariablePickerProvider>,
    );
    // Focusing publishes the handle (the editor is a textbox in inline mode).
    const box = screen.getAllByRole('textbox')[0];
    fireEvent.focus(box);
    // A pick never asks (quietDefaultId): the alternatives sit under
    // "Advanced", so the tests below that are ABOUT those alternatives open it.
    const insertQuiet = (path, opts) => act(() => { handle.current.insert(path, opts); });
    const insert = (path, opts) => {
        insertQuiet(path, opts);
        const adv = screen.queryByRole('button', { name: 'More ways to use this value' });
        if (adv && adv.getAttribute('aria-expanded') === 'false') fireEvent.click(adv);
    };
    return { onChange, onRequestForEach, insert, insertQuiet };
}

describe('a pick that does not fit one-to-one is answered without a question', () => {
    beforeEach(cleanup);

    it('a list into a text slot goes in comma separated, and nothing asks', () => {
        const { onChange, insertQuiet } = renderEditor();
        insertQuiet('steps.s1.output.addresses');
        expect(screen.queryByTestId('mismatch-resolver')).toBeNull();
        expect(onChange.mock.calls.at(-1)[0]).toEqual({ kind: 'expr', value: 'join(steps.s1.output.addresses, ", ")' });
    });

    it('a list into a number slot takes the first one', () => {
        const { onChange, insertQuiet } = renderEditor({ expectKind: 'number' });
        insertQuiet('steps.s1.output.addresses');
        expect(onChange.mock.calls.at(-1)[0]).toEqual({ kind: 'expr', value: 'first(steps.s1.output.addresses)' });
    });

    it('a value from inside each row runs the step once per row, says so, and can be undone', () => {
        const { onChange, onRequestForEach, insertQuiet } = renderEditor();
        insertQuiet('steps.s1.output.results[*].subject');
        expect(onRequestForEach).toHaveBeenCalledWith(expect.objectContaining({ overRef: 'steps.s1.output.results' }));
        expect(onChange.mock.calls.at(-1)[0].kind).toBe('ref');
        expect(onChange.mock.calls.at(-1)[0].path).toMatch(/^loop\.[A-Za-z_]+\.subject$/);
        expect(screen.getByText(/runs once per row/)).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
        expect(onRequestForEach).toHaveBeenLastCalledWith(null);
    });

    it('the other answers are one click away, under More', () => {
        const { insertQuiet } = renderEditor();
        insertQuiet('steps.s1.output.addresses');
        fireEvent.click(screen.getByRole('button', { name: 'More ways to use this value' }));
        expect(screen.getByTestId('mismatch-resolver')).toBeTruthy();
    });
});

describe('picking a value that fits — nothing to ask', () => {
    beforeEach(cleanup);

    it('inserts a single value straight away and asks nothing', () => {
        const { onChange, insert } = renderEditor();
        insert('steps.s1.output.subject');
        expect(screen.queryByTestId('mismatch-resolver')).toBeNull();
        expect(document.querySelector('[data-list-pick-chooser]')).toBeNull();
        expect(onChange).toHaveBeenCalled();
    });

    it('asks nothing on a surface whose slot shape is unknown', () => {
        // The gate is POSITIVE: App Studio, custom rows and Set fields declare
        // no schema, and they must behave exactly as they always have.
        const { onChange, insert } = renderEditor({ expectShape: 'unknown', expectKind: null });
        insert('steps.s1.output.addresses');
        expect(document.querySelector('[data-list-pick-chooser]')).toBeNull();
        expect(screen.queryByTestId('mismatch-resolver')).toBeNull();
        expect(onChange).toHaveBeenCalled();
    });

    it('asks nothing when the slot itself wants a list', () => {
        const { insert } = renderEditor({ expectShape: 'list', expectKind: 'list' });
        insert('steps.s1.output.addresses');
        expect(document.querySelector('[data-list-pick-chooser]')).toBeNull();
        expect(screen.queryByTestId('mismatch-resolver')).toBeNull();
    });

    it('Alt (opts.raw) skips the question entirely', () => {
        const { onChange, insert } = renderEditor();
        insert('steps.s1.output.addresses', { raw: true });
        expect(document.querySelector('[data-list-pick-chooser]')).toBeNull();
        expect(onChange).toHaveBeenCalled();
    });
});

describe('a LIST into a slot that wants one value — answered inline (artboard 2a)', () => {
    beforeEach(cleanup);

    it('asks in the warning box under the field, not in a popover', () => {
        const { insert } = renderEditor();
        insert('steps.s1.output.addresses');
        const box = screen.getByTestId('mismatch-resolver');
        expect(document.querySelector('[data-list-pick-chooser]')).toBeNull();
        // Collapsed by default (BFSF-482): the applied default is a chip…
        expect(within(box).getByTestId('mismatch-selected').textContent).toBe('All of them, comma separated');
        // …and the rest of the list menu sits behind "List options".
        fireEvent.click(within(box).getByRole('button', { name: 'List options' }));
        expect(within(box).getByText('Only the first')).toBeTruthy();
        expect(within(box).getByText('Only the count (3)')).toBeTruthy();
    });

    it('writes the first answer at once, so the field never holds the raw list', () => {
        const { onChange, insert } = renderEditor();
        insert('steps.s1.output.addresses');
        expect(onChange).toHaveBeenCalledTimes(1);
        const b = onChange.mock.calls[0][0];
        expect(b.kind).toBe('expr');
        expect(b.value).toMatch(/^join\(steps\.s1\.output\.addresses, /);
    });

    it('re-applies first() when the author picks "Only the first"', async () => {
        const { onChange, insert } = renderEditor();
        insert('steps.s1.output.addresses');
        await userEvent.click(screen.getByRole('button', { name: 'List options' }));
        await userEvent.click(screen.getByText('Only the first'));
        expect(onChange.mock.calls.at(-1)[0]).toEqual({ kind: 'expr', value: 'first(steps.s1.output.addresses)' });
        expect(screen.getByText('Only the first').getAttribute('aria-pressed')).toBe('true');
    });

    it('keeps a comma-separated join two clicks away, under "List options" → "more"', async () => {
        const { onChange, insert } = renderEditor();
        insert('steps.s1.output.addresses');
        await userEvent.click(screen.getByRole('button', { name: 'List options' }));
        await userEvent.click(screen.getByText('more'));
        await userEvent.click(screen.getByText('All of them, comma separated'));
        expect(onChange.mock.calls.at(-1)[0]).toEqual({ kind: 'expr', value: 'join(steps.s1.output.addresses, ", ")' });
    });
});

describe('a GROUP into a slot that wants one value — a question that used to be unreachable', () => {
    beforeEach(cleanup);

    it('opens the inline resolver instead of binding the object silently', () => {
        // Before this round `pathListShape` returned null for an object, so
        // the editor asked nothing and wrote the raw group — which reaches the
        // provider as "[object Object]".
        const { insert } = renderEditor();
        insert('steps.s1.output.sender');
        expect(screen.getByTestId('mismatch-resolver')).toBeTruthy();
        expect(screen.getByText(/Pick a field inside it/)).toBeTruthy();
    });

    it('writes mismatch.js\'s own default at once, so the field is never left holding the object', () => {
        const { onChange, insert } = renderEditor();
        insert('steps.s1.output.sender');
        expect(onChange).toHaveBeenCalledTimes(1);
        expect(onChange.mock.calls[0][0]).toEqual({ kind: 'expr', value: 'groupSummary(steps.s1.output.sender)' });
    });

    it('offers the group\'s own fields, and binds the one the author picks', () => {
        const { onChange, insert } = renderEditor();
        insert('steps.s1.output.sender');
        fireEvent.click(screen.getByRole('button', { name: 'Field options' }));
        fireEvent.click(screen.getByRole('button', { name: 'Email' }));
        expect(onChange.mock.calls.at(-1)[0]).toEqual({ kind: 'ref', path: 'steps.s1.output.sender.email' });
    });

    it('marks the chosen remedy, so the box says what the field holds', () => {
        const { insert } = renderEditor();
        insert('steps.s1.output.sender');
        fireEvent.click(screen.getByRole('button', { name: 'Field options' }));
        fireEvent.click(screen.getByRole('button', { name: 'Name' }));
        expect(screen.getByRole('button', { name: 'Name' }).getAttribute('aria-pressed')).toBe('true');
    });

    it('closing the box leaves the binding it already wrote', () => {
        const { onChange, insert } = renderEditor();
        insert('steps.s1.output.sender');
        const calls = onChange.mock.calls.length;
        fireEvent.click(screen.getByLabelText('Cancel'));
        expect(screen.queryByTestId('mismatch-resolver')).toBeNull();
        expect(onChange.mock.calls.length).toBe(calls);
    });
});

describe('a TABLE into a slot that wants one value — the table menu, not the list menu', () => {
    beforeEach(cleanup);

    it('defaults to "as a table" rather than joining rows of objects', () => {
        // join() over records is what produced "[object Object]"; the table
        // branch exists precisely so that is not the default answer.
        const { onChange, insert } = renderEditor();
        insert('steps.s1.output.results');
        expect(onChange.mock.calls[0][0]).toEqual({ kind: 'expr', value: 'asTable(steps.s1.output.results)' });
    });

    it('asks the TABLE question, and does not offer the list answers up front', () => {
        const { insert } = renderEditor();
        insert('steps.s1.output.results');
        expect(screen.getByTestId('mismatch-resolver')).toBeTruthy();
        // The applied default reads as a chip while collapsed…
        expect(screen.getByTestId('mismatch-selected').textContent).toBe('As a table');
        expect(screen.getByText(/It can go in as a table/)).toBeTruthy();
        // …and opening "Table options" shows the table menu, never the list one.
        fireEvent.click(screen.getByRole('button', { name: 'Table options' }));
        expect(screen.getByRole('button', { name: 'As a table' })).toBeTruthy();
        expect(screen.queryByRole('button', { name: /All of them, one per line/ })).toBeNull();
    });

    it('counts ROWS, not items, when the author asks how many', () => {
        const { onChange, insert } = renderEditor();
        insert('steps.s1.output.results');
        fireEvent.click(screen.getByRole('button', { name: 'Table options' }));
        fireEvent.click(screen.getByRole('button', { name: 'Only how many rows (2)' }));
        expect(onChange.mock.calls.at(-1)[0]).toEqual({ kind: 'expr', value: 'count(steps.s1.output.results)' });
    });

    it('offers a run per row, and hands the forEach up to the step', () => {
        const { onChange, onRequestForEach, insert } = renderEditor();
        insert('steps.s1.output.results');
        fireEvent.click(screen.getByRole('button', { name: 'Table options' }));
        fireEvent.click(screen.getByRole('button', { name: 'A separate run for each row' }));
        expect(onRequestForEach).toHaveBeenCalled();
        expect(onChange.mock.calls.at(-1)[0]).toBeTruthy();
    });

    it('offers no per-row run when the step cannot fan out', () => {
        const { insert } = renderEditor({ onRequestForEach: null });
        insert('steps.s1.output.results');
        fireEvent.click(screen.getByRole('button', { name: 'Table options' }));
        expect(screen.queryByRole('button', { name: 'A separate run for each row' })).toBeNull();
    });
});

describe('mismatch.js is the only detector on this path', () => {
    beforeEach(cleanup);

    it('every question the editor asks is one detectMismatch names', () => {
        // The regression this guards: a second gate creeping back in beside
        // the shared one, so the two editors disagree about whether a value
        // fits. Asserted on the source because the alternative is trusting a
        // comment.
        expect(fs.existsSync(SRC), `${SRC} is not where this test thinks it is`).toBe(true);
        const src = fs.readFileSync(SRC, 'utf8');
        expect(src).toContain('detectMismatch(');
        // pathListShape survives for ONE job — handing the list chooser the
        // shape it renders — and must not decide anything again.
        const gates = src.split('\n').filter(l => /(?:if|\?|&&|\|\|)\s*\(?[^=]*pathListShape\(/.test(l));
        expect(gates, `pathListShape is deciding again:\n${gates.join('\n')}`).toEqual([]);
    });
});
