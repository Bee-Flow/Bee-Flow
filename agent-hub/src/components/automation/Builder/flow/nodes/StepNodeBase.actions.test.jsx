import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ReactFlowProvider } from '@xyflow/react';
import StepNodeBase from './StepNodeBase';
import { NodeRuntimeContext } from '../NodeRuntimeContext';

/**
 * The action chrome above a node. "Disconnect" is the one action that only
 * sometimes applies: it takes a step OUT of the flow but keeps the card, so on
 * a card that is already loose it would do nothing and must not be offered.
 * "Pin" is the other conditional one: it needs a captured output to freeze.
 */
function renderNode(rt = {}, nodeId = 'b', props = {}) {
    return render(
        <ReactFlowProvider>
            <NodeRuntimeContext.Provider value={{
                pinnedById: new Set(),
                disabledById: new Set(),
                triggerIds: new Set(['trg']),
                primaryTriggerId: 'trg',
                attachedIds: new Set(['b']),
                pinnableIds: new Set(),
                ...rt,
            }}>
                <StepNodeBase nodeId={nodeId} icon={null} typeLabel="Notify" name="step" {...props} />
            </NodeRuntimeContext.Provider>
        </ReactFlowProvider>,
    );
}

const classesOf = (el) => el.getAttribute('class') || '';
const card = (container) => container.querySelector('.group');
const visible = (el) => classesOf(el).includes('opacity-100') && !classesOf(el).includes('opacity-0');
const hidden = (el) => classesOf(el).includes('opacity-0');

describe('StepNodeBase — icons appear on hover, focus and tap', () => {
    beforeEach(cleanup);

    // Driven by React state rather than Tailwind `group-hover` so it can
    // actually be asserted: jsdom applies no stylesheet, so a CSS-only rule
    // would be untestable and could silently stop working.
    it('hovering the card reveals run, disconnect and delete; leaving hides them', () => {
        const { container } = renderNode({ onExecuteStep: vi.fn(), onDetachNode: vi.fn(), onDeleteNode: vi.fn() });
        const toolbar = () => screen.getByTestId('node-hover-toolbar');

        expect(hidden(toolbar())).toBe(true);
        fireEvent.mouseEnter(card(container));
        expect(visible(toolbar())).toBe(true);
        fireEvent.mouseLeave(card(container));
        expect(hidden(toolbar())).toBe(true);
    });

    it('keyboard focus reveals the same chrome — every hover action has a keyboard path', () => {
        const { container } = renderNode({ onDeleteNode: vi.fn() });
        const toolbar = () => screen.getByTestId('node-hover-toolbar');
        expect(hidden(toolbar())).toBe(true);
        fireEvent.focus(card(container));
        expect(visible(toolbar())).toBe(true);
        fireEvent.blur(card(container));
        expect(hidden(toolbar())).toBe(true);
    });

    it('a touch tap reveals it too, and a second tap hides it', () => {
        const { container } = renderNode({ onDeleteNode: vi.fn() });
        const toolbar = () => screen.getByTestId('node-hover-toolbar');
        fireEvent.pointerUp(card(container), { pointerType: 'touch' });
        expect(visible(toolbar())).toBe(true);
        fireEvent.pointerUp(card(container), { pointerType: 'touch' });
        expect(hidden(toolbar())).toBe(true);
    });

    it('keeps every action in ONE centred row, in a fixed order', () => {
        // Execute used to sit centred and the rest right-anchored, and the
        // right-hand group grows and shrinks per step type — so the chrome
        // visibly jumped from node to node (BFSF-346).
        renderNode({
            onExecuteStep: vi.fn(), onDetachNode: vi.fn(), onDeleteNode: vi.fn(), onDuplicateNode: vi.fn(),
            onPinNode: vi.fn(), pinnableIds: new Set(['b']),
        });
        const toolbar = screen.getByTestId('node-hover-toolbar');
        const order = ['Execute step', 'Duplicate step', 'Disconnect step', 'Pin step', 'Delete step'];
        for (const name of order) expect(screen.getByLabelText(name).parentElement).toBe(toolbar);
        const rendered = [...toolbar.querySelectorAll('button')].map(b => b.getAttribute('aria-label'));
        expect(rendered).toEqual(order);
        expect(classesOf(toolbar)).toContain('left-1/2');
        expect(classesOf(toolbar)).toContain('-translate-x-1/2');
    });

    it('the add-next-step button follows the same hover state', () => {
        const { container } = render(
            <ReactFlowProvider>
                <NodeRuntimeContext.Provider value={{ pinnedById: new Set(), disabledById: new Set(), triggerIds: new Set(), attachedIds: new Set() }}>
                    <StepNodeBase nodeId="b" icon={null} typeLabel="Notify" name="step" onAddAfter={vi.fn()} />
                </NodeRuntimeContext.Provider>
            </ReactFlowProvider>,
        );
        expect(hidden(screen.getByLabelText('Add next step'))).toBe(true);
        fireEvent.mouseEnter(card(container));
        expect(visible(screen.getByLabelText('Add next step'))).toBe(true);
    });

    it('hidden chrome cannot be clicked through', () => {
        renderNode({ onDeleteNode: vi.fn() });
        expect(classesOf(screen.getByLabelText('Delete step').parentElement)).toContain('pointer-events-none');
    });

    it('no popover competes with the icons for the same hover', () => {
        const { container } = renderNode({ onDeleteNode: vi.fn() }, 'b');
        fireEvent.mouseEnter(card(container));
        expect(screen.queryByText(/Runs once per item/)).toBeNull();
    });
});

describe('StepNodeBase — the play button runs UP TO this step', () => {
    beforeEach(cleanup);

    it('asks for everything before the step, not just the step', () => {
        const onExecuteStep = vi.fn();
        renderNode({ onExecuteStep });
        fireEvent.click(screen.getByLabelText('Execute step'));
        expect(onExecuteStep).toHaveBeenCalledWith('b', { mode: 'upTo' });
    });

    it('says so, and says what pinning does', () => {
        renderNode({ onExecuteStep: vi.fn() });
        expect(screen.getByLabelText('Execute step').title).toMatch(/up to here/i);
        expect(screen.getByLabelText('Execute step').title).toMatch(/pinned/i);
    });

    it('is disabled while a full run is in flight', () => {
        renderNode({ onExecuteStep: vi.fn(), runInFlight: true });
        expect(screen.getByLabelText('Execute step').disabled).toBe(true);
    });
});

describe('StepNodeBase — branch ports', () => {
    beforeEach(cleanup);

    it('labels every output port without waiting for a hover', () => {
        render(
            <ReactFlowProvider>
                <NodeRuntimeContext.Provider value={{ pinnedById: new Set(), disabledById: new Set(), triggerIds: new Set(), attachedIds: new Set() }}>
                    <StepNodeBase
                        nodeId="b" icon={null} typeLabel="Condition" name="step"
                        sourceHandles={[{ id: 'match', label: 'match' }, { id: 'otherwise', label: 'otherwise' }]}
                    />
                </NodeRuntimeContext.Provider>
            </ReactFlowProvider>,
        );
        for (const label of ['match', 'otherwise']) {
            const el = screen.getByTitle(label);
            expect(el.className).not.toContain('opacity-0');
            expect(el.className).not.toContain('group-hover:opacity-100');
        }
    });
});

describe('StepNodeBase — disconnect action', () => {
    beforeEach(cleanup);

    it('offers it on a wired step and reports the node id', () => {
        const onDetachNode = vi.fn();
        renderNode({ onDetachNode });
        fireEvent.click(screen.getByLabelText('Disconnect step'));
        expect(onDetachNode).toHaveBeenCalledWith('b');
    });

    it('hides it on a card that is not wired to anything', () => {
        renderNode({ onDetachNode: vi.fn(), attachedIds: new Set() });
        expect(screen.queryByLabelText('Disconnect step')).toBeNull();
    });

    it('hides it on a trigger, and on a read-only canvas', () => {
        renderNode({ onDetachNode: vi.fn(), attachedIds: new Set(['trg']) }, 'trg');
        expect(screen.queryByLabelText('Disconnect step')).toBeNull();
        cleanup();
        renderNode({ onDetachNode: null });
        expect(screen.queryByLabelText('Disconnect step')).toBeNull();
    });
});

describe('StepNodeBase — pin action (the fifth button)', () => {
    beforeEach(cleanup);

    it('offers Pin only when there is an output to freeze, and reports the node id', () => {
        const onPinNode = vi.fn();
        renderNode({ onPinNode, pinnableIds: new Set(['b']) });
        fireEvent.click(screen.getByLabelText('Pin step'));
        expect(onPinNode).toHaveBeenCalledWith('b');
    });

    it('is absent with nothing to pin — a button that cannot do anything is a lie', () => {
        renderNode({ onPinNode: vi.fn(), pinnableIds: new Set() });
        expect(screen.queryByLabelText('Pin step')).toBeNull();
    });

    it('reads Unpin on a pinned card, even with no fresh output', () => {
        renderNode({ onPinNode: vi.fn(), pinnedById: new Set(['b']), pinnableIds: new Set() });
        expect(screen.getByLabelText('Unpin step')).toBeTruthy();
    });

    it('never appears on a trigger — a trigger has no run row to freeze', () => {
        renderNode({ onPinNode: vi.fn(), pinnableIds: new Set(['trg']) }, 'trg');
        expect(screen.queryByLabelText('Pin step')).toBeNull();
    });
});
