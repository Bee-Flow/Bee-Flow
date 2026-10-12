// The "People and teams" list on a datatable's sharing tab.
//
// The server answers GET /grants with the stored row's spelling
// (`grantee_type` / `grantee_id`); the list read `granteeType` / `granteeId`,
// so a group grant such as Purchasing showed as "? A person" and a grade
// change re-sent an empty grantee.

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import DatatableSharing from './DatatableSharing';
import { datatablesApi } from './datatablesApi';
import { readGrant, readGrants } from './grants';

vi.mock('./datatablesApi', () => {
    const datatablesApi = {
        listGrants: vi.fn(), addGrant: vi.fn(), removeGrant: vi.fn(), setSharing: vi.fn(),
    };
    return { datatablesApi, default: datatablesApi };
});
vi.mock('../AppStudio/rbac/useAppRoles', () => ({
    useOrgDirectory: () => ({
        users: [{ id: 'u-owner', name: 'Olivia Owner' }, { id: 'u-ann', name: 'Ann Reader' }],
        groups: [{ id: 'g-purchasing', name: 'Purchasing' }],
        available: true,
        isLoading: false,
    }),
}));

const api = datatablesApi as unknown as Record<string, ReturnType<typeof vi.fn>>;

const TABLE = {
    id: 'tbl_1', name: 'Suppliers', isPublished: false, sharedGroups: [], writeMode: 'grants',
    scopeKind: 'org', grade: 'owner', ownerUserId: 'u-owner',
};

beforeEach(() => {
    Object.values(api).forEach((fn) => fn.mockReset());
    api.listGrants.mockResolvedValue({
        grants: [
            { id: 'gr1', datatableId: 'tbl_1', grantee_type: 'group', grantee_id: 'g-purchasing', grade: 'viewer' },
            { id: 'gr2', datatableId: 'tbl_1', grantee_type: 'user', grantee_id: 'u-ann', grade: 'editor' },
        ],
    });
    api.addGrant.mockResolvedValue({ grants: [] });
});

function rowOf(name: string) {
    const row = screen.getByText(name).closest('div.grid');
    if (!row) throw new Error(`no grant row for ${name}`);
    return row as HTMLElement;
}

it('shows a group grant by the group name, labelled as a group', async () => {
    render(<DatatableSharing table={TABLE} canEdit onChanged={vi.fn()} />);
    await screen.findByText('Purchasing');
    const row = rowOf('Purchasing');
    expect(within(row).getByText('A group')).toBeTruthy();
    expect(within(row).queryByText('A person')).toBeNull();
    expect(within(row).queryByText('?')).toBeNull();
});

it('shows a person grant by the person name, labelled as a person', async () => {
    render(<DatatableSharing table={TABLE} canEdit onChanged={vi.fn()} />);
    await screen.findByText('Ann Reader');
    const row = rowOf('Ann Reader');
    expect(within(row).getByText('A person')).toBeTruthy();
    expect(within(row).getByText('AR')).toBeTruthy();
});

it('changing a group grant re-sends the group as the grantee', async () => {
    const user = userEvent.setup();
    render(<DatatableSharing table={TABLE} canEdit onChanged={vi.fn()} />);
    await screen.findByText('Purchasing');
    await user.selectOptions(within(rowOf('Purchasing')).getByRole('combobox'), 'editor');
    await waitFor(() => expect(api.addGrant).toHaveBeenCalledWith('tbl_1', {
        granteeType: 'group', granteeId: 'g-purchasing', grade: 'editor',
    }));
});

it('readGrant accepts both spellings and drops what it cannot read', () => {
    expect(readGrant({ id: 'a', grantee_type: 'group', grantee_id: 'g1', grade: 'editor' }))
        .toEqual({ id: 'a', granteeType: 'group', granteeId: 'g1', grade: 'editor' });
    expect(readGrant({ id: 'b', granteeType: 'user', granteeId: 'u1', grade: 'viewer' }))
        .toEqual({ id: 'b', granteeType: 'user', granteeId: 'u1', grade: 'viewer' });
    expect(readGrant({ id: 'c', grantee_type: 'org', grantee_id: 'o1' })).toBeNull();
    expect(readGrant({ id: 'd', grantee_type: 'user' })).toBeNull();
    expect(readGrants(null)).toEqual([]);
    expect(readGrants([{ id: 'e', grantee_type: 'user', grantee_id: 'u1', grade: 'owner' }, 'junk']))
        .toEqual([{ id: 'e', granteeType: 'user', granteeId: 'u1', grade: 'viewer' }]);
});
