import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));

import useAppTables, { fieldsForTable } from './useAppTables';
import { authFetch } from '../../../../../utils/helpers';
import { asMock } from '@/test/mocks';

const resp = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

function makeWrapper() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return function Wrapper({ children }: { children?: ReactNode }) {
        return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
    };
}

describe('useAppTables', () => {
    beforeEach(() => asMock(authFetch).mockReset());

    it('fetches the table catalogue', async () => {
        asMock(authFetch).mockResolvedValue(resp(200, {
            tables: [{ id: 't1', key: 'tasks', name: 'Tasks', fields: [{ key: 'amount', name: 'Amount', type: 'number' }] }],
        }));
        const { result } = renderHook(() => useAppTables('app1'), { wrapper: makeWrapper() });

        await waitFor(() => expect(result.current.tables.length).toBe(1));
        expect(result.current.tables[0].name).toBe('Tasks');
        expect(result.current.fieldsFor('t1')).toHaveLength(1);
        expect(result.current.fieldsFor('tasks')).toHaveLength(1); // resolves by key too
        expect(result.current.isError).toBe(false);
        expect(authFetch).toHaveBeenCalledWith(expect.stringContaining('/api/studio-apps/app1/data/tables'));
    });

    it('degrades a 404 to an empty list (endpoint exists but empty)', async () => {
        asMock(authFetch).mockResolvedValue(resp(404, {}));
        const { result } = renderHook(() => useAppTables('app1'), { wrapper: makeWrapper() });

        await waitFor(() => expect(result.current.isLoading).toBe(false));
        expect(result.current.tables).toEqual([]);
        expect(result.current.isError).toBe(false);
    });

    it('does not fetch without an appId', () => {
        const { result } = renderHook(() => useAppTables(null), { wrapper: makeWrapper() });
        expect(result.current.tables).toEqual([]);
        expect(result.current.fieldsFor('anything')).toEqual([]);
        expect(authFetch).not.toHaveBeenCalled();
    });

    it('surfaces a non-404 error without crashing', async () => {
        asMock(authFetch).mockResolvedValue(resp(500, { error: 'boom' }));
        const { result } = renderHook(() => useAppTables('app1'), { wrapper: makeWrapper() });
        await waitFor(() => expect(result.current.isError).toBe(true));
        expect(result.current.tables).toEqual([]);
    });
});

describe('fieldsForTable', () => {
    const tables = [{ id: 't1', key: 'k1', name: 'T', fields: [{ key: 'a', name: 'A', type: 'text' }, { key: 'b', name: 'B', type: 'text' }] }];
    it('finds by id or key and returns [] for unknown', () => {
        expect(fieldsForTable(tables, 't1')).toHaveLength(2);
        expect(fieldsForTable(tables, 'k1')).toHaveLength(2);
        expect(fieldsForTable(tables, 'nope')).toEqual([]);
        expect(fieldsForTable(null, 't1')).toEqual([]);
    });
});
