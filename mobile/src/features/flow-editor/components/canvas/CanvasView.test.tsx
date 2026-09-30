/**
 * The canvas over a real draft store: it draws the routine once it has room,
 * a node opens on a tap and offers its menu on a hold, a line's "+" and a
 * free port's "+" ask for a step in the right place, a drag moves a node,
 * connect mode draws and removes lines, a loop opens in place, Arrange
 * re-lays the routine out — each edit one step of the store's undo.
 */

import { act, cleanup, fireEvent, screen } from '@testing-library/react-native';
import React from 'react';
import { State } from 'react-native-gesture-handler';
import { fireGestureHandler, getByGestureTestId } from 'react-native-gesture-handler/jest-utils';

import type { FlowDefinition } from '@/features/flow-editor/model';
import { loopy } from '@/features/flow-editor/model/testing/fixtures';
import { createDraftStore, type DraftStore } from '@/features/flow-editor/state';
import { renderWithProviders } from '@/shared/testing/renderWithProviders';
import { ToastProvider } from '@/shared/ui';

import { CanvasView, type CanvasViewProps } from './CanvasView';

jest.setTimeout(30_000);

const DEF: FlowDefinition = {
    trigger: { id: 'trg', type: 'trigger', kind: 'manual', label: 'Start', position: { x: 0, y: 0 } },
    steps: [
        { id: 'a', type: 'ai_step', label: 'Sort the mail', prompt: 'Sort it', position: { x: 320, y: 0 } },
        { id: 'b', type: 'notification', label: 'Tell me', body: 'Done', position: { x: 640, y: 0 } },
        { id: 'c', type: 'set', label: 'Loose end', position: { x: 640, y: 200 } },
    ],
    edges: [{ from: 'trg', to: 'a' }, { from: 'a', to: 'b' }],
};

const stores: DraftStore[] = [];

function storeFor(def: FlowDefinition, locked = false): DraftStore {
    const store = createDraftStore({
        automationId: 'a1',
        seed: JSON.parse(JSON.stringify(def)),
        deps: { save: jest.fn(async () => ({ automation: null, warnings: [] }) as never), create: jest.fn() as never, delayMs: 60_000 },
    });
    if (locked) store.getState().setLocked(true);
    stores.push(store);
    return store;
}

async function mount(store: DraftStore, over: Partial<CanvasViewProps> = {}) {
    const props: CanvasViewProps = { store, onOpenStep: jest.fn(), onMenu: jest.fn(), onAdd: jest.fn(), ...over };
    await renderWithProviders(
        <ToastProvider>
            <CanvasView {...props} />
        </ToastProvider>,
    );
    await act(async () => {
        fireEvent(screen.getByTestId('canvas'), 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 700 } } });
    });
    return props;
}

const action = async (testID: string, actionName: 'activate' | 'longpress') => {
    await act(async () => {
        fireEvent(screen.getByTestId(testID), 'accessibilityAction', { nativeEvent: { actionName } });
    });
};

afterEach(async () => {
    await cleanup();
    // The autosave's timers would outlive the test.
    for (const store of stores.splice(0)) store.getState().dispose();
    jest.clearAllMocks();
});

describe('CanvasView', () => {
    it('draws every node once it has room, and opens a step on a tap and its menu on a hold', async () => {
        const props = await mount(storeFor(DEF));
        for (const id of ['trg', 'a', 'b', 'c']) expect(screen.getByTestId(`canvas-node-${id}`)).toBeTruthy();
        expect(screen.getByLabelText(/Sort the mail/)).toBeTruthy();
        await action('canvas-node-a', 'activate');
        expect(props.onOpenStep).toHaveBeenCalledWith('a');
        await action('canvas-node-b', 'longpress');
        expect(props.onMenu).toHaveBeenCalledWith('b');
    });

    it('asks for a step on a line (splicing it) and after a free port', async () => {
        const props = await mount(storeFor(DEF));
        expect(screen.getAllByLabelText('Insert a step here')).toHaveLength(2);
        await act(async () => fireEvent.press(screen.getByTestId('canvas-insert-a->b||')));
        expect(props.onAdd).toHaveBeenLastCalledWith({ kind: 'splice', sourceId: 'a', targetId: 'b', identity: {} });
        // One after each step nothing leaves, and the toolbar's own.
        expect(screen.getAllByLabelText('Add a step')).toHaveLength(3);
        await act(async () => fireEvent.press(screen.getByTestId('canvas-add:b|out')));
        expect(props.onAdd).toHaveBeenLastCalledWith({ kind: 'after', sourceId: 'b', handle: null });
        await act(async () => fireEvent.press(screen.getByTestId('canvas-add')));
        expect(props.onAdd).toHaveBeenLastCalledWith({ kind: 'root' });
    });

    it('moves a node held and dragged, as one undoable edit', async () => {
        const store = storeFor(DEF);
        await mount(store);
        await act(async () => {
            fireGestureHandler(getByGestureTestId('canvas-hold-c'), [
                { state: State.BEGAN, translationX: 0, translationY: 0 },
                { state: State.ACTIVE, translationX: 0, translationY: 0 },
                { state: State.ACTIVE, translationX: 40, translationY: 30 },
                { state: State.END, translationX: 40, translationY: 30 },
            ]);
        });
        const moved = store.getState().definition?.steps.find((s) => s.id === 'c')?.position;
        expect(moved?.x).toBeGreaterThan(640);
        expect(moved?.y).toBeGreaterThan(200);
        expect(store.getState().undo()).toBe(true);
        expect(store.getState().definition?.steps.find((s) => s.id === 'c')?.position).toEqual({ x: 640, y: 200 });
    });

    it('opens the menu when a hold ends where it began', async () => {
        const props = await mount(storeFor(DEF));
        await act(async () => {
            fireGestureHandler(getByGestureTestId('canvas-hold-a'), [
                { state: State.BEGAN }, { state: State.ACTIVE }, { state: State.END, translationX: 2, translationY: 1 },
            ]);
        });
        expect(props.onMenu).toHaveBeenCalledWith('a');
    });

    it('draws a line in connect mode: a port, then a step', async () => {
        const store = storeFor(DEF);
        await mount(store);
        await act(async () => fireEvent.press(screen.getByTestId('canvas-connect')));
        expect(screen.getByText('Tap a dot, or a step, to start a line')).toBeTruthy();
        await act(async () => fireEvent.press(screen.getByTestId('canvas-port-b-out')));
        expect(screen.getByText('Now tap the step the line goes to')).toBeTruthy();
        await action('canvas-node-c', 'activate');
        expect(store.getState().definition?.edges).toContainEqual({ from: 'b', to: 'c' });
    });

    it('refuses a line that would close a circle', async () => {
        const store = storeFor(DEF);
        await mount(store);
        await act(async () => fireEvent.press(screen.getByTestId('canvas-connect')));
        await act(async () => fireEvent.press(screen.getByTestId('canvas-port-b-out')));
        await action('canvas-node-a', 'activate');
        expect(store.getState().definition?.edges).toHaveLength(2);
        expect(screen.getByText('That line would make the flow run in a circle')).toBeTruthy();
    });

    it('removes a line with its "×" in connect mode', async () => {
        const store = storeFor(DEF);
        await mount(store);
        await act(async () => fireEvent.press(screen.getByTestId('canvas-connect')));
        const removes = screen.getAllByLabelText('Remove this connection');
        await act(async () => fireEvent.press(removes[1] as never));
        expect(store.getState().definition?.edges).toEqual([{ from: 'trg', to: 'a' }]);
    });

    it('opens a loop in place and closes it again', async () => {
        await mount(storeFor(loopy));
        expect(screen.queryByTestId('canvas-node-loop_1/b_cond')).toBeNull();
        expect(screen.getByText('3 steps inside')).toBeTruthy();
        await act(async () => fireEvent.press(screen.getByLabelText(/^Expand/)));
        expect(screen.getByTestId('canvas-node-loop_1/b_cond')).toBeTruthy();
        expect(screen.getByText('Each item')).toBeTruthy();
        // The item as the steps inside read it on their pills, not as `loop.item`.
        expect(screen.getByText('Loop item · item')).toBeTruthy();
        expect(screen.getByText('over ‹Trigger ▸ Items› · as loop.item · ≤100')).toBeTruthy();
        await act(async () => fireEvent.press(screen.getByLabelText(/^Collapse/)));
        expect(screen.queryByTestId('canvas-node-loop_1/b_cond')).toBeNull();
    });

    it('names an open loop’s list by the step that makes it, never by its id', async () => {
        const def: FlowDefinition = {
            trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
            steps: [
                { id: 'act_4d4307a', type: 'integration_action', tool: 'gmail_search' },
                { id: 'loop_1', type: 'loop', overRef: 'steps.act_4d4307a.output.results[*]', batchSize: 5, body: [{ id: 'b', type: 'set', label: 'Tidy' }] },
            ],
            edges: [{ from: 'trg', to: 'act_4d4307a' }, { from: 'act_4d4307a', to: 'loop_1' }],
        };
        await mount(storeFor(def));
        await act(async () => fireEvent.press(screen.getByLabelText(/^Expand/)));
        expect(screen.getByText('over ‹Gmail Search ▸ Results› · as loop.item · ×5 · ≤100')).toBeTruthy();
    });

    it('opens the loop from its "Each item", and inserts into the body from a body line', async () => {
        const props = await mount(storeFor(loopy));
        await act(async () => fireEvent.press(screen.getByLabelText(/^Expand/)));
        await action('canvas-node-loop_1/__item__', 'activate');
        expect(props.onOpenStep).toHaveBeenLastCalledWith('loop_1');
        await action('canvas-node-loop_1/b_cond', 'activate');
        expect(props.onOpenStep).toHaveBeenLastCalledWith('loop_1/b_cond');
        await act(async () => fireEvent.press(screen.getByTestId('canvas-insert-loop_1/b_cond->loop_1/b_sw|then|')));
        // Between the condition (0) and the switch (1): the new step goes in at 1.
        expect(props.onAdd).toHaveBeenLastCalledWith({ kind: 'inline', container: 'loop_1', branch: null, index: 1 });
    });

    it('arranges the routine from the menu, undoably', async () => {
        const store = storeFor(DEF);
        await mount(store);
        await act(async () => fireEvent.press(screen.getByTestId('canvas-more')));
        await act(async () => fireEvent.press(screen.getByText('One tight line')));
        const after = store.getState().definition;
        expect(after?.steps.find((s) => s.id === 'b')?.position).not.toEqual({ x: 640, y: 0 });
        expect(store.getState().canUndo).toBe(true);
    });

    it('pinches out to tiles, where the buttons on the lines give way', async () => {
        await mount(storeFor(DEF));
        // Too wide to fit a phone at a readable size: it opens at 60%, on its start.
        expect(screen.getByText('60%')).toBeTruthy();
        expect(screen.getAllByLabelText('Insert a step here')).toHaveLength(2);
        await act(async () => {
            fireGestureHandler(getByGestureTestId('canvas-pinch'), [
                { state: State.BEGAN, scale: 1, focalX: 195, focalY: 350 },
                { state: State.ACTIVE, scale: 1, focalX: 195, focalY: 350 },
                { state: State.ACTIVE, scale: 0.4, focalX: 195, focalY: 350 },
                { state: State.END, scale: 0.4, focalX: 195, focalY: 350 },
            ]);
        });
        expect(screen.getByText('25%')).toBeTruthy();
        expect(screen.queryAllByLabelText('Insert a step here')).toHaveLength(0);
        // Every node is still there, as a tile.
        for (const id of ['trg', 'a', 'b', 'c']) expect(screen.getByTestId(`canvas-node-${id}`)).toBeTruthy();
    });

    it('offers no edits while the AI builds', async () => {
        await mount(storeFor(DEF, true));
        expect(screen.queryAllByLabelText('Insert a step here')).toHaveLength(0);
        expect(screen.getByTestId('canvas-connect')).toBeDisabled();
    });

    it('starts an empty routine with its trigger', async () => {
        const onAdd = jest.fn();
        await renderWithProviders(
            <ToastProvider>
                <CanvasView store={storeFor({ trigger: null, steps: [], edges: [] })} onOpenStep={jest.fn()} onAdd={onAdd} />
            </ToastProvider>,
        );
        await act(async () => fireEvent.press(screen.getByText('Add a trigger')));
        expect(onAdd).toHaveBeenCalledWith({ kind: 'root' });
    });
});
