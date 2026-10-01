import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentType, ReactNode } from 'react';
import { WILD } from '@shared/mapping/index.mjs';
import BindingField, { type BindingFieldProps } from './BindingField';
import { VariablePickerProvider as ProviderJs } from './VariablePickerContext';
import { editor, editorValue, typeInEditor } from '../../../../test/refEditor';
import type { FieldHandle } from '../valueSlot/fieldHandle';

/**
 * The formula editor's one way in for a picked value (BindingField
 * acceptPath): a click in "Comes in", a drop, its own {} picker, a clicked
 * pill and the autocomplete all end there. Each case below is one of the
 * confirmed bugs the old field had.
 */

const VariablePickerProvider = ProviderJs as unknown as ComponentType<Record<string, unknown> & { children: ReactNode }>;

const MAILS = ['a@b.nl', 'c@d.nl'];
const SAMPLE = { steps: { s1: { output: { mails: MAILS, name: 'Ada', city: 'Utrecht', rows: [{ 'Order date': '2026-01-02' }] } } } };
const GROUPS = [{
    id: 's1', label: 'Search', basePath: 'steps.s1.output', sample: SAMPLE.steps.s1.output,
    fields: [
        { key: 'mails', path: 'steps.s1.output.mails', sample: MAILS, source: { root: 'steps', id: 's1', path: ['mails'] } },
        { key: 'name', path: 'steps.s1.output.name', sample: 'Ada', source: { root: 'steps', id: 's1', path: ['name'] } },
    ],
}];
const labels = new Map([['s1', 'Search']]);

function renderField(props: Partial<BindingFieldProps> = {}) {
    const onChange = vi.fn();
    let handle: FieldHandle | null = null;
    const utils = render(
        <VariablePickerProvider groups={GROUPS} previewSample={SAMPLE} stepLabelById={labels} stepTypeById={null}>
            <BindingField
                label="Body"
                value={{ kind: 'literal', value: '' }}
                onChange={onChange}
                expectKind="text"
                previewSample={SAMPLE}
                onFocusField={(h) => { handle = h; }}
                {...props}
            />
        </VariablePickerProvider>,
    );
    const host = editor(document.body) as HTMLElement;
    act(() => { host.focus(); });
    const insert = (path: string) => act(() => { (handle as FieldHandle | null)?.insert(path); });
    const last = () => onChange.mock.calls.at(-1)?.[0];
    return { ...utils, onChange, host, insert, last, getHandle: () => handle };
}

/** Type a word with the caret after it, as a keyboard leaves it (autocomplete reads the text before the caret). */
function typeWord(host: HTMLElement, word: string) {
    typeInEditor(host, word);
    const range = document.createRange();
    range.setStart(host.firstChild as Node, word.length);
    range.collapse(true);
    const sel = window.getSelection() as Selection;
    sel.removeAllRanges();
    sel.addRange(range);
    act(() => { host.dispatchEvent(new Event('input', { bubbles: true })); });
}

describe('BindingField — a picked value', () => {
    beforeEach(cleanup);

    // Confirmed bug: "BindingField's focus handle captures stale text and mode".
    it('a click after typing keeps what was typed (the handle reads the field as it is now)', () => {
        const { host, insert, last } = renderField();
        typeInEditor(host, 'Re: ');
        insert('steps.s1.output.mails');
        expect(last()).toEqual({ kind: 'template', value: 'Re: {{steps.s1.output.mails}}' });
    });

    it('a second click after a list became a formula replaces it, never gluing {{ }} onto it', () => {
        const { insert, last } = renderField();
        insert('steps.s1.output.mails');
        // A one-line field: all of them, separated by commas.
        expect(last()).toEqual({ kind: 'expr', value: 'join(steps.s1.output.mails, ", ")' });
        insert('steps.s1.output.name');
        expect(last()).toEqual({ kind: 'ref', path: 'steps.s1.output.name' });
    });

    // Confirmed bug: "Clicking a second value in Formula mode merges two references into one bogus path".
    it('a second value replaces the field\'s only reference instead of merging into one path', () => {
        const { insert, last } = renderField({ value: { kind: 'ref', path: 'steps.s1.output.name' } });
        insert('steps.s1.output.city');
        expect(JSON.stringify(last())).not.toContain('namesteps');
        expect(last()).toEqual({ kind: 'ref', path: 'steps.s1.output.city' });
    });

    // Review M4b: the lone-reference rule is for formulas. In Text two `{{ }}`
    // side by side are a valid template, and a second pick used to wipe the first.
    it('in Text a second value is added to the first, never replacing it', () => {
        const { insert, last } = renderField({ value: { kind: 'template', value: '{{steps.s1.output.name}}' } });
        insert('steps.s1.output.city');
        expect(last()).toEqual({ kind: 'template', value: '{{steps.s1.output.name}}{{steps.s1.output.city}}' });
    });

    // Review M4b: a table column comes with a WILD in its Source, and the
    // sample here has no such step: the clicked path's [*] is kept.
    it('a column clicked from a table view keeps its [*] where the sample says nothing', () => {
        const { getHandle, last } = renderField();
        act(() => {
            getHandle()?.insert('steps.g.output.messages[*].subject', {
                source: { root: 'steps', id: 'g', path: ['messages', WILD, 'subject'] }, shape: 'list',
            });
        });
        expect(last()).toEqual({ kind: 'expr', value: 'join(steps.g.output.messages[*].subject, ", ")' });
    });

    it('a value added to a longer formula is spaced off, so two paths never read as one', () => {
        const { insert, host } = renderField({ value: { kind: 'expr', value: 'upper(steps.s1.output.name) + ' } });
        insert('steps.s1.output.name');
        expect(editorValue(host)).toContain('+  steps.s1.output.name');
    });

    // Confirmed bugs: "The {} picker bypasses the list/kind chooser" and
    // "BindingField's own {} picker skips the list/table/group question".
    it('the field\'s own {} picker gives a list what the field wants, like a click does', async () => {
        const { last } = renderField();
        await userEvent.click(screen.getByRole('button', { name: 'Insert variable' }));
        const picker = await screen.findByRole('dialog', { name: 'Insert into Body' });
        await userEvent.click(within(picker).getByText('Mails'));
        expect(last()).toEqual({ kind: 'expr', value: 'join(steps.s1.output.mails, ", ")' });
    });

    it('in a multi-line field a list goes in one per line', () => {
        const { insert, last } = renderField({ multiline: true, slot: { as: 'text', multiLine: true } });
        insert('steps.s1.output.mails');
        expect(last()).toEqual({ kind: 'expr', value: 'join(steps.s1.output.mails, "\\n")' });
    });

    it('a list that has no sample yet goes in as it is (no join() guessed over unknown items)', () => {
        const { insert, last } = renderField();
        insert('steps.s1.output.later');
        expect(last()).toEqual({ kind: 'template', value: '{{steps.s1.output.later}}' });
    });

    // Confirmed bug: "Formula autocomplete steals focus mid-word".
    it('autocomplete follows the typing without taking the caret', () => {
        const { host } = renderField({ value: { kind: 'expr', value: 'x' } });
        typeWord(host, 'tr');
        const picker = screen.getByRole('dialog');
        expect(document.activeElement).not.toBe(within(picker).getByRole('textbox'));
        // 'true' is no root any more: the suggestion goes, the word stays.
        typeWord(host, 'true');
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(editorValue(host)).toBe('true');
    });

    // Confirmed bug: "A plain-text drop is treated as a binding path".
    it('words dragged onto the field are not a binding', () => {
        const { host, onChange } = renderField({ value: { kind: 'literal', value: 'Hi' } });
        const dataTransfer = { types: ['text/plain'], getData: (type: string) => (type === 'text/plain' ? 'some words' : '') };
        const drop = new Event('drop', { bubbles: true, cancelable: true });
        Object.assign(drop, { dataTransfer, clientX: 0, clientY: 0 });
        act(() => { host.dispatchEvent(drop); });
        expect(drop.defaultPrevented).toBe(false);
        expect(onChange).not.toHaveBeenCalled();
    });

    // Confirmed bug: "An escaped path in Formula mode loses ref status".
    it('an escaped path typed as a formula stays a reference', () => {
        const { host, last } = renderField({ value: { kind: 'expr', value: 'x' } });
        typeInEditor(host, 'steps.s1.output.rows[*]["Order date"]');
        expect(last()).toEqual({ kind: 'ref', path: 'steps.s1.output.rows[*]["Order date"]' });
    });
});

// Confirmed bug: "The inline resolver box goes stale after the field is edited
// and can overwrite new content". The list note and its options are worked
// out from the value the field holds now, on every render.
describe('BindingField — the list note follows the value', () => {
    beforeEach(cleanup);

    it('offers the list options for a list in a one-value field, and writes the choice', async () => {
        const { last } = renderField({ value: { kind: 'ref', path: 'steps.s1.output.mails' }, expectShape: 'scalar' });
        expect(screen.getByTestId('formula-list-note').textContent).toContain('list of 2');
        await userEvent.click(screen.getByRole('button', { name: 'Choose how to use the list' }));
        await userEvent.click(within(screen.getByTestId('pick-options')).getByRole('radio', { name: /Only the first/ }));
        expect(last()).toEqual({ kind: 'expr', value: 'first(steps.s1.output.mails)' });
        // Options a formula cannot hold are not offered.
        expect(screen.queryByText(/bulleted/i)).toBeNull();
    });

    it('the note and its options go when the field no longer holds the list', async () => {
        const { rerender } = renderField({ value: { kind: 'ref', path: 'steps.s1.output.mails' }, expectShape: 'scalar' });
        await userEvent.click(screen.getByRole('button', { name: 'Choose how to use the list' }));
        expect(screen.getByTestId('pick-options')).toBeTruthy();
        rerender(
            <VariablePickerProvider groups={GROUPS} previewSample={SAMPLE} stepLabelById={labels} stepTypeById={null}>
                <BindingField label="Body" value={{ kind: 'literal', value: 'typed' }} onChange={vi.fn()} expectShape="scalar" previewSample={SAMPLE} />
            </VariablePickerProvider>,
        );
        expect(screen.queryByTestId('formula-list-note')).toBeNull();
        expect(screen.queryByTestId('pick-options')).toBeNull();
    });
});
