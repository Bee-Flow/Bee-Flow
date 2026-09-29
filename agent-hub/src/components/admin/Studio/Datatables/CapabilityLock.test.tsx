import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The two licence lines that run THROUGH a datatable's tabs rather than
 * around them.
 *
 *  - Retention (`datatable_retention`): setting a window, or making one
 *    longer, is the paid part. Shortening a window and switching it off must
 *    stay one click away on every plan, because keeping data no longer than
 *    needed can never wait on a licence.
 *  - Sharing (`automation_sharing`): the server refuses with 403
 *    `feature_locked` (no `code`), and the tab used to wait for a 402 or a
 *    `capability_required` code that never came, so the person saw the bare
 *    word "feature_locked" instead of the paid-plan notice.
 */

const { ent, api } = vi.hoisted(() => ({
    ent: {
        current: { loading: false, error: null as unknown, lockReason: (_id: string): string | null => null },
    },
    api: {
        update: vi.fn(),
        listRows: vi.fn(),
        listGrants: vi.fn(),
        setSharing: vi.fn(),
        addGrant: vi.fn(),
        removeGrant: vi.fn(),
    },
}));

vi.mock('../../../licensing/EntitlementsContext', () => ({ useEntitlements: () => ent.current }));
vi.mock('./datatablesApi', () => ({ datatablesApi: api, default: api }));
vi.mock('../AppStudio/rbac/useAppRoles', () => ({
    useOrgDirectory: () => ({ users: [{ id: 'u2', name: 'Someone' }], groups: [], isLoading: false, available: true }),
}));

import { licenceRefusal } from './CapabilityLock';
import DatatableSharing from './DatatableSharing';
import RetentionPanel from './RetentionPanel';

const COLUMNS = [
    { key: 'email', name: 'E-mail', type: 'text' },
    { key: 'signed_at', name: 'Signed on', type: 'datetime' },
];

const TABLE = {
    id: 'tbl_1', name: 'Customers', managedKind: null, scopeKind: 'org', grade: 'owner',
    isPublished: false, sharedGroups: [], writeMode: 'grants', ownerUserId: 'u1',
    retentionDays: null as number | null, retentionField: null as string | null, lastRetentionAt: null,
};

/** The error datatablesApi throws for a licence refusal: the body's word as message, no code. */
function refusal(word: 'feature_locked' | 'feature_disabled', feature: string) {
    return Object.assign(new Error(word), { status: 403, code: null, body: { error: word, feature } });
}

function lockOnly(id: string, reason = 'ceiling') {
    ent.current = { loading: false, error: null, lockReason: (asked: string) => (asked === id ? reason : null) };
}

function retention(table = TABLE) {
    // `as never[]`: the panel is JSX, and TS reads its `columns = []` default as never[].
    render(<RetentionPanel table={table} canEdit columns={COLUMNS as never[]} onChanged={() => {}} />);
}

const segment = (name: RegExp) => screen.getByRole('radio', { name }) as HTMLButtonElement;

beforeEach(() => {
    vi.clearAllMocks();
    ent.current = { loading: false, error: null, lockReason: () => null };
    api.update.mockResolvedValue({ datatable: TABLE });
    api.listRows.mockResolvedValue({ rows: [], hasMore: false });
    api.listGrants.mockResolvedValue({ grants: [] });
});

describe('licenceRefusal', () => {
    it('reads the server word, not a code the refusal never carries', () => {
        expect(licenceRefusal(refusal('feature_locked', 'x'))).toBe('ceiling');
        expect(licenceRefusal(refusal('feature_disabled', 'x'))).toBe('not_granted');
        // The older spellings still count, so nothing that worked stops working.
        expect(licenceRefusal({ status: 402 })).toBe('ceiling');
        expect(licenceRefusal({ status: 403, code: 'capability_required' })).toBe('ceiling');
        expect(licenceRefusal({ status: 403, code: 'forbidden', body: { error: 'Access denied' } })).toBeNull();
        expect(licenceRefusal(null)).toBeNull();
    });
});

describe('retention without the licence', () => {
    it('locks every way to SET a window, and leaves "Never" alone', () => {
        lockOnly('datatable_retention');
        retention();
        for (const name of [/^7 days/, /^30 days/, /^90 days/, /Other/]) expect(segment(name).disabled).toBe(true);
        expect(segment(/Never/).disabled).toBe(false);
        expect(screen.getByTestId('retention-locked').textContent).toMatch(/higher plan.*shorten a window or switch it off/);
    });

    it('lets a window get shorter or be switched off, but not longer or moved to another column', async () => {
        lockOnly('datatable_retention');
        retention({ ...TABLE, retentionDays: 30, retentionField: 'signed_at' });
        expect(segment(/^7 days/).disabled).toBe(false);
        expect(segment(/^90 days/).disabled).toBe(true);
        expect((screen.getByLabelText(/Date column the age is measured from/i) as HTMLSelectElement).disabled).toBe(true);

        await userEvent.click(segment(/^7 days/));
        await waitFor(() => expect(api.update).toHaveBeenCalledWith('tbl_1', { retentionDays: 7, retentionField: 'signed_at' }));
        await userEvent.click(segment(/Never/));
        await waitFor(() => expect(api.update).toHaveBeenLastCalledWith('tbl_1', { retentionDays: null }));
    });

    it('applies a shorter custom window, and will not apply a longer one', async () => {
        lockOnly('datatable_retention');
        retention({ ...TABLE, retentionDays: 30, retentionField: 'signed_at' });
        await userEvent.click(segment(/Other/));
        const box = await screen.findByLabelText(/^Days$/i);
        const apply = screen.getByRole('button', { name: /^Apply$/ }) as HTMLButtonElement;

        await userEvent.clear(box);
        await userEvent.type(box, '45');
        expect(apply.disabled).toBe(true);

        await userEvent.clear(box);
        await userEvent.type(box, '14');
        expect(apply.disabled).toBe(false);
        await userEvent.click(apply);
        await waitFor(() => expect(api.update).toHaveBeenCalledWith('tbl_1', { retentionDays: 14, retentionField: 'signed_at' }));
    });

    it('says "ask an admin" when the plan has it but the organisation has not switched it on', () => {
        lockOnly('datatable_retention', 'not_granted');
        retention();
        expect(screen.getByTestId('retention-locked').textContent).toMatch(/not switched on for your organisation/);
    });

    it('turns a refusal the screen did not see coming into the same sentence', async () => {
        // Entitlements still loading: nothing is locked, so the click goes to
        // the server, which has the last word.
        ent.current = { loading: true, error: null, lockReason: () => 'ceiling' };
        api.update.mockRejectedValue(refusal('feature_locked', 'datatable_retention'));
        retention();
        expect(screen.queryByTestId('retention-locked')).toBeNull();
        await userEvent.click(segment(/^30 days/));
        expect(await screen.findByText(/available on a higher plan/)).toBeInTheDocument();
        expect(screen.queryByText('feature_locked')).toBeNull();
    });

    it('locks nothing with the licence', () => {
        retention();
        for (const name of [/^7 days/, /^30 days/, /^90 days/, /Other/, /Never/]) expect(segment(name).disabled).toBe(false);
        expect(screen.queryByTestId('retention-locked')).toBeNull();
    });
});

describe('sharing refused by the licence', () => {
    async function publishToOrganisation() {
        render(<DatatableSharing table={TABLE} canEdit onChanged={() => {}} />);
        await userEvent.click(screen.getByRole('radio', { name: /Entire organisation/ }));
        await userEvent.click(await screen.findByRole('button', { name: /Share it/ }));
    }

    it('shows the paid-plan notice for the real 403 feature_locked', async () => {
        api.setSharing.mockRejectedValue(refusal('feature_locked', 'automation_sharing'));
        await publishToOrganisation();
        const notice = await screen.findByTestId('sharing-paywalled');
        expect(notice.textContent).toMatch(/part of a paid plan/);
        expect(screen.queryByText('feature_locked')).toBeNull();
    });

    it('says "ask an admin" for feature_disabled', async () => {
        api.setSharing.mockRejectedValue(refusal('feature_disabled', 'automation_sharing'));
        await publishToOrganisation();
        expect((await screen.findByTestId('sharing-paywalled')).textContent).toMatch(/not switched on for your organisation/);
    });

    it('a refused grant shows the same notice', async () => {
        api.addGrant.mockRejectedValue(refusal('feature_locked', 'automation_sharing'));
        render(<DatatableSharing table={TABLE} canEdit onChanged={() => {}} />);
        await userEvent.click(screen.getByRole('button', { name: /Add a person or team/ }));
        await userEvent.selectOptions(screen.getByRole('combobox', { name: /Who to share with/ }), 'u2');
        await userEvent.click(screen.getByRole('button', { name: /^Share$/ }));
        expect((await screen.findByTestId('sharing-paywalled')).textContent).toMatch(/part of a paid plan/);
    });
});
