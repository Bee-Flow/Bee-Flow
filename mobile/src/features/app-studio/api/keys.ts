/**
 * React Query keys for App Studio, all under one 'app-studio' root so a
 * sign-out or a wholesale refresh can drop them together. Per-app keys share
 * the `app(id)` prefix: invalidating it refreshes everything about one app.
 */

import type { RecordsQuery } from '../model/runtimeTypes';

const root = ['app-studio'] as const;

export const studioKeys = {
    all: root,
    catalog: [...root, 'catalog'] as const,
    templates: [...root, 'templates'] as const,
    template: (templateId: string) => [...root, 'templates', templateId] as const,
    /** Both app lists (`accessible` and `mine`). */
    lists: [...root, 'list'] as const,
    accessible: [...root, 'list', 'accessible'] as const,
    mine: [...root, 'list', 'mine'] as const,
    publishGroups: [...root, 'publish-groups'] as const,
    app: (id: string) => [...root, 'app', id] as const,
    row: (id: string) => [...root, 'app', id, 'row'] as const,
    runtime: (id: string, draft: boolean) => [...root, 'app', id, 'runtime', draft ? 'draft' : 'published'] as const,
    versions: (id: string) => [...root, 'app', id, 'versions'] as const,
    publicPages: (id: string) => [...root, 'app', id, 'public-pages'] as const,
    check: (id: string) => [...root, 'app', id, 'check'] as const,
    schema: (id: string) => [...root, 'app', id, 'schema'] as const,
    datasets: (id: string) => [...root, 'app', id, 'datasets'] as const,
    members: (id: string) => [...root, 'app', id, 'members'] as const,
    builderSession: (id: string) => [...root, 'app', id, 'builder-session'] as const,
    /** Every data read of one app (tables and records). */
    data: (id: string) => [...root, 'app', id, 'data'] as const,
    tables: (id: string) => [...root, 'app', id, 'data', 'tables'] as const,
    table: (id: string, tableId: string) => [...root, 'app', id, 'data', 'table', tableId] as const,
    records: (id: string, tableId: string, query: RecordsQuery = {}) =>
        [...root, 'app', id, 'data', 'table', tableId, 'records', query] as const,
    record: (id: string, tableId: string, recordId: string) =>
        [...root, 'app', id, 'data', 'table', tableId, 'record', recordId] as const,
    actionRun: (id: string, runId: string | null) => [...root, 'app', id, 'run', runId] as const,
};
