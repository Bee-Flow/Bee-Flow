import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AiTablePanel from './AiTablePanel';
import ColumnDesigner from './ColumnDesigner';
import { datatablesApi } from './datatablesApi';
import NewDatatableDialog from './NewDatatableDialog';

/**
 * "Build it with AI" for a table:
 *   - the create dialog fills name, purpose and columns from the draft and
 *     creates NOTHING until "Create"; the key follows the drafted name;
 *   - the column designer sends the current columns, the guard is OFF by
 *     default and resets after every request, the draft lands in the
 *     UNSAVED list (Save bar appears, putSchema untouched), ids of kept
 *     columns are carried so the server never sees a drop-and-recreate;
 *   - a removal with the guard on is reported as "kept"; Undo restores;
 *   - a locked table (cache / mirror / answers) shows no box at all;
 *   - every refusal has its own sentence.
 */

vi.mock('./datatablesApi', () => {
    const datatablesApi = {
        list: vi.fn(), get: vi.fn(), create: vi.fn(), createManaged: vi.fn(), draft: vi.fn(),
        getSchema: vi.fn(), putSchema: vi.fn(), listUsage: vi.fn(), listRows: vi.fn(),
        ncLinkable: vi.fn().mockRejectedValue(new Error('no')), spreadsheetProviders: vi.fn().mockRejectedValue(new Error('no')),
        removeAnswersColumn: vi.fn(),
    };
    return { datatablesApi, default: datatablesApi };
});

const FIELDS = [
    { id: 'fld_a1', key: 'email', name: 'E-mail', type: 'text' },
    { id: 'fld_a2', key: 'notes', name: 'Notes', type: 'richtext' },
];
const TABLE = { id: 'tbl_1', name: 'Customers', key: 'customers', description: 'Customers we onboarded.', rowCount: 12, grade: 'owner', scopeKind: 'org', managedKind: null };

beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    datatablesApi.getSchema.mockResolvedValue({ fields: FIELDS, modelVersion: 3 });
    datatablesApi.listRows.mockResolvedValue({ rows: [], hasMore: false, count: 0 });
    datatablesApi.listUsage.mockResolvedValue({ usage: [] });
});

describe('<AiTablePanel> alone', () => {
    it('create: a brief in, the draft applied; the box keeps its text on a refusal', async () => {
        datatablesApi.draft.mockResolvedValue({ draft: { name: 'Invoices', key: 'invoices', description: 'One row per invoice.', fields: [{ key: 'supplier', name: 'Supplier', type: 'text' }], notes: null, changes: { added: ['supplier'], renamed: [], retyped: [], removed: [] } }, mode: 'create' });
        const onApply = vi.fn();
        render(<AiTablePanel mode="create" current={{ name: '', description: '', fields: [] }} onApply={onApply} />);
        expect(screen.getByTestId('table-ai-run')).toBeDisabled();
        fireEvent.change(screen.getByTestId('table-ai-text'), { target: { value: 'Supplier invoices' } });
        fireEvent.click(screen.getByTestId('table-ai-run'));
        await waitFor(() => expect(onApply).toHaveBeenCalled());
        expect(datatablesApi.draft).toHaveBeenCalledWith({ mode: 'create', brief: 'Supplier invoices', current: { name: '', description: '', fields: [] } });
        expect(onApply.mock.calls[0][0].name).toBe('Invoices');
        expect((await screen.findByTestId('table-ai-done')).textContent).toContain('1 columns drafted');

        datatablesApi.draft.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'no_model', status: 503 }));
        fireEvent.change(screen.getByTestId('table-ai-text'), { target: { value: 'again' } });
        fireEvent.click(screen.getByTestId('table-ai-run'));
        expect((await screen.findByRole('alert')).textContent).toMatch(/No AI model is set up/);
        expect(screen.getByTestId('table-ai-text').value).toBe('again');
    });
});

describe('the New datatable dialog', () => {
    it('fills name, purpose and columns from the draft, lets the key follow, and creates nothing until Create', async () => {
        datatablesApi.draft.mockResolvedValue({ draft: {
            name: 'Supplier invoices', key: 'supplier_invoices', description: 'One row per supplier invoice, kept for the audit.',
            fields: [{ key: 'supplier', name: 'Supplier', type: 'text', required: true }, { key: 'status', name: 'Status', type: 'select', options: ['New', 'Approved'] }],
            notes: null, changes: { added: ['supplier', 'status'], renamed: [], retyped: [], removed: [] },
        }, mode: 'create' });
        datatablesApi.create.mockResolvedValue({ datatable: { id: 'tbl_new' } });
        const onCreated = vi.fn();
        render(<NewDatatableDialog scope={{ kind: 'org' }} onClose={() => {}} onCreated={onCreated} />);
        fireEvent.change(screen.getByTestId('new-table-ai-text'), { target: { value: 'Track supplier invoices with a status' } });
        fireEvent.click(screen.getByTestId('new-table-ai-run'));
        await waitFor(() => expect(screen.getByPlaceholderText('Customers').value).toBe('Supplier invoices'));
        expect(screen.getByPlaceholderText('Customers we have already sent the onboarding e-mail to.').value).toContain('One row per supplier invoice');
        expect(screen.getAllByLabelText('Column name').map(i => i.value)).toEqual(['Supplier', 'Status']);
        expect(datatablesApi.create).not.toHaveBeenCalled();
        // the key followed the drafted name
        expect(screen.getByText('supplier_invoices')).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: /^Create/ }));
        await waitFor(() => expect(datatablesApi.create).toHaveBeenCalled());
        const body = datatablesApi.create.mock.calls[0][0];
        expect(body.key).toBe('supplier_invoices');
        expect(body.fields.map(f => f.key)).toEqual(['supplier', 'status']);
        expect(body.fields[1].options).toEqual(['New', 'Approved']);
    });
});

describe('the column designer', () => {
    it('sends the current columns with the guard OFF, lands the draft in the unsaved list with ids carried, and the guard resets', async () => {
        datatablesApi.draft.mockResolvedValue({ draft: {
            name: 'Customers', key: 'customers', description: 'Customers we onboarded.',
            fields: [{ key: 'email', name: 'E-mail address', type: 'text' }, { key: 'notes', name: 'Notes', type: 'richtext' }, { key: 'phone', name: 'Phone', type: 'text' }],
            notes: null, changes: { added: ['phone'], renamed: [{ key: 'email', from: 'E-mail', to: 'E-mail address' }], retyped: [], removed: [] },
        }, mode: 'revise' });
        render(<ColumnDesigner table={TABLE} canEdit usage={[]} onChanged={vi.fn()} />);
        await screen.findByDisplayValue('E-mail');
        expect(screen.getByTestId('columns-ai-allow').checked).toBe(false);
        fireEvent.change(screen.getByTestId('columns-ai-text'), { target: { value: 'add a phone number, call e-mail "E-mail address"' } });
        fireEvent.click(screen.getByTestId('columns-ai-run'));
        await waitFor(() => expect(datatablesApi.draft).toHaveBeenCalled());
        const body = datatablesApi.draft.mock.calls[0][0];
        expect(body.mode).toBe('revise');
        expect(body.allowDestructive).toBe(false);
        expect(body.current.fields.map(f => f.key)).toEqual(['email', 'notes']);
        expect(body.current.rowCount).toBe(12);
        // the unsaved list, with the Save bar — and no PUT
        expect(await screen.findByDisplayValue('E-mail address')).toBeTruthy();
        expect(screen.getByDisplayValue('Phone')).toBeTruthy();
        expect(screen.getByRole('button', { name: /Save columns/ })).toBeTruthy();
        expect(datatablesApi.putSchema).not.toHaveBeenCalled();
        expect((await screen.findByTestId('columns-ai-done')).textContent).toBe('1 added · 1 renamed');
        // saving carries the kept ids so the server matches, not drops
        datatablesApi.putSchema.mockResolvedValue({ fields: [], modelVersion: 4 });
        fireEvent.click(screen.getByRole('button', { name: /Save columns/ }));
        await waitFor(() => expect(datatablesApi.putSchema).toHaveBeenCalled());
        const [, saved] = datatablesApi.putSchema.mock.calls[0];
        expect(saved.map(f => [f.key, f.id])).toEqual([['email', 'fld_a1'], ['notes', 'fld_a2'], ['phone', undefined]]);
    });

    it('with the guard switched on the flag travels once, and Undo puts the previous columns back', async () => {
        datatablesApi.draft.mockResolvedValue({ draft: {
            name: 'Customers', key: 'customers', description: '',
            fields: [{ key: 'email', name: 'E-mail', type: 'text' }],
            notes: null, changes: { added: [], renamed: [], retyped: [], removed: ['notes'] },
        }, mode: 'revise' });
        render(<ColumnDesigner table={TABLE} canEdit usage={[]} onChanged={vi.fn()} />);
        await screen.findByDisplayValue('E-mail');
        fireEvent.click(screen.getByTestId('columns-ai-allow'));
        fireEvent.change(screen.getByTestId('columns-ai-text'), { target: { value: 'drop the notes' } });
        fireEvent.click(screen.getByTestId('columns-ai-run'));
        await waitFor(() => expect(datatablesApi.draft).toHaveBeenCalled());
        expect(datatablesApi.draft.mock.calls[0][0].allowDestructive).toBe(true);
        await waitFor(() => expect(screen.queryByDisplayValue('Notes')).toBeNull());
        expect((await screen.findByTestId('columns-ai-done')).textContent).toBe('1 removed');
        // per request: guarded again
        expect(screen.getByTestId('columns-ai-allow').checked).toBe(false);
        fireEvent.click(screen.getByTestId('columns-ai-undo'));
        expect(await screen.findByDisplayValue('Notes')).toBeTruthy();
        expect(screen.queryByRole('button', { name: /Save columns/ })).toBeNull();
    });

    it('the box takes no more than the server accepts — 2000 for a change, 12000 for a brief', () => {
        const { unmount } = render(<AiTablePanel mode="revise" current={{ name: 'T', description: '', fields: [] }} onApply={vi.fn()} />);
        expect(screen.getByRole('textbox').getAttribute('maxlength')).toBe('2000');
        unmount();
        render(<AiTablePanel mode="create" current={{ name: '', description: '', fields: [] }} onApply={vi.fn()} />);
        expect(screen.getByRole('textbox').getAttribute('maxlength')).toBe('12000');
    });

    it('a locked table gets no box', async () => {
        datatablesApi.getSchema.mockResolvedValue({ fields: [{ id: 'fld_x', key: 'cache_key', name: 'Answer key', type: 'text' }], modelVersion: 1 });
        render(<ColumnDesigner table={{ ...TABLE, managedKind: 'http_cache' }} canEdit usage={[]} onChanged={vi.fn()} />);
        await screen.findByDisplayValue('Answer key');
        expect(screen.queryByTestId('columns-ai')).toBeNull();
        expect(within(document.body).queryByText('Build it with AI')).toBeNull();
    });
});
