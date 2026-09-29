import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { datatablesApi } from './datatablesApi';
import NewDatatableDialog from './NewDatatableDialog';

/**
 * The fourth card — "A spreadsheet from your files" — and its hand-off to
 * the wizard.
 *
 *  - gated by ONE cheap probe, asked on open for every account: absent on
 *    an empty answer, absent when the probe fails, absent when the client
 *    has no such method at all (a test double, an older server) — and in
 *    none of those cases is the dialog broken;
 *  - present-and-enabled with one storage connected; present-but-DISABLED
 *    with the reason when every listed storage is off;
 *  - a Nextcloud-bound account sees BOTH mirror cards;
 *  - choosing it swaps the form for "Choose files…" and keeps only the
 *    audience choice; Back keeps the card chosen;
 *  - the wizard's answer is "The tables are ready" with the file-flavoured
 *    sentence and the warnings verbatim;
 *  - the ordinary path never links anything.
 */

vi.mock('./datatablesApi', () => {
    const datatablesApi = {
        list: vi.fn(), create: vi.fn(), createManaged: vi.fn(),
        linkable: vi.fn(), describeNc: vi.fn(), linkNc: vi.fn(),
        spreadsheetProviders: vi.fn(), browseSpreadsheets: vi.fn(), describeSpreadsheet: vi.fn(), linkSpreadsheets: vi.fn(),
    };
    return { datatablesApi, default: datatablesApi };
});

const ORG_SCOPE = { kind: 'org', id: 'org-a', label: 'your organisation' };
const USER = { id: 'u1', permissions: ['all'] };
const NC_USER = { id: 'u1', ncOrg: { instanceId: 'inst_1' } };
const CONNECTED = { providers: [{ provider: 'google_drive', connected: true }] };
const CARD = /spreadsheet from your files/;

const CSV = {
    provider: 'google_drive', fileId: 'c1', name: 'klanten.csv', format: 'csv', webUrl: null, owned: true,
    write: { mode: 'csv_put', reason: null, caveats: [] },
    sheets: [{ name: 'klanten', index: 0, rows: 5, cols: 2, hidden: false, linkedAs: [] }],
    sheet: {
        name: 'klanten', headerRow: 1,
        columns: [
            { col: 0, letter: 'A', header: 'Naam', key: 'naam', type: 'text', unique: true, blankHeader: false, duplicateHeader: false, formula: false, samples: ['Acme'] },
            { col: 1, letter: 'B', header: 'Land', key: 'land', type: 'text', unique: false, blankHeader: false, duplicateHeader: false, formula: false, samples: ['NL'] },
        ],
        preview: { rows: [['Naam', 'Land'], ['Acme', 'NL']] }, rowCount: 5, truncated: false,
    },
    keyCandidates: [0], warnings: [],
};

beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    datatablesApi.spreadsheetProviders.mockResolvedValue(CONNECTED);
    datatablesApi.linkable.mockResolvedValue({ connected: true, tables: [] });
    datatablesApi.browseSpreadsheets.mockResolvedValue({
        provider: 'google_drive', folder: { id: 'root', name: 'My Drive', path: [] },
        items: [{ id: 'c1', name: 'klanten.csv', kind: 'file', format: 'csv', owned: true }], nextPageToken: null,
    });
    datatablesApi.describeSpreadsheet.mockResolvedValue(CSV);
});

const open = (props = {}) => render(
    <NewDatatableDialog scope={ORG_SCOPE} onClose={() => {}} onCreated={() => {}} user={USER} {...props} />,
);

describe('the probe', () => {
    it('is asked once on open — with no scope for an organisation account, "personal" otherwise', async () => {
        open();
        await waitFor(() => expect(datatablesApi.spreadsheetProviders).toHaveBeenCalledTimes(1));
        expect(datatablesApi.spreadsheetProviders).toHaveBeenCalledWith(undefined);
        cleanup();
        vi.clearAllMocks();
        datatablesApi.spreadsheetProviders.mockResolvedValue(CONNECTED);
        open({ scope: { kind: 'user', id: 'u1' } });
        await waitFor(() => expect(datatablesApi.spreadsheetProviders).toHaveBeenCalledWith('personal'));
    });

    it('an empty answer hides the card', async () => {
        datatablesApi.spreadsheetProviders.mockResolvedValue({ providers: [] });
        open();
        await waitFor(() => expect(datatablesApi.spreadsheetProviders).toHaveBeenCalled());
        await waitFor(() => expect(screen.getByPlaceholderText('Customers')).toBeInTheDocument());
        expect(screen.queryByRole('radio', { name: CARD })).toBeNull();
    });

    it('a failed probe hides the card and breaks nothing', async () => {
        datatablesApi.spreadsheetProviders.mockRejectedValue(new Error('boom'));
        open();
        await waitFor(() => expect(datatablesApi.spreadsheetProviders).toHaveBeenCalled());
        expect(screen.getByPlaceholderText('Customers')).toBeInTheDocument();
        expect(screen.queryByRole('radio', { name: CARD })).toBeNull();
        expect(screen.getByRole('radio', { name: /ordinary table/ })).toBeChecked();
    });

    it('a client without the method hides the card and breaks nothing', async () => {
        const saved = datatablesApi.spreadsheetProviders;
        delete datatablesApi.spreadsheetProviders;
        try {
            open();
            expect(screen.getByPlaceholderText('Customers')).toBeInTheDocument();
            expect(screen.getByRole('radio', { name: /Web service answers/ })).toBeInTheDocument();
            expect(screen.queryByRole('radio', { name: CARD })).toBeNull();
        } finally {
            datatablesApi.spreadsheetProviders = saved;
        }
    });
});

describe('the card', () => {
    it('is present and enabled with one storage connected', async () => {
        open();
        const radio = await screen.findByRole('radio', { name: CARD });
        expect(radio).not.toBeDisabled();
        expect(screen.getByText(/kept in step with the file/)).toBeInTheDocument();
    });

    it('is shown but disabled, with the reason, when every listed storage is off', async () => {
        datatablesApi.spreadsheetProviders.mockResolvedValue({ providers: [
            { provider: 'onedrive', connected: false, reason: 'needs_reauth' },
            { provider: 'google_drive', connected: false, reason: 'integration_off' },
        ] });
        open();
        const radio = await screen.findByRole('radio', { name: CARD });
        expect(radio).toBeDisabled();
        expect(screen.getByText(/OneDrive connection has expired/)).toBeInTheDocument();
    });

    it('sits beside the Nextcloud card for a Nextcloud-bound account', async () => {
        open({ user: NC_USER });
        expect(await screen.findByRole('radio', { name: /table from Nextcloud/ })).toBeInTheDocument();
        expect(await screen.findByRole('radio', { name: CARD })).toBeInTheDocument();
        expect(datatablesApi.linkable).toHaveBeenCalledTimes(1);
        expect(datatablesApi.spreadsheetProviders).toHaveBeenCalledTimes(1);
    });

    it('when chosen, hides the per-table fields, keeps the audience, and hands over to the wizard', async () => {
        open();
        fireEvent.click(await screen.findByRole('radio', { name: CARD }));
        expect(screen.queryByPlaceholderText('Customers')).toBeNull();
        expect(screen.queryByText(/Add a column/)).toBeNull();
        expect(screen.getByRole('radio', { name: /Your organisation/ })).toBeInTheDocument();
        expect(screen.getByText(/chosen per sheet in the next step/)).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: /Choose files/ }));
        expect(await screen.findByText(/Link spreadsheets from your files/)).toBeInTheDocument();
        expect(await screen.findByRole('checkbox', { name: 'klanten.csv' })).toBeInTheDocument();
        // Back restores the dialog with the card still chosen.
        fireEvent.click(screen.getByRole('button', { name: /Back/ }));
        expect(await screen.findByRole('radio', { name: CARD })).toBeChecked();
        expect(screen.queryByPlaceholderText('Customers')).toBeNull();
    });

    it('the ordinary card still creates an ordinary table and links nothing', async () => {
        datatablesApi.create.mockResolvedValue({ datatable: { id: 'tbl_x' } });
        const onCreated = vi.fn();
        open({ onCreated });
        await screen.findByRole('radio', { name: CARD });
        fireEvent.change(screen.getByPlaceholderText('Customers'), { target: { value: 'Klanten' } });
        fireEvent.change(screen.getByPlaceholderText(/onboarding e-mail/), { target: { value: 'the list' } });
        fireEvent.click(screen.getByRole('button', { name: /^Create$/ }));
        await waitFor(() => expect(datatablesApi.create).toHaveBeenCalled());
        expect(datatablesApi.create.mock.calls[0][0]).toMatchObject({ name: 'Klanten', key: 'klanten', scope: 'organisation' });
        expect(datatablesApi.linkSpreadsheets).not.toHaveBeenCalled();
        expect(datatablesApi.browseSpreadsheets).not.toHaveBeenCalled();
    });
});

describe('linking through the wizard', () => {
    it('shows "The tables are ready" with the file-flavoured sentence and the warnings verbatim', async () => {
        const warning = '"klanten": 2 rows had no value in Naam and were skipped.';
        datatablesApi.linkSpreadsheets.mockResolvedValue({ datatables: [{ id: 'tbl_new', name: 'klanten', managedKind: 'spreadsheet_file' }], warnings: [warning], partial: false });
        const onCreated = vi.fn();
        open({ onCreated });
        fireEvent.click(await screen.findByRole('radio', { name: CARD }));
        fireEvent.click(await screen.findByRole('button', { name: /Choose files/ }));
        fireEvent.click(await screen.findByRole('checkbox', { name: 'klanten.csv' }));
        fireEvent.click(screen.getByRole('button', { name: /^Next$/ }));       // sheets: the csv selects itself
        await waitFor(() => expect(screen.getByRole('button', { name: /^Next$/ })).not.toBeDisabled());
        fireEvent.click(screen.getByRole('button', { name: /^Next$/ }));       // names
        expect((await screen.findAllByDisplayValue('klanten')).length).toBe(2);   // name + technical name
        fireEvent.click(screen.getByRole('button', { name: /^Next$/ }));       // relations
        fireEvent.click(await screen.findByRole('button', { name: /^Next$/ })); // review
        fireEvent.click(await screen.findByRole('button', { name: 'Link the sheet' }));
        await waitFor(() => expect(datatablesApi.linkSpreadsheets).toHaveBeenCalled());
        expect(datatablesApi.linkSpreadsheets.mock.calls[0][0]).toMatchObject({
            scope: 'organisation',
            tables: [{ provider: 'google_drive', fileId: 'c1', sheet: 'klanten', headerRow: 1, keyColumn: null, name: 'klanten', key: 'klanten' }],
            relations: [],
        });
        expect(await screen.findByText(/The tables are ready/)).toBeInTheDocument();
        expect(screen.getByText(/being filled in from the file now/)).toBeInTheDocument();
        expect(screen.getByText(warning)).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: /Open the table/ }));
        expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: 'tbl_new' }));
        expect(datatablesApi.linkNc).not.toHaveBeenCalled();
    });
});
