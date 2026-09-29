import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { datatablesApi } from './datatablesApi';
import DatatablesStudio from './DatatablesStudio';

// The sharing panel reuses App Studio's useOrgDirectory, which is a react-query
// hook — so the section has a hard QueryClientProvider dependency. main.jsx
// supplies one app-wide; the tests must too, or the tab throws on mount.
vi.mock('../../../../utils/helpers', () => ({
    API_BASE: '',
    authFetch: vi.fn(async (url) => ({
        ok: true,
        status: 200,
        json: async () => (String(url).includes('/auth/groups')
            ? [{ id: 'g1', name: 'Sales' }, { id: 'g2', name: 'Support' }]
            : [{ id: 'u1', name: 'Ada', email: 'ada@example.com' }]),
    })),
}));

function renderStudio(props = {}) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
        <QueryClientProvider client={qc}>
            <DatatablesStudio {...props} />
        </QueryClientProvider>,
    );
}

vi.mock('./datatablesApi', () => {
    const datatablesApi = {
        list: vi.fn(), create: vi.fn(), get: vi.fn(), remove: vi.fn(),
        getSchema: vi.fn(), putSchema: vi.fn(),
        listRows: vi.fn(), addRow: vi.fn(), deleteRow: vi.fn(),
        setSharing: vi.fn(), listGrants: vi.fn(), addGrant: vi.fn(), removeGrant: vi.fn(),
        listUsage: vi.fn(),
    };
    return { datatablesApi, default: datatablesApi };
});

/**
 * The section that manages data OTHER routines depend on.
 *
 * Two things it must never do, and both are about telling the truth:
 *   - it must not describe a table's sharing more calmly than the server
 *     enforces it (an empty group list on a published table is the WHOLE
 *     organisation);
 *   - it must not turn a 404 into "you don't have access", because whether the
 *     table was deleted or simply never shared is exactly what the 404 refuses
 *     to reveal, and the copy must not undo that.
 */

const TABLE = {
    id: 'tbl_1', name: 'Customers', key: 'customers',
    description: 'People we already e-mailed.', rowCount: 3,
    isPublished: false, sharedGroups: [], writeMode: 'grants',
    scopeKind: 'org',
    grade: 'owner',
};

const ORG_SCOPE = { kind: 'org', id: 'org-a', label: 'your organisation' };
const PERSONAL_SCOPE = { kind: 'user', id: 'u-solo', label: 'this account' };

beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    datatablesApi.list.mockResolvedValue({ datatables: [TABLE], scope: ORG_SCOPE });
    datatablesApi.getSchema.mockResolvedValue({ fields: [{ key: 'email', name: 'Email', type: 'text' }], modelVersion: 4 });
    datatablesApi.listRows.mockResolvedValue({ rows: [], hasMore: false, count: 0 });
    datatablesApi.listGrants.mockResolvedValue({ grants: [] });
    datatablesApi.listUsage.mockResolvedValue({ usage: [] });
});

describe('the list', () => {
    it('shows a table with its scope and what you may do with it', async () => {
        renderStudio();
        expect(await screen.findByText('Customers')).toBeInTheDocument();
        expect(screen.getByText(/Private/)).toBeInTheDocument();
        expect(screen.getByText(/You own this table/)).toBeInTheDocument();
        expect(screen.getByText(/3 rows/)).toBeInTheDocument();
    });

    it('says who can create tables when the viewer cannot', async () => {
        datatablesApi.list.mockResolvedValue({ datatables: [], scope: ORG_SCOPE });
        renderStudio({ hasPermission: () => false });
        expect(await screen.findByText(/created by an administrator/i)).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /new table/i })).toBeNull();
    });

    it('offers creation to someone who may manage tables', async () => {
        datatablesApi.list.mockResolvedValue({ datatables: [], scope: ORG_SCOPE });
        renderStudio({ hasPermission: (p) => p === 'manage_datatables' });
        await screen.findByText(/No datatables yet/);
        expect(screen.getAllByRole('button', { name: /new table/i }).length).toBeGreaterThan(0);
    });

    it('states where a new ORGANISATION table would go, before the button is used', async () => {
        renderStudio({ hasPermission: () => true });
        expect(await screen.findByText(/belong to your organisation/i)).toBeInTheDocument();
    });

    it('an account with no organisation is offered its OWN scope, not a dead end', async () => {
        // BFSF-412: the Studio kept offering "New table" to an account whose
        // create the API refused. `manage_datatables` is an org permission, so
        // the button must not hang off it when the scope is personal.
        datatablesApi.list.mockResolvedValue({ datatables: [], scope: PERSONAL_SCOPE });
        renderStudio({ hasPermission: () => false });
        expect(await screen.findByText(/only this account can see them/i)).toBeInTheDocument();
        // Never "only you": the built-in admin login is commonly shared.
        expect(screen.queryByText(/only you can see/i)).toBeNull();
        expect(screen.getAllByRole('button', { name: /new table/i }).length).toBeGreaterThan(0);
        expect(screen.queryByText(/created by an administrator/i)).toBeNull();
    });

    it('a personal table is labelled Personal, not Private', async () => {
        // "Private" is a sharing state that can be changed; personal is not.
        datatablesApi.list.mockResolvedValue({
            datatables: [{ ...TABLE, scopeKind: 'user' }], scope: PERSONAL_SCOPE,
        });
        renderStudio();
        expect(await screen.findByText('Personal')).toBeInTheDocument();
        expect(screen.queryByText(/^Private$/)).toBeNull();
    });

    it('a deep link to a table you cannot reach does not say WHY', async () => {
        renderStudio({ initialDatatableId: 'tbl_someone_elses' });
        expect(await screen.findByText(/not available to you/i)).toBeInTheDocument();
        // "You do not have access" would confirm the table exists.
        expect(screen.queryByText(/do not have access|permission denied/i)).toBeNull();
    });
});

describe('the detail', () => {
    const openDetail = async () => {
        renderStudio({ initialDatatableId: 'tbl_1' });
        return screen.findByRole('radio', { name: /Columns/ });
    };

    it('opens on a deep link, on the Columns tab', async () => {
        await openDetail();
        expect(await screen.findByDisplayValue('Email')).toBeInTheDocument();
    });

    it('the Used by tab answers what would break', async () => {
        datatablesApi.listUsage.mockResolvedValue({
            usage: [{ automationId: 'a1', automationTitle: 'Nightly sync', stepId: 's1', mode: 'write', columns: ['email'] }],
        });
        await openDetail();
        fireEvent.click(await screen.findByRole('radio', { name: /Used by/ }));
        // The shared UsedByTab (Track 0.4) renders the row now, so the words
        // are its vocabulary — "writes", not this section's old sentence.
        // What must not change is the ANSWER: which thing, and what it does.
        const row = await screen.findByTestId('usage-row');
        expect(row).toHaveTextContent('Nightly sync');
        expect(row).toHaveTextContent(/writes/i);
    });

    it('shows the enriched usage row: which step, what it does, when it last ran', async () => {
        // The generic usage index (T3) carries `consumerKind`, `stepOrdinal`,
        // `stepOp` and `lastRunAt`, and `mode` may now be 'readwrite'. A row
        // that only said "reads" was the reason someone had to open the
        // automation to find out where the table was even touched.
        datatablesApi.listUsage.mockResolvedValue({
            usage: [{
                consumerKind: 'automation', consumerId: 'a1', consumerTitle: 'Credit check',
                consumerOwner: 'u1', automationId: 'a1', automationTitle: 'Credit check',
                automationOwner: 'u1', stepId: 's4', stepOrdinal: 4, stepType: 'datatable',
                stepOp: 'find_rows', mode: 'readwrite', columns: ['email'],
                lastRunAt: '2026-09-04T11:48:00.000Z',
            }],
        });
        renderStudio({ initialDatatableId: 'tbl_1', user: { id: 'u1' } });
        fireEvent.click(await screen.findByRole('radio', { name: /Used by/ }));
        const row = await screen.findByTestId('usage-row');
        expect(row).toHaveTextContent('Credit check');
        expect(row).toHaveTextContent(/step 4/);
        expect(row).toHaveTextContent(/find rows/);
        expect(row).toHaveTextContent(/reads and writes/i);
    });

    it('deleting names what it would break, and needs the name typed', async () => {
        datatablesApi.listUsage.mockResolvedValue({
            usage: [{ automationId: 'a1', automationTitle: 'Nightly sync', stepId: 's1', mode: 'read', columns: [] }],
        });
        await openDetail();
        fireEvent.click(await screen.findByRole('button', { name: /More about this table/ }));
        fireEvent.click(await screen.findByRole('menuitem', { name: /Delete this table/ }));
        // The shared DangerZone (Track 0.4) owns this block now — same two
        // gates in the same order: SEE what depends on it, then type the name.
        expect(await screen.findByTestId('danger-dependents')).toHaveTextContent('Nightly sync');
        const confirm = screen.getByRole('button', { name: /Delete for good/ });
        expect(confirm.disabled).toBe(true);
        // Scoped to the danger zone — the Columns tab behind it has its own
        // inputs, and an ambiguous query here would fail for a reason that has
        // nothing to do with the confirmation.
        const confirmBox = within(screen.getByTestId('danger-zone')).getByRole('textbox');
        fireEvent.change(confirmBox, { target: { value: 'Customers' } });
        expect(screen.getByRole('button', { name: /Delete for good/ }).disabled).toBe(false);
    });

    it('asks for the name even when nothing depends on the table — its rows ARE the data', async () => {
        await openDetail();
        fireEvent.click(await screen.findByRole('button', { name: /More about this table/ }));
        fireEvent.click(await screen.findByRole('menuitem', { name: /Delete this table/ }));
        await screen.findByTestId('danger-unused');
        expect(screen.getByRole('button', { name: /Delete for good/ }).disabled).toBe(true);
    });

    it('someone who only holds a grade cannot edit the columns, and is told who can', async () => {
        datatablesApi.list.mockResolvedValue({ datatables: [{ ...TABLE, grade: 'editor' }] });
        await openDetail();
        expect(await screen.findByText(/The table.s owner, or an administrator, can/)).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: /More about this table/ }));
        expect(screen.queryByRole('menuitem', { name: /Delete this table/ })).toBeNull();
    });
});

const openSharing = async (table) => {
    datatablesApi.list.mockResolvedValue({ datatables: [table] });
    renderStudio({ initialDatatableId: 'tbl_1' });
    fireEvent.click(await screen.findByRole('radio', { name: /Sharing/ }));
};

describe('the sharing panel states read and write separately', () => {
    it('org-published with invitation-only writes is NOT described as org-writable', async () => {
        await openSharing({ ...TABLE, isPublished: true, sharedGroups: [], writeMode: 'grants' });
        // Both halves of each sentence also appear on the controls above, so
        // locate each consequence LINE and assert the pairing inside it —
        // "who reads" and "who writes" being different answers is the point.
        const readLine = await screen.findByText(/can read every row/);
        expect(readLine.textContent).toMatch(/Everyone in your organisation/);
        const writeLine = screen.getByText(/Rows can be added, changed and deleted by/);
        expect(writeLine.textContent).toMatch(/only the people you invite/);
        expect(screen.queryByText(/anyone in your organisation can delete every row/i)).toBeNull();
    });

    it('the widest setting says so in as many words', async () => {
        await openSharing({ ...TABLE, isPublished: true, sharedGroups: [], writeMode: 'audience' });
        expect(await screen.findByText(/anyone in your organisation can delete every row/i)).toBeInTheDocument();
    });

    it('a 402 reads as "this is the paid part", not as a failure', async () => {
        const err = new Error('Upgrade required');
        err.status = 402;
        datatablesApi.setSharing.mockRejectedValue(err);
        await openSharing(TABLE);
        fireEvent.click(await screen.findByRole('radio', { name: /Entire organisation/ }));
        fireEvent.click(await screen.findByRole('button', { name: /Share it/ }));
        expect(await screen.findByText(/part of a paid plan/i)).toBeInTheDocument();
        expect(screen.getByText(/keep working exactly as they do now/i)).toBeInTheDocument();
    });

});

/**
 * The audience is a WORD the panel sends, never two fields that can disagree.
 * `{isPublished:true, sharedGroups:[]}` is the whole organisation, so every
 * path that could produce that pair by accident is pinned below — and every
 * path that hands someone new access asks before it does.
 */
describe('the sharing panel never widens by accident', () => {
    it('unticking the last group unpublishes rather than silently widening to the whole org', async () => {
        // An empty sharedGroups on a PUBLISHED table means the ENTIRE org, so
        // "remove the last group" must not be sent as a published table with [].
        datatablesApi.setSharing.mockResolvedValue({ datatable: TABLE });
        await openSharing({ ...TABLE, isPublished: true, sharedGroups: ['g1'], writeMode: 'grants' });
        await screen.findByText(/Specific groups/);
        const boxes = screen.getAllByRole('checkbox');
        const checked = boxes.find(b => b.checked);
        expect(checked, 'the selected group should be checked').toBeTruthy();
        fireEvent.click(checked);
        await waitFor(() => expect(datatablesApi.setSharing).toHaveBeenCalled());
        expect(datatablesApi.setSharing).toHaveBeenCalledWith('tbl_1', { audience: 'private' });
    });

    it('entering Specific groups on a private table sends NOTHING', async () => {
        // The mirror of the case above, on the way IN. An empty sharedGroups on
        // a published table is the whole organisation, so publishing on the
        // click would hand the rows to every colleague the moment someone picks
        // the narrowest option on the screen.
        await openSharing(TABLE);
        fireEvent.click(await screen.findByRole('radio', { name: /Specific groups/ }));
        expect(await screen.findByText(/picking a group is what shares the table/i)).toBeInTheDocument();
        expect(datatablesApi.setSharing).not.toHaveBeenCalled();
        // The picker is open, so the choice was not lost — only unsent.
        expect(screen.getAllByRole('checkbox').length).toBeGreaterThan(0);
    });

    it('ticking the first group names who gains access, then publishes with exactly that group', async () => {
        datatablesApi.setSharing.mockResolvedValue({ datatable: TABLE });
        await openSharing(TABLE);
        fireEvent.click(await screen.findByRole('radio', { name: /Specific groups/ }));
        fireEvent.click(screen.getAllByRole('checkbox')[0]);
        expect(datatablesApi.setSharing).not.toHaveBeenCalled();
        expect(await screen.findByText(/Members of Sales will be able to read every row/)).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: /Share it/ }));
        await waitFor(() => expect(datatablesApi.setSharing).toHaveBeenCalledWith(
            'tbl_1', { audience: 'groups', sharedGroups: ['g1'] }));
    });

    it('widening to the whole organisation asks first, and cancelling sends nothing', async () => {
        datatablesApi.setSharing.mockResolvedValue({ datatable: TABLE });
        await openSharing(TABLE);
        fireEvent.click(await screen.findByRole('radio', { name: /Entire organisation/ }));
        expect(datatablesApi.setSharing).not.toHaveBeenCalled();
        expect(await screen.findByText(/Everyone in your organisation will be able to read every row/))
            .toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: /Leave it as it is/ }));
        await waitFor(() => expect(screen.queryByRole('button', { name: /Share it/ })).toBeNull());
        expect(datatablesApi.setSharing).not.toHaveBeenCalled();
    });

    it('narrowing back to private does not ask — taking access away is one click', async () => {
        datatablesApi.setSharing.mockResolvedValue({ datatable: TABLE });
        await openSharing({ ...TABLE, isPublished: true, sharedGroups: [], writeMode: 'grants' });
        fireEvent.click(await screen.findByRole('radio', { name: /^Private/ }));
        await waitFor(() => expect(datatablesApi.setSharing).toHaveBeenCalledWith('tbl_1', { audience: 'private' }));
        expect(screen.queryByRole('button', { name: /Share it/ })).toBeNull();
    });

    it('opening writes to the whole audience names what they gain, in that order', async () => {
        datatablesApi.setSharing.mockResolvedValue({ datatable: TABLE });
        await openSharing({ ...TABLE, isPublished: true, sharedGroups: [], writeMode: 'grants' });
        const writeBox = (await screen.findAllByRole('checkbox')).find(
            b => b.closest('label')?.textContent?.includes('change it too'));
        fireEvent.click(writeBox);
        expect(datatablesApi.setSharing).not.toHaveBeenCalled();
        expect(await screen.findByText(/add, change and delete rows, not just read them/)).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: /Share it/ }));
        await waitFor(() => expect(datatablesApi.setSharing).toHaveBeenCalledWith('tbl_1', { writeMode: 'audience' }));
    });
});

/**
 * Creating a table, which the suite previously only asserted was OFFERED.
 *
 * The whole point of the scope work is which tenancy a new table lands in, and
 * that is decided in this dialog and nowhere else — so the request body it
 * sends is the thing worth pinning.
 */
describe('the create dialog', () => {
    const fill = () => {
        fireEvent.change(screen.getByPlaceholderText('Customers'), { target: { value: 'Leads' } });
        fireEvent.change(screen.getByPlaceholderText(/onboarding e-mail/i), {
            target: { value: 'inbound leads we have contacted' },
        });
    };

    it('an org member creates an ORGANISATION table by default', async () => {
        datatablesApi.list.mockResolvedValue({ datatables: [], scope: ORG_SCOPE });
        datatablesApi.create.mockResolvedValue({ datatable: { ...TABLE, id: 'tbl_new' } });
        renderStudio({ hasPermission: () => true });

        fireEvent.click((await screen.findAllByRole('button', { name: /new table/i }))[0]);
        fill();
        fireEvent.click(screen.getByRole('button', { name: /^Create$/ }));

        await waitFor(() => expect(datatablesApi.create).toHaveBeenCalled());
        expect(datatablesApi.create).toHaveBeenCalledWith({
            scope: 'organisation', name: 'Leads', key: 'leads',
            description: 'inbound leads we have contacted', fields: [],
        });
    });

    it('the same member can choose their own account instead', async () => {
        datatablesApi.list.mockResolvedValue({ datatables: [], scope: ORG_SCOPE });
        datatablesApi.create.mockResolvedValue({ datatable: { ...TABLE, id: 'tbl_new' } });
        renderStudio({ hasPermission: () => true });

        fireEvent.click((await screen.findAllByRole('button', { name: /new table/i }))[0]);
        fill();
        fireEvent.click(screen.getByRole('radio', { name: /This account only/ }));
        fireEvent.click(screen.getByRole('button', { name: /^Create$/ }));

        await waitFor(() => expect(datatablesApi.create).toHaveBeenCalledWith(
            expect.objectContaining({ scope: 'personal' })));
    });

    it('an org-less account gets the personal option only, and sends it', async () => {
        datatablesApi.list.mockResolvedValue({ datatables: [], scope: PERSONAL_SCOPE });
        datatablesApi.create.mockResolvedValue({ datatable: { ...TABLE, id: 'tbl_new', scopeKind: 'user' } });
        renderStudio({ hasPermission: () => false });

        fireEvent.click((await screen.findAllByRole('button', { name: /new table/i }))[0]);
        // A radio group with one dead half is worse than no radio group.
        expect(screen.queryByRole('radio', { name: /Your organisation/ })).toBeNull();
        fill();
        fireEvent.click(screen.getByRole('button', { name: /^Create$/ }));

        await waitFor(() => expect(datatablesApi.create).toHaveBeenCalledWith(
            expect.objectContaining({ scope: 'personal' })));
    });

    it('a refusal is read from its CODE, not from the server sentence', async () => {
        // Matching on the sentence breaks the day somebody improves the copy,
        // and silently: the dialog would just print whatever came back.
        const err = new Error('A table with this key already exists in your organisation');
        err.status = 409;
        err.code = 'key_taken';
        datatablesApi.list.mockResolvedValue({ datatables: [], scope: ORG_SCOPE });
        datatablesApi.create.mockRejectedValue(err);
        renderStudio({ hasPermission: () => true });

        fireEvent.click((await screen.findAllByRole('button', { name: /new table/i }))[0]);
        fill();
        fireEvent.click(screen.getByRole('button', { name: /^Create$/ }));

        expect(await screen.findByText(/already a table with this key/i)).toBeInTheDocument();
    });
});

describe('the sharing tab of a personal table', () => {
    it('is replaced by the reason there is none', async () => {
        datatablesApi.list.mockResolvedValue({
            datatables: [{ ...TABLE, scopeKind: 'user' }], scope: PERSONAL_SCOPE,
        });
        renderStudio({ initialDatatableId: 'tbl_1' });
        fireEvent.click(await screen.findByRole('radio', { name: /Sharing/ }));

        expect(await screen.findByText(/cannot be shared/i)).toBeInTheDocument();
        // No control that would suggest the rows could become visible.
        expect(screen.queryByRole('radio', { name: /Entire organisation/ })).toBeNull();
        expect(screen.queryByRole('radio', { name: /Specific groups/ })).toBeNull();
        expect(screen.queryByText(/only you/i)).toBeNull();
    });

    it('its owner can still edit the columns without manage_datatables', async () => {
        // The permission is org_admin-only, and the server does not ask for it
        // on a personal table — so neither may the surface, or the account that
        // just created one cannot add a column to it.
        datatablesApi.list.mockResolvedValue({
            datatables: [{ ...TABLE, scopeKind: 'user' }], scope: PERSONAL_SCOPE,
        });
        renderStudio({ initialDatatableId: 'tbl_1', hasPermission: () => false });
        expect(await screen.findByDisplayValue('Email')).toBeInTheDocument();
        expect(screen.queryByText(/The table.s owner, or an administrator, can/)).toBeNull();
    });
});
