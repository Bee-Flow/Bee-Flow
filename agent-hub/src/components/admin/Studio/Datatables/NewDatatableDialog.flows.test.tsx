import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { datatablesApi } from './datatablesApi';
import NewDatatableDialog from './NewDatatableDialog';

/**
 * The create paths of the dialog that the Nextcloud, spreadsheet and org-scope
 * suites leave open: the ordinary body with its first columns, the technical
 * name's editor, the managed table and its verbatim warning, and what each
 * refusal says. They pin the behaviour the dialog had before it was split.
 */
vi.mock('./datatablesApi', () => {
    const datatablesApi = { create: vi.fn(), createManaged: vi.fn(), linkable: vi.fn(), spreadsheetProviders: vi.fn() };
    return { datatablesApi, default: datatablesApi };
});

// NewDatatableDialog is JavaScript and its `scope = null` default types the prop as
// null, so the fixture is parsed (JSON.parse is untyped) rather than cast.
const ORG_SCOPE = JSON.parse('{ "kind": "org", "id": "org-a", "label": "your organisation" }');
const create = vi.mocked(datatablesApi.create);
const createManaged = vi.mocked(datatablesApi.createManaged);

beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.mocked(datatablesApi.spreadsheetProviders).mockResolvedValue({ providers: [] });
});

function open(props: { scope?: typeof ORG_SCOPE; onCreated?: (table: unknown) => void; onClose?: () => void } = {}) {
    const onCreated = props.onCreated ?? vi.fn();
    const onClose = props.onClose ?? vi.fn();
    render(<NewDatatableDialog scope={props.scope === undefined ? ORG_SCOPE : props.scope} onClose={onClose} onCreated={onCreated} />);
    return { onCreated, onClose, user: userEvent.setup() };
}

const createButton = () => screen.getByRole('button', { name: /^Create$/ });

describe('NewDatatableDialog — an ordinary table', () => {
    it('Create waits for a name and a purpose, and the footer states the technical name', async () => {
        const { user } = open();
        expect(createButton()).toHaveProperty('disabled', true);
        expect(screen.getByText(/Technical name:/).textContent).toContain('—');
        await user.type(screen.getByPlaceholderText('Customers'), 'Klanten lijst');
        expect(screen.getByText(/Technical name:/).textContent).toContain('klanten_lijst');
        expect(screen.getByText(/Technical name:/).textContent).toContain('editable under All options');
        expect(createButton()).toHaveProperty('disabled', true);
        await user.type(screen.getByPlaceholderText(/onboarding e-mail/), 'The list');
        expect(createButton()).toHaveProperty('disabled', false);
    });

    it('sends the name, the purpose and the first columns, and hands the new table on', async () => {
        create.mockResolvedValue({ datatable: { id: 'tbl_1' } });
        const { user, onCreated } = open();
        await user.type(screen.getByPlaceholderText('Customers'), 'Klanten');
        await user.type(screen.getByPlaceholderText(/onboarding e-mail/), '  The list  ');
        await user.click(screen.getByRole('button', { name: /Add a column/ }));
        await user.type(screen.getByLabelText('Column name'), 'Hoeveel');
        await user.selectOptions(screen.getByLabelText('Column type'), 'number');
        await user.click(createButton());
        await waitFor(() => expect(onCreated).toHaveBeenCalledWith({ id: 'tbl_1' }));
        expect(create).toHaveBeenCalledWith({
            scope: 'organisation',
            name: 'Klanten',
            key: 'klanten',
            description: 'The list',
            fields: [{ key: 'hoeveel', name: 'Hoeveel', type: 'number' }],
        });
    });

    it('a column can be removed again, and a bad column blocks Create with its reason', async () => {
        const { user } = open();
        await user.type(screen.getByPlaceholderText('Customers'), 'Klanten');
        await user.type(screen.getByPlaceholderText(/onboarding e-mail/), 'The list');
        await user.click(screen.getByRole('button', { name: /Add a column/ }));
        expect(screen.getByRole('alert').textContent).toContain('a column needs a key.');
        expect(createButton()).toHaveProperty('disabled', true);
        await user.click(screen.getByRole('button', { name: 'Remove this column' }));
        expect(screen.queryByLabelText('Column name')).toBeNull();
        expect(createButton()).toHaveProperty('disabled', false);
    });

    it('All options opens the technical name for editing, and the edited one is what is sent', async () => {
        create.mockResolvedValue({ datatable: { id: 'tbl_2' } });
        const { user } = open();
        await user.type(screen.getByPlaceholderText('Customers'), 'Klanten');
        await user.type(screen.getByPlaceholderText(/onboarding e-mail/), 'The list');
        await user.click(screen.getByRole('radio', { name: 'All options' }));
        expect(screen.getByText(/Technical name:/).textContent).not.toContain('editable under All options');
        const key = screen.getByPlaceholderText('customers');
        await user.clear(key);
        await user.type(key, 'klant_tabel');
        await user.click(createButton());
        await waitFor(() => expect(create).toHaveBeenCalled());
        expect(create.mock.calls[0][0]).toMatchObject({ name: 'Klanten', key: 'klant_tabel' });
    });

    it('choosing "This account only" sends the personal scope', async () => {
        create.mockResolvedValue({ datatable: { id: 'tbl_3' } });
        const { user } = open();
        await user.type(screen.getByPlaceholderText('Customers'), 'Klanten');
        await user.type(screen.getByPlaceholderText(/onboarding e-mail/), 'The list');
        await user.click(screen.getByRole('radio', { name: /This account only/ }));
        await user.click(createButton());
        await waitFor(() => expect(create).toHaveBeenCalled());
        expect(create.mock.calls[0][0]).toMatchObject({ scope: 'personal' });
    });

    it('Cancel closes without creating', async () => {
        const { user, onClose } = open();
        await user.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(create).not.toHaveBeenCalled();
    });
});

describe('NewDatatableDialog — what a refusal says', () => {
    async function submitRefused(error: Error & { code?: string }) {
        create.mockRejectedValue(error);
        const view = open();
        await view.user.type(screen.getByPlaceholderText('Customers'), 'Klanten');
        await view.user.type(screen.getByPlaceholderText(/onboarding e-mail/), 'The list');
        await view.user.click(createButton());
        return (await screen.findByRole('alert')).textContent;
    }

    it('reads the code, not the sentence', async () => {
        expect(await submitRefused(Object.assign(new Error('whatever'), { code: 'key_taken' }))).toBe('There is already a table with this key. Pick another one.');
    });

    it('knows the quota refusal', async () => {
        expect(await submitRefused(Object.assign(new Error('whatever'), { code: 'quota_exceeded' }))).toBe('You have reached the limit on tables here.');
    });

    it('falls back to the server sentence, and then to a generic one', async () => {
        expect(await submitRefused(new Error('Disk is full'))).toBe('Disk is full');
        cleanup();
        expect(await submitRefused(new Error(''))).toBe('Could not create the table');
    });
});

describe('NewDatatableDialog — web service answers', () => {
    it('has no columns to ask for, creates a managed table and shows the server warning verbatim', async () => {
        createManaged.mockResolvedValue({ datatable: { id: 'tbl_m' }, warning: 'Rows are stored in plaintext.' });
        const { user, onCreated } = open();
        await user.click(screen.getByRole('radio', { name: /Web service answers/ }));
        expect(screen.queryByRole('button', { name: /Add a column/ })).toBeNull();
        expect(screen.getByText(/Optional here/)).toBeTruthy();
        await user.type(screen.getByPlaceholderText('Customers'), 'Answers');
        await user.click(createButton());
        expect(await screen.findByText('The table is ready')).toBeTruthy();
        expect(createManaged).toHaveBeenCalledWith({ kind: 'http_cache', scope: 'organisation', name: 'Answers', key: 'answers' });
        expect(create).not.toHaveBeenCalled();
        expect(screen.getByText('Rows are stored in plaintext.')).toBeTruthy();
        expect(onCreated).not.toHaveBeenCalled();
        await user.click(screen.getByRole('button', { name: 'Open the table' }));
        expect(onCreated).toHaveBeenCalledWith({ id: 'tbl_m' });
    });

    it('sends the purpose when one was typed', async () => {
        createManaged.mockResolvedValue({ datatable: { id: 'tbl_m' } });
        const { user } = open();
        await user.click(screen.getByRole('radio', { name: /Web service answers/ }));
        await user.type(screen.getByPlaceholderText('Customers'), 'Answers');
        await user.type(screen.getByPlaceholderText(/onboarding e-mail/), ' Cached replies ');
        await user.click(createButton());
        await screen.findByText('The table is ready');
        expect(createManaged).toHaveBeenCalledWith(expect.objectContaining({ description: 'Cached replies' }));
    });
});
