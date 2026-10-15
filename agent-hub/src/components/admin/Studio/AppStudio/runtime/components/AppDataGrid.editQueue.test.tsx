/*
 * Characterisation of the inline-edit pipeline of AppDataGrid: the optimistic
 * overlay, the single-flight commit queue, the rollback on error and the
 * refetch reconciliation. Written before the grid was split into modules so
 * the split can be checked against the exact calls and on-screen values it
 * produced before; AppDataGrid.test.jsx covers the rest of the component.
 */
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import AppDataGrid from './AppDataGrid';
import { RuntimeProvider, buildScope, DEFAULT_RUNTIME } from '../RuntimeContext';
import type { ActionState, ActionStatus } from '../actionRunner/core';

const ROWS = [
    { id: 1, name: 'Zoe', updated_at: '2020-01-01T00:00:00.000Z' },
    { id: 2, name: 'Amy', updated_at: '2020-01-02T00:00:00.000Z' },
    { id: 3, name: 'Max', updated_at: '2020-01-03T00:00:00.000Z' },
];

const COLUMNS = [
    { key: 'name', label: 'Name', format: 'text', editable: true },
    { key: 'updated_at', label: 'Updated', format: 'text', editable: true },
];

function makeHarness({ onRowSelect = 'act_update' as string | null } = {}) {
    const runAction = vi.fn();
    const node = {
        id: 'cmp_grid_queue', type: 'data_grid', visible: true,
        ...(onRowSelect ? { onRowSelect } : {}),
        props: {
            columns: COLUMNS, pageSize: 25, selectable: 'none', searchable: false,
            rowActions: [], density: 'comfortable',
        },
        style: { span: 12 },
    };
    const ui = ({ actionState = {} as ActionState, rows = ROWS as Array<Record<string, unknown>> } = {}) => (
        <RuntimeProvider value={{
            ...DEFAULT_RUNTIME, scope: buildScope({ now: '2020-01-01T00:00:00.000Z' }),
            mode: 'run', runAction, actionState,
        }}
        >
            <AppDataGrid node={{ ...node, props: { ...node.props, source: { kind: 'static', value: rows } } }} />
        </RuntimeProvider>
    );
    const utils = render(ui());
    const user = userEvent.setup();
    // Name cells are triggers 0, 2, 4 (two editable columns per row).
    const nameTrigger = (row: number) => utils.getAllByLabelText(/^Edit \w/)[row * 2];
    const editName = async (row: number, value: string) => {
        await user.click(nameTrigger(row));
        const input = utils.getAllByLabelText('Edit cell')[0];
        await user.clear(input);
        await user.type(input, `${value}{Enter}`);
    };
    const status = (s: ActionStatus) => ({ act_update: { status: s, result: undefined, error: s === 'error' ? 'nope' : null } });
    return { runAction, utils, ui, user, nameTrigger, editName, status };
}

describe('AppDataGrid — inline-edit queue (characterisation)', () => {
    it('dispatches one commit with the full row as formValues AND item', async () => {
        const h = makeHarness();
        await h.editName(0, 'Zed');
        expect(h.runAction).toHaveBeenCalledTimes(1);
        const [actionId, payload] = h.runAction.mock.calls[0];
        expect(actionId).toBe('act_update');
        expect(payload).toEqual({
            formValues: { ...ROWS[0], name: 'Zed', __edited: 'name' },
            item: { ...ROWS[0], name: 'Zed', __edited: 'name' },
        });
        expect(h.nameTrigger(0).textContent).toBe('Zed');
    });

    it('without an update action the edit stays a local overlay and nothing runs', async () => {
        const h = makeHarness({ onRowSelect: null });
        await h.editName(0, 'Zed');
        expect(h.runAction).not.toHaveBeenCalled();
        expect(h.nameTrigger(0).textContent).toBe('Zed');
    });

    it('a queued edit to the row just written drops its stale updated_at token', async () => {
        const h = makeHarness();
        await h.editName(0, 'Zed');
        h.utils.rerender(h.ui({ actionState: h.status('running') }));
        await h.editName(0, 'Zak');
        expect(h.runAction).toHaveBeenCalledTimes(1);
        h.utils.rerender(h.ui({ actionState: h.status('success') }));
        expect(h.runAction).toHaveBeenCalledTimes(2);
        const values = { ...ROWS[0], name: 'Zak', __edited: 'name', updated_at: null };
        expect(h.runAction.mock.calls[1]).toEqual(['act_update', { formValues: values, item: values }]);
    });

    it('a queued edit to ANOTHER row keeps its updated_at token', async () => {
        const h = makeHarness();
        await h.editName(0, 'Zed');
        h.utils.rerender(h.ui({ actionState: h.status('running') }));
        await h.editName(1, 'Ann');
        h.utils.rerender(h.ui({ actionState: h.status('success') }));
        const values = { ...ROWS[1], name: 'Ann', __edited: 'name' };
        expect(h.runAction.mock.calls[1]).toEqual(['act_update', { formValues: values, item: values }]);
    });

    it('after a failed commit the queued one still dispatches, unchanged, and only the failed value rolls back', async () => {
        const h = makeHarness();
        await h.editName(0, 'Zed');
        h.utils.rerender(h.ui({ actionState: h.status('running') }));
        await h.editName(0, 'Zak');
        await h.editName(1, 'Ann');
        h.utils.rerender(h.ui({ actionState: h.status('error') }));
        // The first queued entry dispatches; the token stays because the write failed.
        expect(h.runAction).toHaveBeenCalledTimes(2);
        const values = { ...ROWS[0], name: 'Zak', __edited: 'name' };
        expect(h.runAction.mock.calls[1][1]).toEqual({ formValues: values, item: values });
        // The rollback deleted the row-0 name overlay (both edits share the key).
        expect(h.nameTrigger(0).textContent).toBe('Zoe');
        expect(h.nameTrigger(1).textContent).toBe('Ann');

        // Next settle dispatches the last queued entry; then the pipe is idle.
        h.utils.rerender(h.ui({ actionState: h.status('running') }));
        h.utils.rerender(h.ui({ actionState: h.status('success') }));
        expect(h.runAction).toHaveBeenCalledTimes(3);
        expect(h.runAction.mock.calls[2][1].formValues).toMatchObject({ id: 2, name: 'Ann', __edited: 'name' });
        h.utils.rerender(h.ui({ actionState: h.status('running') }));
        h.utils.rerender(h.ui({ actionState: h.status('success') }));
        expect(h.runAction).toHaveBeenCalledTimes(3);
        // Idle again: a fresh edit dispatches at once.
        await h.editName(2, 'Mo');
        expect(h.runAction).toHaveBeenCalledTimes(4);
    });

    it('a refetch keeps the overlay of edits still queued and drops the rest', async () => {
        const h = makeHarness();
        await h.editName(0, 'Zed');
        h.utils.rerender(h.ui({ actionState: h.status('running') }));
        await h.editName(1, 'Ann');
        const served = [{ ...ROWS[0], name: 'Server' }, { ...ROWS[1], name: 'Old' }, ROWS[2]];
        h.utils.rerender(h.ui({ actionState: h.status('running'), rows: served }));
        expect(h.nameTrigger(0).textContent).toBe('Server');
        expect(h.nameTrigger(1).textContent).toBe('Ann');
    });

    it('an unchanged value commits nothing', async () => {
        const h = makeHarness();
        await h.user.click(h.nameTrigger(0));
        await h.user.keyboard('{Enter}');
        expect(h.runAction).not.toHaveBeenCalled();
    });
});
