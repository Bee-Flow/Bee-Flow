/**
 * A rule on the attachments of each mail, built by clicking: File type under
 * "Attachments of each message" gives "any attachment · File type · is ·
 * PDF", which checks every attachment. A rule saved the old way reopens as the
 * same kind of row instead of a formula box.
 */
import { ruleFieldOptions } from '@shared/expr/rules.mjs';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ConditionBuilderJs from './ConditionBuilder';
import { rowHints } from './ConditionBuilderRow';
import { sampleToFields } from './upstream';
import { VariablePickerProvider as ProviderJs } from './VariablePickerContext';
import { humanizeFieldKey } from '../flow/displayHelpers';

// Both are JS components: TypeScript reads every prop without a default as
// required, so the test types them loosely instead of passing dummies.
type Loose = React.ComponentType<Record<string, unknown> & { children?: React.ReactNode }>;
const ConditionBuilder = ConditionBuilderJs as unknown as Loose;
const VariablePickerProvider = ProviderJs as unknown as Loose;

const MAIL = {
    subject: 'Invoice 7',
    from: 'billing@fabrikam.example',
    attachments: [
        { filename: 'invoice.pdf', mimeType: 'application/pdf', size: 1200 },
        { filename: 'logo.png', mimeType: 'image/png', size: 40 },
    ],
};
const PREVIEW = { item: MAIL };
const GROUPS: Record<string, string> = { item: 'Fields of each {name}', inner: '{list} of each {name}' };
const OPTIONS = ruleFieldOptions(sampleToFields(MAIL, 'item'), {
    element: MAIL,
    name: humanizeFieldKey,
    fileTypeLabel: 'File type',
    itemName: 'message',
    group: (kind: string, vars: Record<string, string>) => (GROUPS[kind] || '').replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? ''),
});

function renderBuilder(value: string) {
    const onChange = vi.fn();
    render(
        <VariablePickerProvider groups={[]} previewSample={PREVIEW} stepLabelById={new Map()}>
            <ConditionBuilder value={value} onChange={onChange} context="filter" previewSample={PREVIEW} fieldOptions={OPTIONS} />
        </VariablePickerProvider>,
    );
    return { onChange };
}

const lastCall = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls[fn.mock.calls.length - 1]?.[0];

describe('ConditionBuilder: a rule on the attachments of each mail', () => {
    afterEach(() => cleanup());

    it('File type under Attachments gives "any attachment", and PDF writes anyOf over every attachment', async () => {
        const user = userEvent.setup();
        const { onChange } = renderBuilder('');
        await user.click(screen.getByRole('button', { name: /Choose a field/ }));
        expect(screen.getByText('Attachments of each message')).toBeTruthy();
        await user.click(screen.getByRole('button', { name: /^File type/ }));

        const quantifier = screen.getByRole('combobox', { name: 'Which attachment' }) as HTMLSelectElement;
        expect(quantifier.value).toBe('any');
        expect(Array.from(quantifier.options).map((o) => o.text)).toEqual(['any attachment', 'every attachment', 'no attachment']);
        const ops = Array.from((screen.getByTitle('Field type: fileType') as HTMLSelectElement).options).map((o) => o.text);
        expect(ops).toEqual(['is', 'is not']);

        await user.selectOptions(screen.getByRole('combobox', { name: 'File type' }), 'pdf');
        expect(lastCall(onChange)).toBe('anyOf(fileType(item.attachments[*]), "equals", "pdf")');
    });

    it('reopens the old contains(<column>, "pdf") as rows, and "no attachment" writes noneOf', async () => {
        const user = userEvent.setup();
        const { onChange } = renderBuilder('contains(item.attachments[*].mimeType, "pdf")');
        expect(document.querySelector('textarea')).toBeNull();
        expect(screen.getByText('Mime type')).toBeTruthy();
        expect((screen.getByTitle('Field type: string') as HTMLSelectElement).value).toBe('contains');
        expect(onChange).not.toHaveBeenCalled();

        await user.selectOptions(screen.getByRole('combobox', { name: 'Which attachment' }), 'none');
        expect(lastCall(onChange)).toBe('noneOf(item.attachments[*].mimeType, "contains", "pdf")');
    });

    it('a plain text field offers "is" first and writes equals()', async () => {
        const user = userEvent.setup();
        const { onChange } = renderBuilder('');
        await user.click(screen.getByRole('button', { name: /Choose a field/ }));
        await user.click(screen.getByRole('button', { name: /^Subject/ }));
        expect(screen.queryByRole('combobox', { name: /Which/ })).toBeNull();
        expect((screen.getByTitle('Field type: string') as HTMLSelectElement).value).toBe('is');
        await user.type(screen.getByPlaceholderText('value'), 'invoice 7');
        expect(lastCall(onChange)).toBe('equals(item.subject, "invoice 7")');
    });

    it('a list of records compared as one value says why it never matches (R9)', () => {
        renderBuilder('contains(item.attachments, "pdf")');
        expect(screen.getByText('Attachments is a list, so “contains” never matches it. Pick a field under Attachments instead, for example File type.')).toBeTruthy();
    });

    it('a field the sample does not have is named under its row (R12)', () => {
        renderBuilder('contains(item.frm, "fabrikam")');
        expect(screen.getByText('There is no “frm” in the sample data, so this rule would match nothing.')).toBeTruthy();
    });

    it('a column the attachments do not have is named too, and a known one is not', () => {
        renderBuilder('anyOf(item.attachments[*].mimetype, "contains", "pdf") && anyOf(item.attachments[*].size, ">", 3)');
        expect(screen.getAllByText(/in the sample data/)).toHaveLength(1);
        expect(screen.getByText('There is no “mimetype” in the sample data, so this rule would match nothing.')).toBeTruthy();
    });
});

describe('rowHints', () => {
    const t = (_key: string, en: string, vars: Record<string, unknown> = {}) => en.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));
    const row = (path: string, op = 'is', quantifier?: 'any') => ({ field: { kind: 'ref', path }, op, value: { kind: 'literal', value: 'x' }, ...(quantifier ? { quantifier } : {}) });
    const LIST_HINT = 'This field holds a list. Pick it from the field menu to check any, every or no item of it.';

    it('a list path outside a quantifier gets the list hint in list mode only', () => {
        const input = { row: row('item.attachments[*]'), type: 'unknown', previewSample: null, fieldOptions: null };
        expect(rowHints({ ...input, context: 'filter' }, t)).toEqual([LIST_HINT]);
        // Whole-run mode: the editor's whole-list notice says this instead.
        expect(rowHints({ ...input, context: 'condition' }, t)).toEqual([]);
    });

    it('a quantified row and a "has a value" row get no list hint', () => {
        expect(rowHints({ row: row('item.attachments[*].size', 'gt', 'any'), type: 'number', previewSample: null, fieldOptions: null, context: 'filter' }, t)).toEqual([]);
        expect(rowHints({ row: row('item.attachments[*]', 'truthy'), type: 'unknown', previewSample: null, fieldOptions: null, context: 'filter' }, t)).toEqual([]);
    });

    it('says nothing about a missing field without a sample', () => {
        expect(rowHints({ row: row('item.frm'), type: 'unknown', previewSample: null, fieldOptions: null, context: 'filter' }, t)).toEqual([]);
    });

    it('"has none" and "has at least one" are fine on a list of records', () => {
        expect(rowHints({ row: row('item.attachments', 'isEmpty'), type: 'records', previewSample: PREVIEW, fieldOptions: OPTIONS, context: 'filter' }, t)).toEqual([]);
    });
});
