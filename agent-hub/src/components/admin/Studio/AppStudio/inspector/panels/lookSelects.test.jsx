import { createRequire } from 'node:module';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import ButtonInspector from './ButtonInspector';
import CardInspector from './CardInspector';
import ContainerInspector from './ContainerInspector';
import DataGridInspector from './DataGridInspector';
import HeadingInspector from './HeadingInspector';
import KanbanInspector from './KanbanInspector';
import ListInspector from './ListInspector';
import StatInspector from './StatInspector';
import TableInspector from './TableInspector';
import { TabsInspector } from './TabsInspector';
import { findNode } from '../../state/definitionOps';

/**
 * The look pass — every bespoke panel's look/accent/cardLook/variant select
 * pinned against the SERVER enum (componentSpecs.js, authoritative). The
 * panels mirror the value lists by hand, so this is the lockstep: values in
 * spec order, and — identity discipline — a node WITHOUT the prop must show
 * the spec default (the enum's first value), because that is what the
 * runtime renders for stored definitions from before the look pass.
 */

const require = createRequire(import.meta.url);
const { COMPONENT_SPECS } = require('../../../../../../../../server/appStudio/componentSpecs.js');

vi.mock('../../studioAppsApi', () => ({
    studioAppsApi: { getCatalog: vi.fn(async () => { throw new Error('offline'); }) },
}));

function defWith(node) {
    return {
        schemaVersion: 2,
        meta: { name: 'T', description: '', icon: 'LayoutGrid' },
        theme: { primary: '#0F766E', radius: 'md', density: 'comfortable', fontScale: 'md', appearance: 'auto' },
        homeScreenId: 'scr_t',
        screens: [{ id: 'scr_t', name: 'T', icon: null, showInNav: true, maxWidth: 'medium', sections: [{ id: 'sec_t', style: {}, children: [node] }] }],
        actions: {},
    };
}

// Fixture nodes deliberately OMIT the new enum prop — a pre-look-pass stored
// definition — so the select's displayed value proves the identity fallback.
const N = {
    heading: { id: 'cmp_lk', type: 'heading', visible: true, props: { text: 'Hi', level: 2 }, style: {} },
    button: { id: 'cmp_lk', type: 'button', visible: true, props: { label: 'Go', iconLeft: null, role: 'button' }, style: {} },
    stat: { id: 'cmp_lk', type: 'stat', visible: true, props: { label: 'Open', value: { kind: 'static', value: '0' }, caption: null, icon: null }, style: {} },
    card: { id: 'cmp_lk', type: 'card', visible: true, props: { title: null, description: null }, style: {}, children: [] },
    container: { id: 'cmp_lk', type: 'container', visible: true, props: {}, style: {}, children: [] },
    table: { id: 'cmp_lk', type: 'table', visible: true, props: { source: { kind: 'static', value: [] }, columns: [], emptyText: 'x', rowLimit: 25 }, style: {} },
    list: { id: 'cmp_lk', type: 'list', visible: true, props: { source: { kind: 'static', value: [] }, titleKey: 'title', subtitleKey: null, emptyText: 'x' }, style: {} },
    data_grid: { id: 'cmp_lk', type: 'data_grid', visible: true, props: { source: { kind: 'static', value: [] }, columns: [], pageSize: 25, selectable: 'none', searchable: false, rowActions: [], density: 'comfortable', emptyText: 'x' }, style: {} },
    tabs: {
        id: 'cmp_lk', type: 'tabs', visible: true, props: {}, style: {},
        children: [{ id: 'cmp_lkt1', type: 'tab', visible: true, props: { label: 'One', icon: null }, style: {}, children: [] }],
    },
    kanban: { id: 'cmp_lk', type: 'kanban', visible: true, props: { source: { kind: 'static', value: [] }, groupByField: 'status', columns: [], titleKey: 'title', subtitleKey: null, badgeKey: null, allowDrag: true }, style: {} },
};

function renderInspector(Comp, node) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const onCommit = vi.fn();
    const utils = render(
        <QueryClientProvider client={client}>
            <Comp node={node} definition={defWith(node)} onCommit={onCommit} disabled={false} />
        </QueryClientProvider>,
    );
    return { onCommit, ...utils };
}

// [type, Panel, propKey, accessible select name, fixture]
const CASES = [
    ['heading', HeadingInspector, 'accent', 'Accent', N.heading],
    ['button', ButtonInspector, 'variant', 'Button variant', N.button],
    ['stat', StatInspector, 'look', 'Look', N.stat],
    ['card', CardInspector, 'look', 'Look', N.card],
    ['container', ContainerInspector, 'look', 'Look', N.container],
    ['table', TableInspector, 'look', 'Look', N.table],
    ['list', ListInspector, 'look', 'Look', N.list],
    ['data_grid', DataGridInspector, 'look', 'Look', N.data_grid],
    ['tabs', TabsInspector, 'look', 'Look', N.tabs],
    ['kanban', KanbanInspector, 'cardLook', 'Card look', N.kanban],
];

describe('look selects — bespoke panels in lockstep with the server enums', () => {
    it('covers every type whose look enum has a bespoke panel', () => {
        // If a look/accent/cardLook/variant enum joins a bespoke-panel type and
        // this table is not extended, the control silently never exists.
        expect(CASES.map(([type]) => type).sort()).toEqual(
            ['button', 'card', 'container', 'data_grid', 'heading', 'kanban', 'list', 'stat', 'table', 'tabs'],
        );
    });

    it.each(CASES)('%s: the %s select lists the server values, in order', (type, Comp, propKey, name, node) => {
        const spec = COMPONENT_SPECS[type].props[propKey];
        expect(spec, `${type}.${propKey} vanished from the server spec`).toBeTruthy();
        const { getByRole } = renderInspector(Comp, node);
        const select = getByRole('combobox', { name });
        expect(Array.from(select.options).map((o) => o.value)).toEqual(spec.values);
    });

    it.each(CASES)('%s: a stored node without %s shows the identity default', (type, Comp, propKey, name, node) => {
        const spec = COMPONENT_SPECS[type].props[propKey];
        const { getByRole } = renderInspector(Comp, node);
        // The panel's `?? '<default>'` fallback must equal the spec default,
        // which the server pins as the enum's FIRST value (identity).
        expect(getByRole('combobox', { name })).toHaveValue(spec.default);
        expect(spec.values[0]).toBe(spec.default);
    });

    it.each(CASES)('%s: picking a non-default %s commits it', (type, Comp, propKey, name, node) => {
        const spec = COMPONENT_SPECS[type].props[propKey];
        const picked = spec.values[spec.values.length - 1];
        const { onCommit, getByRole } = renderInspector(Comp, node);
        fireEvent.change(getByRole('combobox', { name }), { target: { value: picked } });
        expect(onCommit).toHaveBeenCalledTimes(1);
        expect(findNode(onCommit.mock.calls[0][0], node.id).node.props[propKey]).toBe(picked);
    });
});

/*
 * COLUMN FORMAT / ALIGN — the other pair of hand-mirrored lists.
 *
 * `data_grid` and `table` both keep a FORMATS array in their panel, and both
 * render through the same shared cellValue module. The look enums above have
 * been pinned since the look pass; these had not been, which is how the two
 * panels ended up offering different format lists from each other AND from the
 * server (the grid understood boolean and relation, the table did not, and
 * neither offered anything the runtime had learned since).
 *
 * A column list lives inside a RepeatableList, so the select only exists once
 * a column does — the fixtures below therefore carry one.
 */
const COLUMN_CASES = [
    ['data_grid', DataGridInspector, 'Column format', 'format'],
    ['table', TableInspector, 'Column format', 'format'],
    ['data_grid', DataGridInspector, 'Column alignment', 'align'],
];

const withColumn = (type, column = { key: 'title', label: 'Title', format: 'text' }) => ({
    ...N[type],
    props: { ...N[type].props, columns: [column] },
});

/*
 * data_grid's column list is `collapsible`, so a stored column renders as a
 * closed summary row and its controls do not exist until it is opened. Expand
 * every row before asserting — a select that is merely behind a disclosure is
 * still reachable, and the lockstep is about the OPTIONS, not the chrome.
 */
function expandColumns(utils) {
    for (const el of utils.container.querySelectorAll('[role="button"][aria-expanded="false"]')) {
        fireEvent.click(el);
    }
    return utils;
}

describe('column selects — in lockstep with the server column itemShape', () => {
    it.each(COLUMN_CASES)('%s: the %s select lists the server values, in order', (type, Comp, name, field) => {
        const shape = COMPONENT_SPECS[type].props.columns.itemShape[field];
        expect(shape, `${type}.columns[].${field} vanished from the server spec`).toBeTruthy();
        const { getByRole } = expandColumns(renderInspector(Comp, withColumn(type)));
        const select = getByRole('combobox', { name });
        expect(Array.from(select.options).map((o) => o.value)).toEqual(shape.values);
    });

    it.each(COLUMN_CASES)('%s: a column without %s shows the identity default', (type, Comp, name, field) => {
        const shape = COMPONENT_SPECS[type].props.columns.itemShape[field];
        const { getByRole } = expandColumns(renderInspector(Comp, withColumn(type, { key: 'title' })));
        expect(getByRole('combobox', { name })).toHaveValue(shape.default);
        // Identity: the default is the enum's first value, so a stored column
        // that predates the new values renders exactly as it always did.
        expect(shape.values[0]).toBe(shape.default);
    });
});
