import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import DiagramPaneJs, {
    NODE_TYPES, buildStepFromPayload, applyAddNode, createsCycle, branchFromHandle,
} from './DiagramPane';
import * as paneModule from './DiagramPane';

// DiagramPane is a .jsx forwardRef; its props are only guessed from defaults.
const DiagramPane = DiagramPaneJs as unknown as React.ComponentType<Record<string, unknown>>;

/**
 * Characterisation (golden) test for DiagramPane, written before the file was
 * split into flow/ hooks. It pins the paths no other DiagramPane.*.test file
 * drives: the per-node operations (context menu and letter keys), the
 * presenter toggle, the imperative handle, the node numbering published to
 * the editing chip, and the module's export surface.
 */
type Def = {
    trigger: { id: string; type?: string; kind?: string; label?: string; position?: { x: number; y: number } };
    steps: Array<{ id: string; type?: string; pinnedOutput?: unknown; label?: string; position?: { x: number; y: number } }>;
    edges: Array<{ from: string; to: string }>;
};
const DEF: Def = {
    trigger: { id: 'trg', type: 'trigger', kind: 'manual', label: 'Start', position: { x: 0, y: 0 } },
    steps: [
        { id: 'a', type: 'set', label: 'Shape', position: { x: 320, y: 0 } },
        { id: 'b', type: 'set', label: 'Tidy', position: { x: 640, y: 0 } },
        { id: 'c', type: 'set', label: 'Send', position: { x: 960, y: 0 } },
    ],
    edges: [{ from: 'trg', to: 'a' }, { from: 'a', to: 'b' }, { from: 'b', to: 'c' }],
};

function renderCanvas(props: Record<string, unknown> = {}) {
    const onDefinitionChange = vi.fn();
    const view = render(
        <div style={{ width: 1200, height: 800 }}>
            <DiagramPane definition={DEF} editable onDefinitionChange={onDefinitionChange} onNodeClick={vi.fn()} {...props} />
        </div>,
    );
    return { ...view, onDefinitionChange };
}

const nodeEl = (container: HTMLElement, id: string) => container.querySelector(`.react-flow__node[data-id="${id}"]`)!;
const lastDef = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls[fn.mock.calls.length - 1][0] as Def;

describe('DiagramPane — characterisation', () => {
    beforeEach(() => {
        cleanup();
        try { localStorage.clear(); } catch { /* ignore */ }
    });

    it('keeps the module export surface', () => {
        expect(Object.keys(paneModule).sort()).toEqual(
            ['NODE_TYPES', 'applyAddNode', 'branchFromHandle', 'buildStepFromPayload', 'createsCycle', 'default'],
        );
        expect(NODE_TYPES).toBeTruthy();
        expect(typeof buildStepFromPayload).toBe('function');
        expect(typeof applyAddNode).toBe('function');
        expect(typeof createsCycle).toBe('function');
        expect(typeof branchFromHandle).toBe('function');
    });

    it('context menu Delete bridges the chain around the removed step', () => {
        const { container, onDefinitionChange } = renderCanvas();
        fireEvent.contextMenu(nodeEl(container, 'b'), { clientX: 200, clientY: 200 });
        fireEvent.click(screen.getByRole('menuitem', { name: /^delete/i }));
        expect(onDefinitionChange).toHaveBeenCalledTimes(1);
        const next = lastDef(onDefinitionChange);
        expect(next.steps.map(s => s.id)).toEqual(['a', 'c']);
        expect(next.edges).toEqual(expect.arrayContaining([{ from: 'trg', to: 'a' }, expect.objectContaining({ from: 'a', to: 'c' })]));
    });

    it('context menu Duplicate adds one copy of the step', () => {
        const { container, onDefinitionChange } = renderCanvas();
        fireEvent.contextMenu(nodeEl(container, 'a'), { clientX: 200, clientY: 200 });
        fireEvent.click(screen.getByRole('menuitem', { name: /duplicate/i }));
        expect(onDefinitionChange).toHaveBeenCalledTimes(1);
        const next = lastDef(onDefinitionChange);
        expect(next.steps).toHaveLength(4);
        expect(next.steps.filter(s => s.label?.startsWith('Shape'))).toHaveLength(2);
    });

    it('a read-only canvas opens no context menu', () => {
        const { container } = renderCanvas({ editable: false });
        fireEvent.contextMenu(nodeEl(container, 'a'), { clientX: 200, clientY: 200 });
        expect(screen.queryByRole('menuitem', { name: /duplicate/i })).toBeNull();
    });

    it('letter keys on one selected step: D duplicates, U disconnects, R runs up to it', () => {
        const onExecuteStep = vi.fn();
        const { container, onDefinitionChange } = renderCanvas({ onExecuteStep });
        fireEvent.click(nodeEl(container, 'b'));
        fireEvent.keyDown(document, { key: 'd' });
        expect(onDefinitionChange).toHaveBeenCalledTimes(1);
        expect(lastDef(onDefinitionChange).steps).toHaveLength(4);
        fireEvent.keyDown(document, { key: 'u' });
        expect(onDefinitionChange).toHaveBeenCalledTimes(2);
        const detached = lastDef(onDefinitionChange);
        expect(detached.edges.some(e => e.from === 'b' || e.to === 'b')).toBe(false);
        fireEvent.keyDown(document, { key: 'r' });
        expect(onExecuteStep).toHaveBeenCalledWith('b', { mode: 'upTo' });
    });

    it('P on a selected step with a run output pins it; a modifier combo does nothing', () => {
        const runSteps = [{ stepId: 'a', status: 'success', output: { ok: 1 }, finishedAt: '2026-01-01T00:00:00Z' }];
        const { container, onDefinitionChange } = renderCanvas({ runSteps });
        fireEvent.click(nodeEl(container, 'a'));
        fireEvent.keyDown(document, { key: 'p', ctrlKey: true });
        expect(onDefinitionChange).not.toHaveBeenCalled();
        fireEvent.keyDown(document, { key: 'p' });
        expect(onDefinitionChange).toHaveBeenCalledTimes(1);
        expect(lastDef(onDefinitionChange).steps.find(s => s.id === 'a')?.pinnedOutput).toEqual({ ok: 1 });
    });

    it('Shift+P toggles presenter mode on the wrapper', () => {
        const { container } = renderCanvas();
        const wrapper = container.querySelector('.react-flow')!.parentElement!;
        expect(wrapper.getAttribute('data-presenter')).toBeNull();
        fireEvent.keyDown(document, { key: 'P', shiftKey: true });
        expect(wrapper.getAttribute('data-presenter')).toBe('on');
        fireEvent.keyDown(document, { key: 'P', shiftKey: true });
        expect(wrapper.getAttribute('data-presenter')).toBeNull();
    });

    it('the editing chip numbers steps in run order', () => {
        renderCanvas({ editingStepId: 'b' });
        expect(screen.getByTestId('editing-chip').textContent).toMatch(/Step 3 of 4/);
    });

    it('the imperative handle exposes getCenter and focusStep', () => {
        const ref = React.createRef<{ getCenter: () => { x: number; y: number }; focusStep: (id: string) => void }>();
        renderCanvas({ ref });
        const c = ref.current!.getCenter();
        expect(typeof c.x).toBe('number');
        expect(typeof c.y).toBe('number');
        expect(() => ref.current!.focusStep('a')).not.toThrow();
        expect(Object.keys(ref.current!).sort()).toEqual(['focusStep', 'getCenter']);
    });

    it('a delete while structural edits are blocked emits nothing', () => {
        const { container, onDefinitionChange } = renderCanvas({ structuralEditsBlocked: true });
        fireEvent.contextMenu(nodeEl(container, 'a'), { clientX: 200, clientY: 200 });
        expect(screen.queryByRole('menuitem', { name: /^delete/i })).toBeNull();
        fireEvent.click(nodeEl(container, 'a'));
        fireEvent.keyDown(document, { key: 'd' });
        expect(onDefinitionChange).not.toHaveBeenCalled();
    });
});
