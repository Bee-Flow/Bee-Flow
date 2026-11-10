import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRequire } from 'node:module';
import type { ComponentType } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { findNode } from '../../state/definitionOps';
import DataGridInspector from './DataGridInspector';
import ListInspector from './ListInspector';
import TableInspector from './TableInspector';
import { stub } from '@/test/mocks';

/**
 * The props a type gained after the base (since 3) get a control in its
 * bespoke panel, rendered from the server catalog: `pagination` on table, list
 * and data_grid. "(default)" clears it.
 */

const require = createRequire(import.meta.url);
const { buildCatalog } = require('../../../../../../../../server/appStudio/componentSpecs.js');
const CATALOG = JSON.parse(JSON.stringify(buildCatalog()));

function defWith(node: Record<string, unknown>) {
    return {
        schemaVersion: 2,
        meta: { name: 'T', description: '', icon: 'LayoutGrid' },
        theme: {},
        homeScreenId: 'scr_t',
        screens: [{ id: 'scr_t', name: 'T', sections: [{ id: 'sec_t', style: {}, children: [node] }] }],
        actions: {},
    };
}

function renderPanel(Panel: unknown, node: Record<string, unknown> & { id: string }) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(['studio-apps', 'catalog'], CATALOG);
    const onCommit = vi.fn();
    const Comp = stub<ComponentType<Record<string, unknown>>>(Panel);
    const { container } = render(
        <QueryClientProvider client={client}>
            <Comp node={node} definition={defWith(node)} onCommit={onCommit} disabled={false} />
        </QueryClientProvider>,
    );
    const committed = () => findNode(onCommit.mock.calls.at(-1)?.[0], node.id)?.node?.props;
    return { onCommit, committed, container };
}

const SOURCE = { kind: 'records', tableId: 'tbl_a' };

describe('later props in the bespoke panels', () => {
    it('table: pagination from the spec, written when picked and cleared by (default)', async () => {
        const { committed } = renderPanel(TableInspector, { id: 'cmp_t', type: 'table', props: { source: SOURCE, columns: [] } });
        const select = screen.getByRole('combobox', { name: 'Pagination' }) as HTMLSelectElement;
        expect([...select.options].map((o) => o.value)).toEqual(['', 'loadMore', 'prevNext']);
        expect(select.value).toBe('');
        await userEvent.selectOptions(select, 'prevNext');
        expect(committed()?.pagination).toBe('prevNext');
        await userEvent.selectOptions(select, '');
        expect(committed()?.pagination ?? null).toBeNull();
    });

    it('list and data_grid offer the modes their spec has', () => {
        const list = renderPanel(ListInspector, { id: 'cmp_l', type: 'list', props: { source: SOURCE, pagination: 'loadMore' } });
        expect((within(list.container).getByRole('combobox', { name: 'Pagination' }) as HTMLSelectElement).value).toBe('loadMore');
        const gridPanel = renderPanel(DataGridInspector, { id: 'cmp_g', type: 'data_grid', props: { source: SOURCE, columns: [] } });
        const grid = within(gridPanel.container).getByRole('combobox', { name: 'Pagination' }) as HTMLSelectElement;
        expect([...grid.options].map((o) => o.value)).toEqual(['', 'loadMore']);
    });
});
