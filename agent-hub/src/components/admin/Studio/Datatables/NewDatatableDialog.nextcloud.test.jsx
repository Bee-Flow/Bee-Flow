import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { datatablesApi } from './datatablesApi';
import NewDatatableDialog from './NewDatatableDialog';

/**
 * The third card — "A table from Nextcloud" — and its hand-off to the wizard.
 *
 *  - absent without a Nextcloud-bound org (and there is no feature flag);
 *  - present-but-DISABLED, with the server's reason, when linking is not
 *    possible right now (the dialog is opened inside Nextcloud, where a
 *    hidden option is a support ticket);
 *  - choosing it swaps the form for "Choose tables…" and keeps only the
 *    audience choice; the linkable list is fetched once, on open;
 *  - the wizard's answer is shown as "The tables are ready" with the
 *    warnings verbatim;
 *  - the ordinary path never asks the server about Nextcloud at all.
 */

vi.mock('./datatablesApi', () => {
    const datatablesApi = {
        list: vi.fn(), create: vi.fn(), createManaged: vi.fn(),
        linkable: vi.fn(), describeNc: vi.fn(), linkNc: vi.fn(),
    };
    return { datatablesApi, default: datatablesApi };
});

const ORG_SCOPE = { kind: 'org', id: 'org-a', label: 'your organisation' };
const NC_USER = { id: 'u1', ncOrg: { instanceId: 'inst_1' } };
const LINKABLE = { connected: true, tables: [{ ncTableId: 4, title: 'Facturen', rowsCount: 2, columnsCount: 6, views: [], linkedAs: [] }] };

beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    datatablesApi.linkable.mockResolvedValue(LINKABLE);
    datatablesApi.describeNc.mockResolvedValue({ columns: [] });
});

const open = (props = {}) => render(
    <NewDatatableDialog scope={ORG_SCOPE} onClose={() => {}} onCreated={() => {}} user={NC_USER} {...props} />,
);

describe('the Nextcloud card', () => {
    it('is absent without a Nextcloud-bound organisation, and never asks the server', () => {
        open({ user: { id: 'u1', permissions: ['all'] } });
        expect(screen.queryByRole('radio', { name: /table from Nextcloud/ })).toBeNull();
        expect(datatablesApi.linkable).not.toHaveBeenCalled();
    });

    it('is present for every member of a Nextcloud-bound organisation — no feature flag', async () => {
        open({ user: { id: 'u1', ncOrg: { instanceId: 'x' }, canUseFeature: {}, permissions: [] } });
        expect(await screen.findByRole('radio', { name: /table from Nextcloud/ })).toBeInTheDocument();
    });

    it('is shown but disabled, with the reason, when the account may not read Nextcloud tables', async () => {
        datatablesApi.linkable.mockResolvedValue({ connected: false, reason: 'nc_scope_denied', tables: [] });
        open();
        const radio = await screen.findByRole('radio', { name: /table from Nextcloud/ });
        await waitFor(() => expect(radio).toBeDisabled());
        expect(screen.getByText(/Switch Tables on under Settings/)).toBeInTheDocument();
    });

    it('when chosen, hides the per-table fields, keeps the audience, and hands over to the wizard', async () => {
        open();
        const radio = await screen.findByRole('radio', { name: /table from Nextcloud/ });
        await waitFor(() => expect(radio).not.toBeDisabled());
        fireEvent.click(radio);
        expect(screen.queryByPlaceholderText('Customers')).toBeNull();
        expect(screen.queryByText(/Add a column/)).toBeNull();
        expect(screen.getByRole('radio', { name: /Your organisation/ })).toBeInTheDocument();
        expect(screen.getByText(/chosen per table in the next step/)).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: /Choose tables/ }));
        expect(await screen.findByText(/Link tables from Nextcloud/)).toBeInTheDocument();
        expect(screen.getByRole('checkbox', { name: 'Facturen' })).toBeInTheDocument();
        expect(datatablesApi.linkable).toHaveBeenCalledTimes(1);
        // Back restores the dialog with the card still chosen.
        fireEvent.click(screen.getByRole('button', { name: /Back/ }));
        expect(await screen.findByRole('radio', { name: /table from Nextcloud/ })).toBeChecked();
    });

    it('the ordinary card still creates an ordinary table', async () => {
        datatablesApi.create.mockResolvedValue({ datatable: { id: 'tbl_x' } });
        const onCreated = vi.fn();
        open({ onCreated });
        fireEvent.change(screen.getByPlaceholderText('Customers'), { target: { value: 'Klanten' } });
        fireEvent.change(screen.getByPlaceholderText(/onboarding e-mail/), { target: { value: 'the list' } });
        fireEvent.click(screen.getByRole('button', { name: /^Create$/ }));
        await waitFor(() => expect(datatablesApi.create).toHaveBeenCalled());
        expect(datatablesApi.create.mock.calls[0][0]).toMatchObject({ name: 'Klanten', key: 'klanten', scope: 'organisation' });
        expect(datatablesApi.linkNc).not.toHaveBeenCalled();
    });
});

describe('linking through the wizard', () => {
    it('sends the exact body and shows the server\'s warnings verbatim', async () => {
        const warning = '"Facturen": one column links to a table that is not linked here.';
        datatablesApi.linkNc.mockResolvedValue({ datatables: [{ id: 'tbl_new', name: 'Facturen', managedKind: 'nextcloud_table' }], warnings: [warning] });
        const onCreated = vi.fn();
        open({ onCreated });
        fireEvent.click(await screen.findByRole('radio', { name: /table from Nextcloud/ }));
        fireEvent.click(await screen.findByRole('button', { name: /Choose tables/ }));
        fireEvent.click(await screen.findByRole('checkbox', { name: 'Facturen' }));
        fireEvent.click(screen.getByRole('button', { name: /^Next$/ }));       // names
        expect(await screen.findByDisplayValue('facturen')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: /^Next$/ }));       // relations
        fireEvent.click(screen.getByRole('button', { name: /^Next$/ }));       // review
        fireEvent.click(screen.getByRole('button', { name: /Link the table/ }));
        await waitFor(() => expect(datatablesApi.linkNc).toHaveBeenCalled());
        expect(datatablesApi.linkNc).toHaveBeenCalledWith({
            scope: 'organisation',
            tables: [{ ncTableId: 4, name: 'Facturen', key: 'facturen' }],
            relations: [],
        });
        expect(await screen.findByText(/The tables are ready/)).toBeInTheDocument();
        expect(screen.getByText(warning)).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: /Open the table/ }));
        expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: 'tbl_new' }));
    });

    it('a refusal keeps the wizard open and points at the table it is about', async () => {
        const err = Object.assign(new Error('taken'), { status: 409, code: 'already_linked', body: { ncTableId: 4, datatableId: 'tbl_old' } });
        datatablesApi.linkNc.mockRejectedValue(err);
        open();
        fireEvent.click(await screen.findByRole('radio', { name: /table from Nextcloud/ }));
        fireEvent.click(await screen.findByRole('button', { name: /Choose tables/ }));
        fireEvent.click(await screen.findByRole('checkbox', { name: 'Facturen' }));
        fireEvent.click(screen.getByRole('button', { name: /^Next$/ }));
        fireEvent.click(await screen.findByRole('button', { name: /^Next$/ }));
        fireEvent.click(await screen.findByRole('button', { name: /^Next$/ }));
        fireEvent.click(await screen.findByRole('button', { name: /Link the table/ }));
        expect((await screen.findAllByText(/already linked here/)).length).toBeGreaterThan(0);
        // back on the tables step, the row is marked
        expect(screen.getByRole('checkbox', { name: 'Facturen' })).toBeInTheDocument();
    });
});
