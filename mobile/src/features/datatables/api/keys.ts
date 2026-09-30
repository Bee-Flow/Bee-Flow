/** React Query keys for datatables. Everything about one table sits under `table(id)`. */

import type { RowQuery } from '../model/types';

export const datatableKeys = {
    all: ['datatables'] as const,
    list: () => ['datatables', 'list'] as const,
    table: (id: string) => ['datatables', 'table', id] as const,
    detail: (id: string) => ['datatables', 'table', id, 'detail'] as const,
    schema: (id: string) => ['datatables', 'table', id, 'schema'] as const,
    rowsRoot: (id: string) => ['datatables', 'table', id, 'rows'] as const,
    rows: (id: string, query: RowQuery) => ['datatables', 'table', id, 'rows', query] as const,
    /** Under the rows, so a row write recounts what is about to expire. */
    expiring: (id: string, days: number, field: string) => ['datatables', 'table', id, 'rows', 'expiring', days, field] as const,
    grants: (id: string) => ['datatables', 'table', id, 'grants'] as const,
    usage: (id: string) => ['datatables', 'table', id, 'usage'] as const,
    directory: () => ['datatables', 'directory'] as const,
};
