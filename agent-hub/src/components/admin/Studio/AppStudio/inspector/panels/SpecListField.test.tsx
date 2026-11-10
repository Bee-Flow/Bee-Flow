import { createRequire } from 'node:module';
import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect } from 'vitest';
import './index'; // side effect: registers every bespoke panel
import SpecPanel from './SpecPanel';
import ChartInspector from './ChartInspector';
import { isHexColour } from './HexColourField';
import { clearedPropValue, isClearedProp, newListItem, setItemKey } from './specProps';
import { findNode } from '../../state/definitionOps';
import type { ComponentType } from 'react';
import type { PanelProps, AppDefinition, AppNode } from '../appDefinition';

const require = createRequire(import.meta.url);
const { buildCatalog } = require('../../../../../../../../server/appStudio/componentSpecs.js');
const CATALOG = JSON.parse(JSON.stringify(buildCatalog()));


function defWith(node: AppNode, actions: Record<string, unknown> = {}): AppDefinition {
    return {
        schemaVersion: 2,
        meta: { name: 'T', description: '', icon: 'LayoutGrid' },
        theme: { primary: '#0F766E', radius: 'md', density: 'comfortable', fontScale: 'md', appearance: 'auto' },
        homeScreenId: 'scr_list1',
        screens: [{ id: 'scr_list1', name: 'T', icon: null, showInNav: true, maxWidth: 'medium', sections: [{ id: 'sec_list1', style: {}, children: [node] }] }],
        actions,
    } as unknown as AppDefinition;
}

/** A panel that re-renders with what it committed, as the editor does. */
function mount(Panel: ComponentType<PanelProps>, node: AppNode, actions: Record<string, unknown> = {}) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(['studio-apps', 'catalog'], CATALOG);
    let last = defWith(node, actions);
    function Harness() {
        const [def, setDef] = useState(last);
        const current = findNode(def, node.id)!.node as AppNode;
        return <Panel node={current} definition={def} onCommit={(d) => { last = d; setDef(d); }} />;
    }
    const utils = render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>);
    const props = () => findNode(last, node.id)!.node.props as Record<string, unknown>;
    return { ...utils, props, user: userEvent.setup() };
}

describe('SpecListField: item fields that used to be plain text', () => {
    it('a stepper step gets an icon picker and a binding chooser, and a new step writes neither', async () => {
        const node = { id: 'cmp_step1', type: 'stepper', visible: true, props: { value: { kind: 'static', value: null }, steps: [], orientation: 'horizontal', tone: 'primary', showLabels: true }, style: {} };
        const { container, user, props } = mount(SpecPanel as ComponentType<PanelProps>, node as unknown as AppNode);
        await user.click(screen.getByRole('button', { name: /Add step/ }));
        expect(props().steps).toEqual([{ value: '', label: '' }]);
        const list = container.querySelector('[data-spec-prop="steps"]') as HTMLElement;
        expect(within(list).getByRole('button', { name: /Icon — browse icons/ })).toBeTruthy();
        expect(within(list).getByText('Type the values myself')).toBeTruthy();
    });

    it('a column value→tone map (a list inside a list item) is editable', async () => {
        const node = { id: 'cmp_tbl1', type: 'table', visible: true, props: { source: { kind: 'static', value: [] }, columns: [{ key: 'status', label: 'Status', format: 'badge' }], emptyText: 'x', rowLimit: 25, look: 'default' }, style: {} };
        const { container, user, props } = mount(SpecPanel as ComponentType<PanelProps>, node as unknown as AppNode);
        const list = container.querySelector('[data-spec-prop="columns"]') as HTMLElement;
        await user.click(within(list).getByText('#1'));
        await user.click(within(list).getByRole('button', { name: /Add tone map/ }));
        expect((props().columns as Array<Record<string, unknown>>)[0].toneMap).toEqual([{ value: '', label: '', tone: 'neutral' }]);
    });

    it('an actionId item key picks from the app’s actions', async () => {
        const node = { id: 'cmp_tbl2', type: 'table', visible: true, props: { source: { kind: 'static', value: [] }, columns: [{ key: 'title' }], emptyText: 'x', rowLimit: 25, look: 'default' }, style: {} };
        const actions = { act_open01: { kind: 'navigate', screenId: 'scr_list1' } };
        const { container, user, props } = mount(SpecPanel as ComponentType<PanelProps>, node as unknown as AppNode, actions);
        const list = container.querySelector('[data-spec-prop="columns"]') as HTMLElement;
        await user.click(within(list).getByText('#1'));
        await user.selectOptions(within(list).getByLabelText('Action id'), 'act_open01');
        expect((props().columns as Array<Record<string, unknown>>)[0].actionId).toBe('act_open01');
        await user.selectOptions(within(list).getByLabelText('Action id'), '');
        expect((props().columns as Array<Record<string, unknown>>)[0]).not.toHaveProperty('actionId');
    });
});

describe('chart series: a free hex colour', () => {
    const series = () => ({ id: 'cmp_chr1', type: 'chart', visible: true, props: { chartType: 'bar', source: { kind: 'static', value: [] }, xKey: 'label', series: [{ key: 'amount', label: 'Amount' }] }, style: {} });

    it('commits a full #rrggbb typed in, never a half-typed one', async () => {
        const { user, props } = mount(ChartInspector as ComponentType<PanelProps>, series() as unknown as AppNode);
        const box = screen.getByLabelText('Hex colour for Amount');
        await user.type(box, '#12ab3');
        expect((props().series as Array<Record<string, unknown>>)[0]).not.toHaveProperty('color');
        await user.type(box, '4');
        expect((props().series as Array<Record<string, unknown>>)[0].color).toBe('#12ab34');
    });

    it('the native picker shows the palette colour the series draws in until one is set', () => {
        mount(ChartInspector as ComponentType<PanelProps>, series() as unknown as AppNode);
        expect(screen.getByLabelText('Pick a colour for Amount')).toHaveValue('#3b82f6');
    });

    it('isHexColour accepts exactly six hex digits after a #', () => {
        expect(isHexColour('#0F766e')).toBe(true);
        for (const bad of ['#0F766', '0F766E0', '#0F766G', '#0F766E1', '', null, 12]) expect(isHexColour(bad)).toBe(false);
    });
});

describe('specProps: what clearing writes', () => {
    it('a base prop clears to its spec default, a late prop to null', () => {
        expect(clearedPropValue({ type: 'enum', values: ['a', 'b'], default: 'a' })).toBe('a');
        expect(clearedPropValue({ type: 'binding', default: { kind: 'static', value: null } })).toEqual({ kind: 'static', value: null });
        expect(clearedPropValue({ type: 'string', default: 'x', since: 3 })).toBeNull();
        expect(isClearedProp({ type: 'string', since: 3 }, undefined)).toBe(true);
        expect(isClearedProp({ type: 'string', since: 3 }, 'y')).toBe(false);
        expect(isClearedProp({ type: 'list', default: [] }, [])).toBe(true);
    });

    it('an emptied optional item key is removed, a required one stays an empty string', () => {
        expect(setItemKey({ key: 'a', align: 'left' }, 'align', { type: 'enum', values: ['auto', 'left'] }, null)).toEqual({ key: 'a' });
        expect(setItemKey({ key: 'a', hidden: true }, 'hidden', { type: 'boolean' }, false)).toEqual({ key: 'a' });
        expect(setItemKey({ key: 'a' }, 'key', { type: 'string', required: true }, '')).toEqual({ key: '' });
        expect(setItemKey({ key: 'a', toneMap: [{ value: 'x' }] }, 'toneMap', { type: 'list' }, [])).toEqual({ key: 'a' });
    });

    it('a new row leaves late keys, nested lists, icons and optional bindings out', () => {
        expect(newListItem({
            key: { type: 'string', required: true },
            format: { type: 'enum', values: ['text', 'number'], default: 'text' },
            toneMap: { type: 'list', itemShape: {} },
            icon: { type: 'icon' },
            hint: { type: 'binding' },
            later: { type: 'string', since: 3 },
            value: { type: 'binding', required: true },
        })).toEqual({ key: '', format: 'text', value: { kind: 'static', value: null } });
    });
});
