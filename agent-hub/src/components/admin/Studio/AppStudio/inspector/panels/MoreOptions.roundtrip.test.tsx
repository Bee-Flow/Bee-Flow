import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect } from 'vitest';
import './index'; // side effect: registers every bespoke panel
import MoreOptions from './MoreOptions';
import { findNode } from '../../state/definitionOps';
import { getPanelCoverage } from '../registry';
import type { PanelCoverage } from '../registry';
import type { AppDefinition, AppNode } from '../appDefinition';

/**
 * Set a value under "More options" on a real node from the compat corpus, clear
 * it again, and the definition canonicalizes to exactly the bytes it had: the
 * controls never leave a written-out default or an empty key behind.
 */

const require = createRequire(import.meta.url);
const SERVER = '../../../../../../../../server/appStudio';
const { buildCatalog } = require(`${SERVER}/componentSpecs.js`);
const { canonicalizeAppDefinition } = require(`${SERVER}/canonicalize.js`);
const CATALOG = JSON.parse(JSON.stringify(buildCatalog()));
const CORPUS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), `${SERVER}/compat/corpus`);


function canonical(def: unknown): AppDefinition {
    return canonicalizeAppDefinition(JSON.parse(JSON.stringify(def))).def;
}

/** A corpus app as the editor holds it after a save: the canonical form. */
function corpusApp(name: string): AppDefinition {
    const file = JSON.parse(fs.readFileSync(path.join(CORPUS, `${name}.json`), 'utf8'));
    return canonical(file.definition);
}

function Harness({ initial, nodeId, onDef }: { initial: AppDefinition; nodeId: string; onDef: (d: AppDefinition) => void }) {
    const [def, setDef] = useState(initial);
    const node = findNode(def, nodeId)!.node as AppNode;
    return (
        <MoreOptions
            node={node}
            definition={def}
            onCommit={(d) => { setDef(d); onDef(d); }}
            coverage={getPanelCoverage(node.type) as PanelCoverage}
        />
    );
}

async function mount(initial: AppDefinition, nodeId: string) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(['studio-apps', 'catalog'], CATALOG);
    let last = initial;
    const user = userEvent.setup();
    const utils = render(
        <QueryClientProvider client={client}>
            <Harness initial={initial} nodeId={nodeId} onDef={(d) => { last = d; }} />
        </QueryClientProvider>,
    );
    const toggle = screen.getByRole('button', { name: /More options/ });
    if (toggle.getAttribute('aria-expanded') === 'false') await user.click(toggle);
    const props = () => findNode(last, nodeId)!.node.props as Record<string, unknown>;
    return { ...utils, user, props, latest: () => last };
}

function field(container: HTMLElement, attr: string, value: string) {
    return container.querySelector(`[${attr}="${value}"]`) as HTMLElement;
}

describe('More options round-trips on corpus nodes', () => {
    it('table column alignment (an item key the panel leaves out): set, then back to default', async () => {
        const app = corpusApp('sample-kitchen-sink');
        const { container, user, props, latest } = await mount(app, 'cmp_table1');
        const box = field(container, 'data-more-item', 'columns[].align');
        await user.selectOptions(within(box).getByLabelText('Align'), 'right');
        expect((props().columns as Array<Record<string, unknown>>)[0].align).toBe('right');
        await user.selectOptions(within(field(container, 'data-more-item', 'columns[].align')).getByLabelText('Align'), '');
        expect((props().columns as Array<Record<string, unknown>>)[0]).not.toHaveProperty('align');
        expect(canonical(latest())).toEqual(app);
    });

    it('data_grid column tone map (a list inside an item): add a row, remove it', async () => {
        const app = corpusApp('public-intake');
        const { container, user, props, latest } = await mount(app, 'cmp_pubgrd');
        const box = field(container, 'data-more-item', 'columns[].toneMap');
        await user.click(within(box).getByRole('button', { name: /Add tone map/ }));
        expect((props().columns as Array<Record<string, unknown>>)[0].toneMap).toEqual([{ value: '', label: '', tone: 'neutral' }]);
        await user.click(within(field(container, 'data-more-item', 'columns[].toneMap')).getByRole('button', { name: 'Remove' }));
        expect((props().columns as Array<Record<string, unknown>>)[0]).not.toHaveProperty('toneMap');
        expect(canonical(latest())).toEqual(app);
    });

    it('data_grid zebra (a base boolean the panel never had): on, off', async () => {
        const app = corpusApp('public-intake');
        const { container, user, props, latest } = await mount(app, 'cmp_pubgrd');
        await user.click(within(field(container, 'data-spec-prop', 'zebra')).getByText('Zebra'));
        expect(props().zebra).toBe(true);
        await user.click(within(field(container, 'data-spec-prop', 'zebra')).getByText('Zebra'));
        expect(props().zebra).toBe(false);
        expect(canonical(latest())).toEqual(app);
    });

    it('kanban WIP limit (an int item key): typed, then emptied', async () => {
        const app = corpusApp('sample-v21-batch');
        const { container, user, props, latest } = await mount(app, 'cmp_v21kb');
        const input = within(container.querySelectorAll('[data-more-item="columns[].wipLimit"]')[0] as HTMLElement).getByLabelText('Wip limit');
        await user.type(input, '3');
        expect((props().columns as Array<Record<string, unknown>>)[0].wipLimit).toBe(3);
        await user.clear(input);
        expect((props().columns as Array<Record<string, unknown>>)[0]).not.toHaveProperty('wipLimit');
        expect(canonical(latest())).toEqual(app);
    });

    it('chart orientation (a base enum): horizontal, then Reset', async () => {
        const app = corpusApp('template-ai-act-register');
        const { container, user, props, latest } = await mount(app, 'cmp_inchart');
        await user.selectOptions(within(field(container, 'data-spec-prop', 'orientation')).getByLabelText('Orientation'), 'horizontal');
        expect(props().orientation).toBe('horizontal');
        await user.click(screen.getByRole('button', { name: 'Reset Orientation' }));
        expect(props().orientation).toBe('vertical');
        expect(canonical(latest())).toEqual(app);
    });

    it('callout text-from binding set by the AI: Reset writes the canonical default back', async () => {
        const app = corpusApp('public-intake');
        const touched = JSON.parse(JSON.stringify(app));
        (findNode(touched, 'cmp_pubthx')!.node.props as Record<string, unknown>).textFrom = { kind: 'formula', expr: 'vars.note' };
        const { user, props, latest } = await mount(touched, 'cmp_pubthx');
        // A value the block holds opens it by itself.
        await user.click(screen.getByRole('button', { name: 'Reset Text from' }));
        expect(props().textFrom).toEqual({ kind: 'static', value: null });
        expect(canonical(latest())).toEqual(app);
    });

    it('stat caption segments (a base list): add a segment, remove it', async () => {
        const app = corpusApp('template-ai-act-register');
        const { container, user, props, latest } = await mount(app, 'cmp_regs1');
        const box = field(container, 'data-spec-prop', 'captionSegments');
        await user.click(within(box).getByRole('button', { name: /Add caption segment/ }));
        expect((props().captionSegments as unknown[]).length).toBe(1);
        await user.click(within(field(container, 'data-spec-prop', 'captionSegments')).getByRole('button', { name: 'Remove' }));
        expect(props().captionSegments).toEqual([]);
        expect(canonical(latest())).toEqual(app);
    });
});
