/**
 * The Retention tab on the table screen, against canned answers — the
 * phone's half of the web's DatatableDetail.retention.test.jsx.
 *
 * The rules it must not break, each one the server also enforces:
 *   1. the WINDOW and the COLUMN travel together; turning it off sends the
 *      null alone (`retention_field_required` otherwise);
 *   2. a managed table's column is not the author's;
 *   3. "about to expire" is COUNTED from one page, never read off `total`;
 *   4. a mirror has no window at all (`mirror_no_retention`);
 *   5. only someone who may change the table changes it.
 */

import type { QueryClient } from '@tanstack/react-query';
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import React from 'react';

import { api, ApiError } from '@/core/api/client';
import { formatWhen } from '@/core/i18n';
import { renderScreen } from '@/shared/testing/renderWithProviders';

import { DatatableScreen } from '../screens/DatatableScreen';

jest.setTimeout(30_000);

jest.mock('expo-router', () => jest.requireActual('@/shared/testing/screenMocks').expoRouter());
jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());
jest.mock('@/core/access', () => ({ useHasPermission: () => true }));
jest.mock('@/core/auth/AuthProvider', () => ({ useCurrentUser: () => ({ id: 'me' }) }));

const TABLE = {
    id: 'tbl_1', name: 'Customers', key: 'customers', description: 'People we e-mailed.', rowCount: 412, grade: 'owner',
    scopeKind: 'org', isPublished: false, sharedGroups: [], writeMode: 'grants', managedKind: null,
    // The server's column default: present, but nobody chose it.
    retentionDays: null, retentionField: 'created_at', lastRetentionAt: null,
};
const FIELDS = [
    { id: 'fld_1', key: 'email', name: 'E-mail', type: 'text' },
    { id: 'fld_2', key: 'signed_at', name: 'Signed on', type: 'datetime' },
    { id: 'fld_3', key: 'seen_at', name: 'Last seen', type: 'date' },
];
const NO_ROWS = { rows: [], hasMore: false, nextCursor: null, total: 412 };

type Answers = { table?: object; fields?: object[]; rows?: () => Promise<unknown> };

/** The table as the server holds it: a PATCH changes what the next GET answers. */
let stored: object = TABLE;

function answer({ table = TABLE, fields = FIELDS, rows = () => Promise.resolve(NO_ROWS) }: Answers) {
    stored = table;
    (api.get as jest.Mock).mockImplementation((path: string) => {
        if (path === '/api/datatables/tbl_1') return Promise.resolve({ datatable: stored });
        if (path.endsWith('/schema')) return Promise.resolve({ fields, modelVersion: 3 });
        if (path.endsWith('/rows')) return rows();
        if (path.endsWith('/usage')) return Promise.resolve({ usage: [] });
        return Promise.reject(new Error('403'));
    });
}

/** PATCH stores the change and answers the table as it now is. */
function saves() {
    (api.patch as jest.Mock).mockImplementation((_path: string, body: object) => {
        stored = { ...stored, ...body };
        return Promise.resolve({ datatable: stored });
    });
}

let client: QueryClient | null = null;

async function mount() {
    client = (await renderScreen(<DatatableScreen tableId="tbl_1" initialTab="retention" />)).queryClient;
}

/** The tab drawn and the count, if a window asks for one, answered. */
async function open(answers: Answers = {}) {
    answer(answers);
    await mount();
    await screen.findByText('Counted from');
    await waitFor(() => expect(screen.queryByText('Loading…')).toBeNull());
}

/** After a save the table is read again; a window then recounts. Waits for the count that follows. */
async function recounted() {
    expect(await screen.findByTestId('expiring-count')).toBeTruthy();
}

const press = async (testID: string) => fireEvent.press(screen.getByTestId(testID));
const disabled = (testID: string) => screen.getByTestId(testID).props.accessibilityState?.disabled;
const rowCalls = () => (api.get as jest.Mock).mock.calls.filter(([path]) => String(path).endsWith('/rows'));

beforeEach(() => {
    for (const fn of Object.values(api)) (fn as jest.Mock).mockReset?.();
    saves();
});

/**
 * Nothing still on its way: a refetch can end after the last assertion, and
 * React Query tells its observers on the next tick — let that tick land
 * inside act rather than between the test and its cleanup.
 */
async function settle() {
    const settled = client;
    if (!settled) return;
    await waitFor(() => expect(settled.isFetching() + settled.isMutating()).toBe(0));
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

afterEach(async () => {
    await settle();
    client = null;
});

describe('the window and the date column travel together', () => {
    it('sends BOTH halves when a preset is picked — the first date column, not the server’s default', async () => {
        await open();
        await press('retention-window-30');
        await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/api/datatables/tbl_1', { retentionDays: 30, retentionField: 'signed_at' }));
        expect(await screen.findByText('Saved. Rows are deleted 30 days after their Signed on.')).toBeTruthy();
        // The rule under the control is the server's answer, not the draft — and the count follows it.
        expect(await screen.findByText('Rows are deleted 30 days after their Signed on.')).toBeTruthy();
        await recounted();
    });

    it('re-saves with the new column when the column alone is changed', async () => {
        await open({ table: { ...TABLE, retentionDays: 30, retentionField: 'signed_at' } });
        await press('retention-field-seen_at');
        await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/api/datatables/tbl_1', { retentionDays: 30, retentionField: 'seen_at' }));
        expect(await screen.findByText('Counted from Last seen.')).toBeTruthy();
        await recounted();
    });

    it('turning it off sends only the null window — there is no column to name', async () => {
        await open({ table: { ...TABLE, retentionDays: 30, retentionField: 'signed_at' } });
        await press('retention-window-off');
        await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/api/datatables/tbl_1', { retentionDays: null }));
        expect(await screen.findByText('Rows are kept until something deletes them.')).toBeTruthy();
        expect(await screen.findByText('rows — nothing expires on its own')).toBeTruthy();
    });

    it('a typed number is only sent on Apply, and only a whole number from 1 to 3650', async () => {
        await open();
        await press('retention-window-custom');
        expect(api.patch).not.toHaveBeenCalled();
        expect(disabled('retention-apply')).toBe(true);
        await fireEvent.changeText(screen.getByTestId('retention-days'), '5000');
        expect(disabled('retention-apply')).toBe(true);
        await fireEvent.changeText(screen.getByTestId('retention-days'), '45');
        expect(disabled('retention-apply')).toBe(false);
        await press('retention-apply');
        await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/api/datatables/tbl_1', { retentionDays: 45, retentionField: 'signed_at' }));
        await recounted();
    });

    it('explains the server’s refusal in words instead of showing the code', async () => {
        (api.patch as jest.Mock).mockRejectedValue(new ApiError('nope', { status: 400, body: { error: 'nope', code: 'retention_field_required' } }));
        await open();
        await press('retention-window-7');
        expect(await screen.findByText('Pick the date column the age is measured from.')).toBeTruthy();
    });

    it('with no date column says so, and never sends a window without one', async () => {
        await open({ fields: [FIELDS[0] as object] });
        expect(screen.getByText(/no date column yet/)).toBeTruthy();
        await press('retention-window-7');
        expect(await screen.findByText('Pick the date column the age is measured from.')).toBeTruthy();
        expect(api.patch).not.toHaveBeenCalled();
    });

    it('keeps showing the column a live window counts from, even a system date', async () => {
        await open({ table: { ...TABLE, retentionDays: 90, retentionField: 'created_at' } });
        expect(screen.getByTestId('retention-field-created_at').props.accessibilityState).toMatchObject({ selected: true });
        expect(screen.getByText('Rows are deleted 90 days after their created_at.')).toBeTruthy();
    });
});

describe('a managed table', () => {
    it('does not let the author move the cache’s column, and says what its rows hold', async () => {
        await open({
            table: { ...TABLE, managedKind: 'http_cache', retentionDays: 30, retentionField: 'fetched_at' },
            fields: [{ id: 'fld_hcachetime', key: 'fetched_at', name: 'Fetched at', type: 'datetime' }],
        });
        expect(disabled('retention-field-fetched_at')).toBe(true);
        expect(screen.getByText(/Fixed: the platform fills this table in/)).toBeTruthy();
        expect(screen.getByText(/in plain text/)).toBeTruthy();
        expect(screen.getByText(/no second, hidden clock/)).toBeTruthy();
    });

    it('ages a form’s answers by when they were given', async () => {
        await open({
            table: { ...TABLE, managedKind: 'form_answers' },
            fields: [{ id: 'fld_faxcompl', key: 'completed_at', name: 'Completed', type: 'datetime' }],
        });
        expect(disabled('retention-field-created_at')).toBe(true);
        // The cache's warning is about a third-party service; it is not said of answers.
        expect(screen.queryByText(/third-party service/)).toBeNull();
        await press('retention-window-90');
        await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/api/datatables/tbl_1', { retentionDays: 90, retentionField: 'created_at' }));
        await recounted();
    });
});

describe('what is about to expire', () => {
    const LIVE = { ...TABLE, retentionDays: 30, retentionField: 'signed_at' };

    it('counts the matching rows rather than reading the table-wide total', async () => {
        await open({ table: LIVE, rows: () => Promise.resolve({ rows: [{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }], hasMore: false, nextCursor: null, total: 412 }) });
        expect((await screen.findByTestId('expiring-count')).props.children).toBe('3');
        expect(screen.getByText('rows expire in the next 7 days')).toBeTruthy();
        const query = rowCalls()[0]?.[1]?.query;
        expect(query.limit).toBe(500);
        expect(JSON.parse(query.filters)).toEqual([{ field: 'signed_at', op: 'lte', value: expect.any(String) }]);
    });

    it('says "n+" rather than a number it cannot stand behind', async () => {
        await open({ table: LIVE, rows: () => Promise.resolve({ rows: Array.from({ length: 500 }, (_, i) => ({ id: `r${i}` })), hasMore: true, nextCursor: 'c', total: 100000 }) });
        expect((await screen.findByTestId('expiring-count')).props.children).toBe('500+');
    });

    it('a failed count reads as "could not work it out", never as "nothing expires"', async () => {
        await open({ table: LIVE, rows: () => Promise.reject(new Error('boom')) });
        expect(await screen.findByText('Could not work out what is about to expire.')).toBeTruthy();
    });

    it('asks for nothing at all when no window is set', async () => {
        await open();
        expect(screen.getByText('rows — nothing expires on its own')).toBeTruthy();
        expect(rowCalls()).toHaveLength(0);
    });
});

describe('the last sweep', () => {
    // The server's TIMESTAMPTZ arrives as an ISO string in UTC. Cutting it to
    // "2026-09-26 03:00" printed the UTC wall clock with no zone: two hours
    // off for someone in Amsterdam, and in no language's own date format.
    it('is said in the phone’s clock and the app’s date format, not as the raw UTC timestamp', async () => {
        const at = '2026-09-26T03:00:00.000Z';
        await open({ table: { ...TABLE, retentionDays: 30, retentionField: 'signed_at', lastRetentionAt: at } });
        await recounted();
        const line = screen.getByText(/^Last swept /);
        const text = String(line.props.children);
        expect(text).toBe(`Last swept ${formatWhen(at)}.`);
        expect(text).not.toContain('2026-09-26 03:00');
        expect(text).toContain(`${String(new Date(at).getHours()).padStart(2, '0')}:00`);
    });
});

describe('who sees what', () => {
    it('a viewer reads the rule and cannot change it', async () => {
        await open({ table: { ...TABLE, grade: 'viewer', retentionDays: 30, retentionField: 'signed_at' } });
        expect(disabled('retention-window-7')).toBe(true);
        expect(disabled('retention-field-seen_at')).toBe(true);
        expect(screen.getByText('Rows are deleted 30 days after their Signed on.')).toBeTruthy();
    });

    it('a mirror has no Retention tab, and reached by address says why', async () => {
        answer({ table: { ...TABLE, managedKind: 'nextcloud_table', source: { kind: 'nextcloud_table', writable: true } } });
        await mount();
        expect(await screen.findByText(/they stay as long as they are in Nextcloud/)).toBeTruthy();
        await settle();
        expect(screen.queryByText('Data & retention')).toBeNull();
        expect(screen.queryByText('Counted from')).toBeNull();
    });

    it('an ordinary table lists the tab between Rows and Sharing', async () => {
        await open();
        expect(screen.getByText('Data & retention')).toBeTruthy();
    });
});
