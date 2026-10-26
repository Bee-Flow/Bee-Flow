import { act, render } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import BuildTab from './BuildTab';
import { createLayerInDefinition as createLayerJs } from './flow/flowletScope';
import scopedStorage from '@/utils/scopedStorage';

/**
 * The golden behaviour of BuildTab's main paths, pinned before the file was
 * split into hooks: the build cue the canvas reads,
 * the one insert path (ribbon add, edge "+" splice), the smart Add-step
 * suggestions, the Flowlets manager and the expanded-flowlet write path.
 *
 * The heavy children are stubbed and their props captured: they are the
 * seam BuildTab is measured through. applyAddNode stays the real one.
 */

let diagram: any = null;
let ribbon: any = null;
let menu: any = null;
let flowlets: any = null;

const createLayerInDefinition = createLayerJs as (def: any, title?: string) => { definition: any; layerKey: string };

const api = {
    getCatalog: vi.fn(() => Promise.resolve({ apps: [], steps: [] })),
    summariseLayer: vi.fn(() => Promise.resolve({ summary: ' Sends the mail. ' })),
};

vi.mock('@/hooks/useAutomationApi', () => ({ default: () => api }));
vi.mock('../../shared/Toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('./DiagramPane', async () => {
    const real = await import('./applyAddNode');
    return { default: (p: any) => { if (p.editable !== false) diagram = p; return null; }, applyAddNode: real.applyAddNode };
});
vi.mock('./flow/AddStepRibbon', () => ({ default: (p: any) => { ribbon = p; return null; } }));
vi.mock('./flow/AddStepMenu', () => ({ default: (p: any) => { menu = p; return null; } }));
vi.mock('./FlowletsPanel', () => ({ default: (p: any) => { flowlets = p; return null; } }));
vi.mock('./NodeDetailView', () => ({ default: () => null }));
vi.mock('./BuilderHeader', () => ({ default: () => null }));
vi.mock('./CanvasPlanPanel', () => ({ default: () => null }));
vi.mock('../../chat/InputArea', () => ({ default: () => null }));

function linearDef() {
    return {
        trigger: { id: 'trg', type: 'trigger', kind: 'manual', position: { x: 0, y: 0 } },
        steps: [
            { id: 's1', type: 'ai_step', position: { x: 300, y: 0 } },
            { id: 's2', type: 'ai_step', position: { x: 600, y: 0 } },
        ],
        edges: [{ from: 'trg', to: 's1' }, { from: 's1', to: 's2' }],
    };
}

function baseState(over: Record<string, unknown> = {}): any {
    return { messages: [], steps: [], running: false, automationId: 'a1', ...over };
}

function renderTab(props: Record<string, unknown> = {}) {
    const def = (props.rootDef as any) || linearDef();
    const all = {
        assistantOpen: false, setAssistantOpen: vi.fn(),
        state: baseState(),
        automation: { id: 'a1' },
        rootDef: def, scopedDef: def, scopeKey: null, setScopeKey: vi.fn(),
        onVisualEditRoot: vi.fn(), onVisualEdit: vi.fn(),
        chatInput: '', setChatInput: vi.fn(), modelTiers: [], selectedTier: null, setSelectedTier: vi.fn(), user: null,
        onSend: vi.fn(), messagesContainerRef: { current: null }, messagesEndRef: { current: null },
        ndvStepId: null, openNdv: vi.fn(), closeNdv: vi.fn(), stepById: () => null, runStepById: () => null, onSaveStep: vi.fn(),
        onExecuteStep: vi.fn(), onRetryFromStep: vi.fn(), onStopRun: vi.fn(), pollRunProgress: vi.fn(),
        fatalError: null, onDismissFatal: vi.fn(),
        ...props,
    };
    const utils = render(<BuildTab {...(all as any)} />);
    return { ...utils, props: all, rerender: (next: Record<string, unknown>) => utils.rerender(<BuildTab {...({ ...all, ...next } as any)} />) };
}

async function flush() {
    await act(async () => { await Promise.resolve(); });
}

beforeEach(() => {
    diagram = null; ribbon = null; menu = null; flowlets = null;
    api.getCatalog.mockClear();
    api.summariseLayer.mockClear();
    try { window.localStorage.clear(); } catch { /* jsdom */ }
});

describe('BuildTab — the build cue the canvas reads', () => {
    it('is idle and empty without a turn', async () => {
        renderTab();
        await flush();
        expect(diagram.buildCue).toEqual({
            running: false, phase: diagram.buildCue.phase, startedAt: null, lastCall: null, narration: null,
            todos: [], finalizedId: null, aborted: null, stepCount: 2, engine: null, turn: null, toolDraft: null,
        });
    });

    it('describes the last tool call, the narration and the plan while building', async () => {
        const toolCall = { name: 'builder_add_action', input: { label: 'Send mail' }, result: { stepId: 'x1' } };
        const state = baseState({
            running: true,
            todos: [{ id: 't1', text: 'Add the mail', status: 'in_progress' }],
            engine: { model: 'm' }, turn: { firstEventAt: 1 },
            messages: [
                { role: 'user', content: 'make it' },
                { role: 'assistant', content: '', toolCalls: [toolCall], thinkingSummary: { text: '  Wiring the mail  ' } },
            ],
        });
        renderTab({ state });
        await flush();
        const cue = diagram.buildCue;
        expect(cue.running).toBe(true);
        expect(typeof cue.startedAt).toBe('number');
        expect(cue.narration).toBe('Wiring the mail');
        expect(cue.todos).toBe(state.todos);
        expect(cue.engine).toEqual({ model: 'm' });
        expect(cue.turn).toEqual({ firstEventAt: 1 });
        expect(cue.stepCount).toBe(2);
        expect(cue.lastCall.name).toBe('builder_add_action');
        expect(Array.isArray(cue.lastCall.added)).toBe(true);
    });
});

describe('BuildTab — the insert path', () => {
    it('a ribbon add lands after the last step, wired from it, and bumps the usage tick', async () => {
        const { props } = renderTab();
        await flush();
        expect(ribbon.usageVersion).toBe(0);
        act(() => { ribbon.onAddNode({ kind: 'code', label: 'Code' }); });
        const onVisualEdit = props.onVisualEdit as any;
        expect(onVisualEdit).toHaveBeenCalledTimes(1);
        const next = onVisualEdit.mock.calls[0][0];
        const added = next.steps.find((s: any) => s.type === 'code');
        expect(added).toBeTruthy();
        expect(next.edges).toContainEqual(expect.objectContaining({ from: 's2', to: added.id }));
        expect(ribbon.usageVersion).toBe(1);
        expect(ribbon.scope.frequent.length).toBeGreaterThanOrEqual(0);
    });

    it('the edge "+" opens the positioned menu with suggestions, splices, then closes', async () => {
        const { props } = renderTab();
        await flush();
        expect(menu).toBeNull();
        act(() => { diagram.onRequestInsertOnEdge({ sourceId: 's1', targetId: 's2' }); });
        expect(menu).not.toBeNull();
        expect(Array.isArray(menu.scope.suggested)).toBe(true);
        expect(Array.isArray(menu.scope.frequent)).toBe(true);
        expect(menu.scope.inLayer).toBe(false);
        const add = menu.onAdd;
        menu = null;
        act(() => { add({ kind: 'code', label: 'Code' }); });
        // A wired insert is single-shot: the menu closed and did not render again.
        expect(menu).toBeNull();
        const next = (props.onVisualEdit as any).mock.calls[0][0];
        const added = next.steps.find((s: any) => s.type === 'code');
        expect(next.edges.some((e: any) => e.from === 's1' && e.to === 's2')).toBe(false);
        expect(next.edges).toContainEqual(expect.objectContaining({ from: 's1', to: added.id }));
        expect(next.edges).toContainEqual(expect.objectContaining({ from: added.id, to: 's2' }));
        act(() => { diagram.onRequestAddAfter('s2'); });
        expect(menu).not.toBeNull();
    });

    it('a note dropped on a connection is never wired', async () => {
        const { props } = renderTab();
        await flush();
        act(() => { diagram.onDropStep({ kind: 'note', text: 'n' }, { sourceId: 's1', targetId: 's2' }); });
        const next = (props.onVisualEdit as any).mock.calls[0][0];
        const note = next.steps.find((s: any) => s.type === 'note');
        expect(next.edges.some((e: any) => e.from === note.id || e.to === note.id)).toBe(false);
    });
});

describe('BuildTab — the Flowlets manager', () => {
    it('opens from the canvas, creates, renames and deletes flowlets through onVisualEditRoot', async () => {
        const root = linearDef();
        const { props } = renderTab({ rootDef: root, scopedDef: root });
        await flush();
        expect(flowlets).toBeNull();
        expect(diagram.flowletsOpen).toBe(false);
        act(() => { diagram.onToggleFlowlets(); });
        expect(diagram.flowletsOpen).toBe(true);
        expect(flowlets.aiEnabled).toBe(false);
        expect(flowlets.summarizingKey).toBeNull();
        expect(flowlets.summarizingRoot).toBe(false);

        const editRoot = props.onVisualEditRoot as any;
        act(() => { flowlets.onCreateLayer(); });
        const created = editRoot.mock.calls[0][0];
        const [key] = Object.keys(created.layers);
        expect(created.layers[key].title).toBe('New flowlet');
        expect(props.setScopeKey).toHaveBeenCalledWith(key);

        act(() => { flowlets.onRenameLayer('nope', 'X'); });
        expect(editRoot).toHaveBeenCalledTimes(2);

        await act(async () => { await flowlets.onDeleteLayer('nope'); });
        expect(editRoot).toHaveBeenCalledTimes(3);
        expect(flowlets.refCountFor('nope')).toBe(0);
    });

    it('AI summaries are opt-in, persisted, and write the description back', async () => {
        const { definition: root, layerKey } = createLayerInDefinition(linearDef(), 'Mailer');
        const { props } = renderTab({ rootDef: root, scopedDef: root });
        await flush();
        act(() => { diagram.onToggleFlowlets(); });
        const setItem = vi.spyOn(scopedStorage, 'setItem');
        act(() => { flowlets.onToggleAi(); });
        expect(flowlets.aiEnabled).toBe(true);
        expect(setItem).toHaveBeenCalledWith('layerAiSummaries', '1');
        setItem.mockRestore();

        await act(async () => { await flowlets.onSummarize(layerKey); });
        expect(api.summariseLayer).toHaveBeenCalledWith(root.layers[layerKey]);
        const written = (props.onVisualEditRoot as any).mock.calls.at(-1)[0];
        expect(written.layers[layerKey].description).toBe('Sends the mail.');
        expect(flowlets.summarizingKey).toBeNull();

        await act(async () => { await flowlets.onSummarizeRoot(); });
        expect((props.onVisualEditRoot as any).mock.calls.at(-1)[0].description).toBe('Sends the mail.');
        expect(flowlets.summarizingRoot).toBe(false);
    });

    it('a flowlet with steps and callers stays protected from delete', async () => {
        const { definition: withLayer, layerKey } = createLayerInDefinition(linearDef(), 'Mailer');
        const root = {
            ...withLayer,
            layers: { ...withLayer.layers, [layerKey]: { ...withLayer.layers[layerKey], steps: [...withLayer.layers[layerKey].steps, { id: 'w', type: 'code' }] } },
            steps: [...withLayer.steps, { id: 'c1', type: 'call_layer', layerKey, position: { x: 900, y: 0 } }],
        };
        const { props } = renderTab({ rootDef: root, scopedDef: root });
        await flush();
        act(() => { diagram.onToggleFlowlets(); });
        expect(flowlets.refCountFor(layerKey)).toBe(1);
        await act(async () => { await flowlets.onDeleteLayer(layerKey); });
        expect(props.onVisualEditRoot).not.toHaveBeenCalled();
    });
});

describe('BuildTab — expanded flowlets on the canvas', () => {
    it('folds a call site in, counts its callers and writes edits back through the root', async () => {
        const { definition: withLayer, layerKey } = createLayerInDefinition(linearDef(), 'Mailer');
        const root = {
            ...withLayer,
            steps: [...withLayer.steps, { id: 'c1', type: 'call_layer', layerKey, position: { x: 900, y: 0 } }],
            edges: [...withLayer.edges, { from: 's2', to: 'c1' }],
        };
        const { props } = renderTab({ rootDef: root, scopedDef: root });
        await flush();
        expect(diagram.definition).toBe(root);
        expect(diagram.layerRefCounts).toEqual({});
        expect(diagram.sidecar.size).toBe(0);

        act(() => { diagram.onToggleInline('c1', layerKey); });
        expect(diagram.sidecar.size).toBe(1);
        expect(diagram.layerRefCounts).toEqual({ [layerKey]: 1 });
        expect(diagram.definition.steps.some((s: any) => s.id.startsWith('c1/'))).toBe(true);

        act(() => { diagram.onDefinitionChange(diagram.definition); });
        expect(props.onVisualEdit).not.toHaveBeenCalled();
        expect(props.onVisualEditRoot).toHaveBeenCalledTimes(1);
        const written = (props.onVisualEditRoot as any).mock.calls[0][0];
        expect(written.steps.some((s: any) => s.id.startsWith('c1/'))).toBe(false);
        expect(written.layers[layerKey]).toBeTruthy();

        act(() => { diagram.onCollapseAllFlowlets(); });
        expect(diagram.sidecar.size).toBe(0);
        expect(diagram.definition).toBe(root);
        act(() => { diagram.onExpandAllFlowlets(); });
        expect(diagram.sidecar.size).toBe(1);

        // Without an expansion the edit goes straight to onVisualEdit.
        act(() => { diagram.onCollapseAllFlowlets(); });
        act(() => { diagram.onDefinitionChange(root); });
        expect(props.onVisualEdit).toHaveBeenCalledWith(root);
    });
});
