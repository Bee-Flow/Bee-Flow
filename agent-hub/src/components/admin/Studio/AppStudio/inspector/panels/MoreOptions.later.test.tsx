import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import './index'; // side effect: registers every bespoke panel
import MoreOptions from './MoreOptions';
import { findNode } from '../../state/definitionOps';
import { getPanelCoverage } from '../registry';
import type { PanelCoverage } from '../registry';
import type { AppDefinition, AppNode } from '../appDefinition';

/**
 * The props a type gained after the base (since 3) get a control under its
 * bespoke panel, rendered from the server catalog by "More options":
 * `pagination` on table, list and data_grid. "(default)" clears it.
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
    } as unknown as AppDefinition;
}

async function renderBlock(node: Record<string, unknown> & { id: string; type: string }) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(['studio-apps', 'catalog'], CATALOG);
    const onCommit = vi.fn();
    const { container } = render(
        <QueryClientProvider client={client}>
            <MoreOptions
                node={node as unknown as AppNode}
                definition={defWith(node)}
                onCommit={onCommit}
                coverage={getPanelCoverage(node.type) as PanelCoverage}
            />
        </QueryClientProvider>,
    );
    const block = container.querySelector(`[data-more-options="${node.type}"]`) as HTMLElement;
    const toggle = within(block).getByRole('button', { name: /More options/ });
    if (toggle.getAttribute('aria-expanded') === 'false') await userEvent.click(toggle);
    const committed = () => findNode(onCommit.mock.calls.at(-1)?.[0], node.id)?.node?.props;
    return { onCommit, committed, container: block };
}

const SOURCE = { kind: 'records', tableId: 'tbl_a' };

describe('later props under the bespoke panels', () => {
    it('table: pagination from the spec, written when picked and cleared by (default)', async () => {
        const { committed } = await renderBlock({ id: 'cmp_t', type: 'table', props: { source: SOURCE, columns: [] } });
        const select = screen.getByRole('combobox', { name: 'Pagination' }) as HTMLSelectElement;
        expect([...select.options].map((o) => o.value)).toEqual(['', 'loadMore', 'prevNext']);
        expect(select.value).toBe('');
        await userEvent.selectOptions(select, 'prevNext');
        expect(committed()?.pagination).toBe('prevNext');
        await userEvent.selectOptions(select, '');
        expect(committed()?.pagination ?? null).toBeNull();
    });

    it('list and data_grid offer the modes their spec has', async () => {
        const list = await renderBlock({ id: 'cmp_l', type: 'list', props: { source: SOURCE, pagination: 'loadMore' } });
        expect((within(list.container).getByRole('combobox', { name: 'Pagination' }) as HTMLSelectElement).value).toBe('loadMore');
        const gridBlock = await renderBlock({ id: 'cmp_g', type: 'data_grid', props: { source: SOURCE, columns: [] } });
        const grid = within(gridBlock.container).getByRole('combobox', { name: 'Pagination' }) as HTMLSelectElement;
        expect([...grid.options].map((o) => o.value)).toEqual(['', 'loadMore']);
    });
});
