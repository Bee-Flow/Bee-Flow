import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { datatablesApi } from './datatablesApi';
import NewDatatableDialog from './NewDatatableDialog';

/**
 * Who the "Your organisation" card is offered to.
 *
 * Being IN an organisation is not the same as being allowed to put a table in
 * it: POST /api/datatables gates the organisation scope on `manage_datatables`
 * and nothing else (server/routes/datatables/tables.js). The dialog used to
 * offer that card to every member, PRESELECT it, and hand the resulting 403
 * back under the Create button — a path the system already knew was forbidden
 * before the click.
 *
 * Three things are pinned here, because dropping any one of them brings the
 * false door back:
 *   - the card is not offered to a member who cannot use it, and the request
 *     that goes out says `personal`, which the server really does accept;
 *   - the missing half is EXPLAINED, with the exact permission demoted to the
 *     tooltip rather than deleted — the administrator it gets forwarded to
 *     needs that string;
 *   - a session that states no permissions at all is UNKNOWN, not "no": the
 *     choice stays, because narrowing on an absence would take the
 *     organisation away from the org admin this dialog exists for.
 */

vi.mock('./datatablesApi', () => {
    const datatablesApi = {
        list: vi.fn(), create: vi.fn(), createManaged: vi.fn(),
        linkable: vi.fn(), describeNc: vi.fn(), linkNc: vi.fn(),
        spreadsheetProviders: vi.fn(),
    };
    return { datatablesApi, default: datatablesApi };
});

const ORG_SCOPE = { kind: 'org', id: 'org-a', label: 'your organisation' };
const MEMBER = { id: 'u1', permissions: ['use_datatables', 'use_automations'] };
const MANAGER = { id: 'u2', permissions: ['use_datatables', 'manage_datatables'] };

beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    datatablesApi.spreadsheetProviders.mockResolvedValue({ providers: [] });
});

const open = (props = {}) => render(
    <NewDatatableDialog scope={ORG_SCOPE} onClose={() => {}} onCreated={() => {}} {...props} />,
);

const fill = () => {
    fireEvent.change(screen.getByPlaceholderText('Customers'), { target: { value: 'Leads' } });
    fireEvent.change(screen.getByPlaceholderText(/onboarding e-mail/i), {
        target: { value: 'inbound leads we have contacted' },
    });
};

describe('the organisation card and the permission behind it', () => {
    it('is offered to a member who holds manage_datatables, and is the default', async () => {
        datatablesApi.create.mockResolvedValue({ datatable: { id: 'tbl_new' } });
        open({ user: MANAGER });
        expect(screen.getByRole('radio', { name: /Your organisation/ })).toBeInTheDocument();
        fill();
        fireEvent.click(screen.getByRole('button', { name: /^Create$/ }));
        await waitFor(() => expect(datatablesApi.create).toHaveBeenCalledWith(
            expect.objectContaining({ scope: 'organisation' })));
    });

    it('is not offered to a member without it — and the table really goes personal', async () => {
        datatablesApi.create.mockResolvedValue({ datatable: { id: 'tbl_new' } });
        open({ user: MEMBER });
        expect(screen.queryByRole('radio', { name: /Your organisation/ })).toBeNull();
        fill();
        fireEvent.click(screen.getByRole('button', { name: /^Create$/ }));
        await waitFor(() => expect(datatablesApi.create).toHaveBeenCalledWith(
            expect.objectContaining({ scope: 'personal' })));
    });

    it('says WHY the organisation half is gone, and keeps the exact permission in the tooltip', () => {
        open({ user: MEMBER });
        expect(screen.getByText(/needs a permission this account does not have/i)).toBeInTheDocument();
        expect(screen.getByTitle('manage_datatables')).toBeInTheDocument();
    });

    it('says nothing of the sort to an account that simply has no organisation', () => {
        open({ user: MEMBER, scope: { kind: 'user', id: 'u1', label: 'this account' } });
        expect(screen.queryByText(/needs a permission this account does not have/i)).toBeNull();
        expect(screen.queryByTitle('manage_datatables')).toBeNull();
    });

    it('treats a session that states no permissions as unknown, not as a refusal', () => {
        // An embed, a test, an older call site: it told us nothing about this
        // account, and reading silence as "no" would hide the organisation from
        // the very admin the Studio section exists for.
        open({ user: { id: 'u3' } });
        expect(screen.getByRole('radio', { name: /Your organisation/ })).toBeInTheDocument();
        open({ user: null });
        expect(screen.getAllByRole('radio', { name: /Your organisation/ }).length).toBeGreaterThan(0);
    });

    it('lets an admin flag stand in for the permission', () => {
        open({ user: { id: 'u4', isAdmin: true, permissions: [] } });
        expect(screen.getByRole('radio', { name: /Your organisation/ })).toBeInTheDocument();
    });
});
