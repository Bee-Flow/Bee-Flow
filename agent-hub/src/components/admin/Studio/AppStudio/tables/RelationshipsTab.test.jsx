import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Relationships canvas — the behaviour that touches the MODEL, not the
 * vendor's rendering.
 *
 * ReactFlow is mocked (as flow/edges.test.jsx already does): real nodes only
 * mount after measurement, which never happens in jsdom, and a canvas we cannot
 * drag in tests would let the interesting assertions rot. The mock keeps the
 * prop contract — nodes/edges in, onConnect/onEdgeClick out — and exposes the
 * two as buttons, so what is asserted is which tables and links we hand it and
 * what we do with the callbacks.
 */
vi.mock('@xyflow/react', () => ({
    ReactFlow: ({ nodes, edges, onConnect, onEdgeClick, children }) => (
        <div data-testid="flow">
            {nodes.map((n) => <div key={n.id} data-testid="node">{n.data.table.name}{n.data.fillerName ? ` (${n.data.fillerName})` : ''}</div>)}
            {edges.map((e) => (
                <button key={e.id} type="button" data-testid="edge" onClick={() => onEdgeClick({}, e)}>
                    {e.source}→{e.target}:{e.label}
                </button>
            ))}
            <button type="button" data-testid="connect" onClick={() => onConnect({ source: 'tbl_att', target: 'tbl_msg' })}>connect</button>
            <button type="button" data-testid="self-connect" onClick={() => onConnect({ source: 'tbl_msg', target: 'tbl_msg' })}>self</button>
            {children}
        </div>
    ),
    ReactFlowProvider: ({ children }) => <div>{children}</div>,
    Background: () => null,
    Controls: () => null,
    Handle: () => null,
    MarkerType: { ArrowClosed: 'arrowclosed' },
    Position: { Top: 'top', Bottom: 'bottom' },
    applyNodeChanges: (_changes, nodes) => nodes,
}));

const RelationshipsTab = (await import('./RelationshipsTab')).default;
const { addRelation } = await import('./relationOps');

const TABLES = [
    { id: 'tbl_msg', key: 'messages', name: 'Messages', fields: [{ id: 'fld_aa11bb', key: 'subject', name: 'subject', type: 'text' }] },
    { id: 'tbl_att', key: 'attachments', name: 'Attachments', fields: [{ id: 'fld_cc22dd', key: 'filename', name: 'filename', type: 'text' }] },
];
const LINKED = addRelation(TABLES, { fromTableId: 'tbl_att', toTableId: 'tbl_msg' }).tables;

function setup(props = {}) {
    const onChange = vi.fn();
    render(<RelationshipsTab tables={TABLES} connectors={[]} onChange={onChange} onOpenTable={() => {}} {...props} />);
    return { onChange };
}

describe('RelationshipsTab', () => {
    beforeEach(cleanup);

    it('draws every table, and every relation as an edge from holder to target', () => {
        setup({ tables: LINKED });
        expect(screen.getAllByTestId('node').map((n) => n.textContent)).toEqual(['Messages', 'Attachments']);
        expect(screen.getByTestId('edge').textContent).toBe('tbl_att→tbl_msg:messages_ref');
    });

    it('a drag adds the relation column to the table it started from', async () => {
        const user = userEvent.setup();
        const { onChange } = setup();
        await user.click(screen.getByTestId('connect'));
        const [next] = onChange.mock.calls[0];
        const added = next.find((t) => t.id === 'tbl_att').fields.at(-1);
        expect(added.type).toBe('relation');
        expect(added.relation).toEqual({ table: 'tbl_msg' });
        // Messages — the ONE side — gains nothing.
        expect(next.find((t) => t.id === 'tbl_msg').fields).toHaveLength(1);
    });

    it('refuses a self-link and says why, without touching the model', async () => {
        const user = userEvent.setup();
        const { onChange } = setup();
        await user.click(screen.getByTestId('self-connect'));
        expect(onChange).not.toHaveBeenCalled();
        expect(screen.getByRole('alert').textContent).toMatch(/cannot be linked to itself/i);
    });

    it('names the direction rather than leaving an arrow to be read both ways', async () => {
        const user = userEvent.setup();
        setup({ tables: LINKED });
        await user.click(screen.getByTestId('edge'));
        expect(screen.getByText(/belongs to one/).textContent).toMatch(/Each\s*Attachments\s*belongs to one\s*Messages/);
    });

    it('retargets and renames through the inspector', async () => {
        const user = userEvent.setup();
        const tables = [...LINKED, { id: 'tbl_thr', key: 'threads', name: 'Threads', fields: [] }];
        const { onChange } = setup({ tables });
        await user.click(screen.getByTestId('edge'));

        fireEvent.change(screen.getByLabelText('Column name'), { target: { value: 'Its message' } });
        expect(onChange.mock.calls[0][0].find((t) => t.id === 'tbl_att').fields.at(-1).name).toBe('Its message');

        await user.selectOptions(screen.getByLabelText('Related table'), 'tbl_thr');
        expect(onChange.mock.calls[1][0].find((t) => t.id === 'tbl_att').fields.at(-1).relation).toEqual({ table: 'tbl_thr' });
    });

    it('removes a link nobody fills', async () => {
        const user = userEvent.setup();
        const { onChange } = setup({ tables: LINKED });
        await user.click(screen.getByTestId('edge'));
        await user.click(screen.getByRole('button', { name: /remove this link/i }));
        expect(onChange.mock.calls[0][0].find((t) => t.id === 'tbl_att').fields).toHaveLength(1);
    });

    it('refuses to remove a link a connector fills, naming it', async () => {
        const user = userEvent.setup();
        // The model rejects a sync whose relation column is gone, so removing it
        // here would fail the whole save with a 422 much later.
        const connectors = [{
            id: 'conn_1', name: 'Gmail',
            sync: { tableId: 'tbl_msg', children: [{ tableId: 'tbl_att', relationField: 'messages_ref' }] },
        }];
        const { onChange } = setup({ tables: LINKED, connectors });
        await user.click(screen.getByTestId('edge'));
        await user.click(screen.getByRole('button', { name: /remove this link/i }));
        expect(onChange).not.toHaveBeenCalled();
        expect(screen.getByRole('alert').textContent).toMatch(/“Gmail” fills this link/);
    });

    it('badges the connector that fills a table', () => {
        const connectors = [{ id: 'conn_1', name: 'Gmail', sync: { tableId: 'tbl_msg' } }];
        setup({ tables: LINKED, connectors });
        expect(screen.getAllByTestId('node')[0].textContent).toBe('Messages (Gmail)');
    });

    it('warns about a relation whose target was deleted instead of hiding it', () => {
        setup({ tables: LINKED.filter((t) => t.id !== 'tbl_msg') });
        expect(screen.queryAllByTestId('edge')).toHaveLength(0);
        expect(screen.getByText(/a table that no longer exists/)).toBeTruthy();
    });

    it('says there is nothing to link when the app has no tables', () => {
        setup({ tables: [] });
        expect(screen.getByText(/No tables yet/)).toBeTruthy();
        expect(screen.queryByTestId('flow')).toBeNull();
    });
});
