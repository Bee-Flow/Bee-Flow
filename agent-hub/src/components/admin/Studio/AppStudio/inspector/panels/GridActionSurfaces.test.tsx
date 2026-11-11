import type { ComponentType } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import DataGridInspector from './DataGridInspector';
import { findNode } from '../../state/definitionOps';
import { stub } from '@/test/mocks';

/**
 * The three action surfaces of data_grid the human had no control for: toolbar buttons, buttons on the
 * selection, and the add-row line. Each writes the spec's own prop shape, and a new action is made in the
 * same commit that points the surface at it.
 */

const GRID = {
    id: 'cmp_dg', type: 'data_grid', visible: true,
    props: { source: { kind: 'static', value: [] }, columns: [], pageSize: 25, selectable: 'multi', searchable: false, rowActions: [], density: 'comfortable' },
    style: { span: 12 },
};

function defWith(node: unknown, actions: Record<string, unknown> = {}) {
    return {
        schemaVersion: 2,
        meta: { name: 'T', description: '', icon: 'LayoutGrid' },
        theme: { primary: '#0F766E', radius: 'md', density: 'comfortable', fontScale: 'md', appearance: 'auto' },
        homeScreenId: 'scr_t',
        screens: [{ id: 'scr_t', name: 'T', icon: null, showInNav: true, maxWidth: 'medium', sections: [{ id: 'sec_t', style: {}, children: [node] }] }],
        actions,
    };
}

function renderGrid(node: typeof GRID, actions: Record<string, unknown> = {}) {
    const Panel = stub<ComponentType<Record<string, unknown>>>(DataGridInspector);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const onCommit = vi.fn();
    const utils = render(
        <QueryClientProvider client={client}>
            <Panel node={node} definition={defWith(node, actions)} onCommit={onCommit} disabled={false} />
        </QueryClientProvider>,
    );
    const last = () => onCommit.mock.calls.at(-1)![0];
    const props = () => findNode(last(), node.id).node.props;
    return { onCommit, last, props, ...utils };
}

describe('data_grid action surfaces', () => {
    it('adds a toolbar button as the spec shape: a label and an (as yet empty) action id', async () => {
        const user = userEvent.setup();
        const { getByText, props } = renderGrid(GRID);
        await user.click(getByText(/Add toolbar button/));
        expect(props().toolbarActions).toEqual([{ label: '', actionId: '' }]);
    });

    it('adds a button on the selection under bulkActions, with the same shape', async () => {
        const user = userEvent.setup();
        const { getByText, props } = renderGrid(GRID);
        await user.click(getByText(/Add action on selected rows/));
        expect(props().bulkActions).toEqual([{ label: '', actionId: '' }]);
    });

    it('a toolbar item with a new "Show a message" action: the action exists and the item points at it', async () => {
        const user = userEvent.setup();
        const node = { ...GRID, props: { ...GRID.props, toolbarActions: [{ label: 'Export', actionId: '' }] } };
        const { getByLabelText, onCommit, props, last } = renderGrid(node);
        // The row is collapsed by default; the picker is in it.
        await user.click(document.querySelector('[aria-expanded="false"]') as Element);
        await user.selectOptions(getByLabelText('Toolbar buttons'), '__new:toast');
        expect(onCommit).toHaveBeenCalledTimes(1);
        const actions = last().actions as Record<string, { kind: string }>;
        const [newId] = Object.keys(actions);
        expect(actions[newId]).toMatchObject({ kind: 'toast', tone: 'info' });
        expect(props().toolbarActions).toEqual([{ label: 'Export', actionId: newId }]);
    });

    it('creates a sequence (a flow) from the add-row picker and writes addRowActionId', async () => {
        const user = userEvent.setup();
        const { getByLabelText, onCommit, props, last } = renderGrid(GRID);
        await user.selectOptions(getByLabelText('Action for the add-row line'), '__new:sequence');
        expect(onCommit).toHaveBeenCalledTimes(1);
        const actions = last().actions as Record<string, { kind: string; steps: unknown[] }>;
        const [newId] = Object.keys(actions);
        expect(actions[newId]).toEqual({ kind: 'sequence', steps: [] });
        expect(props().addRowActionId).toBe(newId);
    });

    it('picks an existing action for the add-row line without touching the action set', async () => {
        const user = userEvent.setup();
        const existing = { act_one: { kind: 'toast', message: 'Hi', tone: 'info' } };
        const { getByLabelText, last, props } = renderGrid(GRID, existing);
        await user.selectOptions(getByLabelText('Action for the add-row line'), 'act_one');
        expect(props().addRowActionId).toBe('act_one');
        expect(Object.keys(last().actions)).toEqual(['act_one']);
    });

    it('the add-row label is written and cleared back to absent', async () => {
        const user = userEvent.setup();
        const written = renderGrid(GRID);
        await user.type(written.getByPlaceholderText('Label, for example Add a row'), 'A');
        expect(written.props().addRowLabel).toBe('A');
        written.unmount();
        const node = { ...GRID, props: { ...GRID.props, addRowLabel: 'A' } };
        const cleared = renderGrid(node);
        await user.clear(cleared.getByPlaceholderText('Label, for example Add a row'));
        expect('addRowLabel' in cleared.props() && cleared.props().addRowLabel !== undefined).toBe(false);
    });

    it('says why bulk buttons stay hidden while rows cannot be selected', () => {
        const node = { ...GRID, props: { ...GRID.props, selectable: 'none', bulkActions: [{ label: 'Delete', actionId: 'act_x' }] } };
        const { getByText } = renderGrid(node, { act_x: { kind: 'toast', message: '', tone: 'info' } });
        expect(getByText(/only show once rows can be selected/)).toBeTruthy();
    });

    it('a grid that uses none of this commits nothing and shows no new props', () => {
        const { onCommit } = renderGrid(GRID);
        expect(onCommit).not.toHaveBeenCalled();
    });
});
