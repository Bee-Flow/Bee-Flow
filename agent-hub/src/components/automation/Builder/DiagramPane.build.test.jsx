import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * The build as a film, where all of its parts meet: the REAL ReactFlow inside
 * a 1200×800 div, with drafts arriving as rerenders the way BuildTab hands them
 * down (`structuralEditsBlocked` + a growing `definition` + `buildCue`).
 *
 * What this seam pins that the unit tests cannot: the flag from the hook
 * reaches the card ROOT as `data-build` in the same commit the card appears;
 * the frontier hands over (the card that was live stops being live when the
 * next one lands); the camera really is called through `useReactFlow` after
 * the timers run; every flag and the ghost are gone once the build ends and
 * nothing moves after the closing shot; a run in flight owns the canvas; and
 * the south bar carries the build banner (with a refusal as "Skipped:") where
 * the amber "AI is editing" chip used to be.
 *
 * jsdom has no layout, so the wrapper is given a size by hand (the push-in
 * frames from the layout's own rects and the wrapper's box, never from
 * measurement) and `useReactFlow` is a spy — React Flow's own fitView never
 * fires here because nodes are never measured, which keeps the camera
 * assertions about OUR calls only.
 */
const rfSpy = vi.hoisted(() => ({
    fitView: vi.fn(),
    setViewport: vi.fn(),
    setCenter: vi.fn(),
    getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
    getNode: () => null,
    getNodes: () => [],
    getZoom: () => 1,
    zoomIn: vi.fn(),
    zoomOut: vi.fn(),
    zoomTo: vi.fn(),
    screenToFlowPosition: (p) => p,
    setNodes: vi.fn(),
}));
vi.mock('@xyflow/react', async (importOriginal) => ({ ...(await importOriginal()), useReactFlow: () => rfSpy }));

const { default: DiagramPane } = await import('./DiagramPane');
const { describeToolCall } = await import('./chat/toolCallDisplay');
const { FLAG_TTL_MS } = await import('./flow/useBuildChoreography');

const T0 = new Date('2026-09-10T10:00:00Z').getTime();
// The hook stamps Date.now() on flags and moves; the clock is faked with the
// timers. setImmediate is left alone so React's scheduler keeps running.
const FAKES = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'requestAnimationFrame', 'cancelAnimationFrame'];

// Positions on every node, so layout.js keeps them instead of re-running dagre
// and the geometry below is exactly what the camera sees. The chain sits on one
// row (column pitch 320) well inside the 48 px margin `isRectInView` keeps —
// a card on the very edge counts as off-screen, rightly; the third step is
// parked far right so it is off the 1200 px screen at zoom 1 and the push-in
// has a reason to fire.
const ROW_Y = 200;
const TRIGGER = { id: 'trg', type: 'trigger', kind: 'manual', label: 'Start', position: { x: 0, y: ROW_Y } };
const step = (id, label, x) => ({ id, type: 'set', label, fields: [{ name: 'a', value: id }], position: { x, y: ROW_Y } });
const DEF1 = {
    trigger: TRIGGER,
    steps: [step('a', 'First card', 320)],
    edges: [{ from: 'trg', to: 'a' }],
};
const DEF2 = {
    ...DEF1,
    steps: [...DEF1.steps, step('b', 'Second card', 640)],
    edges: [...DEF1.edges, { from: 'a', to: 'b' }],
};
const DEF3 = {
    ...DEF2,
    steps: [...DEF2.steps, step('c', 'Third card', 2000)],
    edges: [...DEF2.edges, { from: 'b', to: 'c' }],
};

const cue = (over = {}) => ({
    running: true, phase: 'building', startedAt: T0 - 5000, lastCall: null, narration: null,
    todos: [], finalizedId: null, aborted: null, stepCount: 0, ...over,
});

const BOX = { x: 0, y: 0, left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800, toJSON() { return this; } };

function Canvas(props) {
    return (
        <div style={{ width: 1200, height: 800 }}>
            <DiagramPane editable onDefinitionChange={() => {}} {...props} />
        </div>
    );
}

/**
 * Render, then give the pane's wrapper (the div holding the .react-flow root)
 * a real box: `useBuildChoreography` reads it to frame the push-in, and jsdom
 * would otherwise report 0×0 and the camera would rightly stay still.
 */
function renderCanvas(props) {
    const utils = render(<Canvas {...props} />);
    const wrapper = utils.container.querySelector('.react-flow')?.parentElement;
    if (wrapper) wrapper.getBoundingClientRect = () => BOX;
    return { ...utils, rerender: (next) => utils.rerender(<Canvas {...next} />) };
}

/** The step card (StepNodeBase root, the element that wears data-build) whose name is `label`. */
function cardNamed(label) {
    const node = screen.getByText(label).closest('.react-flow__node');
    expect(node, `a React Flow node named "${label}"`).toBeTruthy();
    return node.querySelector('[data-family]');
}

const cameraCalls = () => rfSpy.fitView.mock.calls.length + rfSpy.setViewport.mock.calls.length + rfSpy.setCenter.mock.calls.length;

describe('DiagramPane — the build as a film', () => {
    beforeEach(() => {
        cleanup();
        vi.useFakeTimers({ toFake: FAKES });
        vi.setSystemTime(T0);
        rfSpy.fitView.mockClear();
        rfSpy.setViewport.mockClear();
        rfSpy.setCenter.mockClear();
    });
    afterEach(() => { vi.useRealTimers(); });

    it('a new card arrives fresh, the frontier hands over, and the camera pushes in on it once it is off-screen', () => {
        const { rerender, container } = renderCanvas({ definition: DEF1, structuralEditsBlocked: true, buildCue: cue() });
        // Nothing is flagged before anything has been added.
        expect(container.querySelectorAll('[data-build]').length).toBe(0);

        // Draft 1: the second card lands next to the first, inside the frame.
        rerender({ definition: DEF2, structuralEditsBlocked: true, buildCue: cue() });
        expect(cardNamed('Second card').getAttribute('data-build')).toBe('fresh');
        expect(cardNamed('Second card').style.getPropertyValue('--bf-reveal-delay')).toBe('0ms');
        expect(cardNamed('First card').getAttribute('data-build')).toBeNull();
        // In view already, so the camera does not move for it.
        act(() => { vi.advanceTimersByTime(100); });
        expect(cameraCalls()).toBe(0);

        // The reveal settles: the fresh flag dies by time and the card becomes
        // the live frontier — the only --accent outline on the canvas.
        act(() => { vi.advanceTimersByTime(FLAG_TTL_MS + 100); });
        expect(cardNamed('Second card').getAttribute('data-build')).toBe('live');
        expect(container.querySelectorAll('[data-build="live"]').length).toBe(1);

        // Draft 2: the third card lands off-screen.
        rerender({ definition: DEF3, structuralEditsBlocked: true, buildCue: cue() });
        const third = cardNamed('Third card');
        expect(third.getAttribute('data-build')).toBe('fresh');
        expect(third.style.getPropertyValue('--bf-ring')).toMatch(/^var\(--type-/);
        // The previous frontier is no longer live: one live card at a time.
        expect(cardNamed('Second card').getAttribute('data-build')).toBeNull();
        expect(container.querySelectorAll('[data-build="live"]').length).toBe(0);
        // (The connection's draw-in is pinned in flow/edges.test.jsx: React
        // Flow mounts an edge only after both ends are measured, which jsdom
        // never does, so it cannot be seen from here.)

        // The push-in is planned from an effect and fired from a timer.
        act(() => { vi.advanceTimersByTime(100); });
        expect(rfSpy.setViewport).toHaveBeenCalledTimes(1);
        const [viewport, options] = rfSpy.setViewport.mock.calls[0];
        // Near LOD: the summary line must stay legible after the cut.
        expect(viewport.zoom).toBeGreaterThanOrEqual(0.85);
        expect(viewport.zoom).toBeLessThanOrEqual(1);
        expect(options.duration).toBe(480);
        expect(rfSpy.fitView).not.toHaveBeenCalled();
    });

    it('a builder_add_steps burst is dealt in the order the model reported, one card per 1.2 s, flight-free without a ribbon', () => {
        // Three cards land at once in the draft; `buildCue.lastCall.added` says
        // the model wrote them d, b, c — and that is the order they are dealt.
        const BURST = {
            ...DEF1,
            steps: [...DEF1.steps, step('b', 'Card B', 640), step('c', 'Card C', 960), step('d', 'Card D', 1280)],
            edges: [...DEF1.edges, { from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'd' }],
        };
        const lastCall = {
            name: 'builder_add_steps',
            ...describeToolCall({ name: 'builder_add_steps', arguments: {}, result: { added: [{ id: 'd', type: 'set' }, { id: 'b', type: 'set' }, { id: 'c', type: 'set' }] } }),
            added: [{ id: 'd', type: 'set' }, { id: 'b', type: 'set' }, { id: 'c', type: 'set' }],
        };
        const { rerender, container } = renderCanvas({ definition: DEF1, structuralEditsBlocked: true, buildCue: cue() });
        rerender({ definition: BURST, structuralEditsBlocked: true, buildCue: cue({ lastCall }) });
        for (const label of ['Card B', 'Card C', 'Card D']) expect(cardNamed(label).getAttribute('data-build')).toBe('fresh');
        expect(cardNamed('Card D').style.getPropertyValue('--bf-reveal-delay')).toBe('0ms');
        expect(cardNamed('Card B').style.getPropertyValue('--bf-reveal-delay')).toBe('1200ms');
        expect(cardNamed('Card C').style.getPropertyValue('--bf-reveal-delay')).toBe('2400ms');
        // The south bar names the batch in the activity row's words.
        expect(screen.getByTestId('canvas-build-verb').textContent).toContain('Added 3 steps');
        // No ghost took off: there is no ribbon to fly from.
        act(() => { vi.advanceTimersByTime(700); });
        expect(document.querySelector('[data-testid="ribbon-flight-ghost"]')).toBeNull();
        expect(container.querySelectorAll('[data-build="fresh"]').length).toBe(3);
    });

    it('with a ribbon on screen every card waits for its ghost: the reveal delay carries the 600 ms flight', () => {
        // A bare root with no stamped commands, and a React Flow spy without
        // `flowToScreenPosition`: the flight has nowhere to depart from and no
        // way to aim, so nothing is thrown, no ghost is drawn — and the card
        // still reveals, flight time included.
        const ribbonRootRef = { current: document.createElement('div') };
        const { rerender } = renderCanvas({ definition: DEF1, structuralEditsBlocked: true, buildCue: cue(), ribbonRootRef });
        rerender({ definition: DEF2, structuralEditsBlocked: true, buildCue: cue(), ribbonRootRef });
        const second = cardNamed('Second card');
        expect(second.getAttribute('data-build')).toBe('fresh');
        expect(second.style.getPropertyValue('--bf-reveal-delay')).toBe('600ms');
        expect(() => { act(() => { vi.advanceTimersByTime(1000); }); }).not.toThrow();
        expect(document.querySelector('[data-testid="ribbon-flight-ghost"]')).toBeNull();
        expect(document.querySelector('.bf-ribbon-pick')).toBeNull();
    });

    it('the build ending clears every flag, takes one closing wide shot, and then nothing moves', () => {
        const { rerender, container } = renderCanvas({ definition: DEF2, structuralEditsBlocked: true, buildCue: cue() });
        rerender({ definition: DEF3, structuralEditsBlocked: true, buildCue: cue() });
        expect(container.querySelectorAll('[data-build]').length).toBeGreaterThan(0);
        act(() => { vi.advanceTimersByTime(100); });
        const before = cameraCalls();

        rerender({ definition: DEF3, structuralEditsBlocked: false, buildCue: cue({ running: false }) });
        // Flags are gone in the SAME commit the lock lifts — no card may keep
        // revealing on a canvas the user can already edit.
        expect(container.querySelectorAll('[data-build]').length).toBe(0);
        // The ending is one wide shot (plan A4: "one wide shot unless the user
        // holds the camera. Nothing moves after done.") …
        expect(rfSpy.fitView).toHaveBeenCalledTimes(1);
        expect(rfSpy.fitView.mock.calls[0][0]).toMatchObject({ padding: 0.12, minZoom: 0.2, maxZoom: 1 });
        expect(cameraCalls()).toBe(before + 1);
        // … and then silence, however long the canvas sits there.
        act(() => { vi.advanceTimersByTime(10_000); });
        expect(cameraCalls()).toBe(before + 1);
        expect(container.querySelectorAll('[data-build]').length).toBe(0);
    });

    it('the ghost slot stands ahead of the frontier while the AI builds, and leaves when the build ends', () => {
        const { rerender } = renderCanvas({ definition: DEF2, structuralEditsBlocked: true, buildCue: cue() });
        expect(screen.getByTestId('ghost-step')).toBeTruthy();
        // Its caption is the narrated thought when there is one.
        rerender({ definition: DEF2, structuralEditsBlocked: true, buildCue: cue({ narration: 'Looking up the invoice fields' }) });
        expect(screen.getByTestId('ghost-step-caption').textContent).toBe('Looking up the invoice fields');

        rerender({ definition: DEF2, structuralEditsBlocked: false, buildCue: cue({ running: false }) });
        expect(screen.queryByTestId('ghost-step')).toBeNull();
    });

    it('a click on the ghost slot is not a click on a step: onNodeClick never hears of it', () => {
        // The ghost's own div is pointer-events-none, but React Flow's node
        // wrapper around it is not, so the click reaches ReactFlow's onNodeClick
        // like any card's — and used to surface "editing is paused" for a card
        // that does not exist.
        const onNodeClick = vi.fn();
        renderCanvas({ definition: DEF2, structuralEditsBlocked: true, buildCue: cue(), onNodeClick });
        const ghostWrapper = screen.getByTestId('ghost-step').closest('.react-flow__node');
        expect(ghostWrapper).toBeTruthy();
        fireEvent.click(ghostWrapper);
        expect(onNodeClick).not.toHaveBeenCalled();
        // The control: the same gesture on a real card does reach it.
        fireEvent.click(screen.getByText('First card').closest('.react-flow__node'));
        expect(onNodeClick).toHaveBeenCalledWith('a');
    });

    it('the ghost steps away when the phase leaves building', () => {
        const { rerender } = renderCanvas({ definition: DEF2, structuralEditsBlocked: true, buildCue: cue() });
        expect(screen.getByTestId('ghost-step')).toBeTruthy();
        rerender({ definition: DEF2, structuralEditsBlocked: true, buildCue: cue({ phase: 'testing' }) });
        expect(screen.queryByTestId('ghost-step')).toBeNull();
    });

    it('a run in flight owns the canvas: the run banner wins and no card is live', () => {
        const { rerender, container } = renderCanvas({ definition: DEF2, structuralEditsBlocked: true, buildCue: cue() });
        rerender({ definition: DEF3, structuralEditsBlocked: true, buildCue: cue() });
        act(() => { vi.advanceTimersByTime(FLAG_TTL_MS + 100); });
        expect(container.querySelectorAll('[data-build="live"]').length).toBe(1);

        rerender({
            definition: DEF3,
            structuralEditsBlocked: true,
            buildCue: cue({ phase: 'testing' }),
            runInFlight: true,
            runSteps: [
                { stepId: 'trg', status: 'success', finishedAt: '2026-09-10T10:00:00Z' },
                { stepId: 'a', status: 'running', startedAt: '2026-09-10T10:00:01Z' },
            ],
        });
        expect(container.querySelectorAll('[data-build]').length).toBe(0);
        expect(container.querySelectorAll('[data-build="live"]').length).toBe(0);
        // The running card keeps the run vocabulary's own status.
        expect(cardNamed('First card').getAttribute('data-status')).toBe('running');
        expect(screen.getByTestId('canvas-run-banner')).toBeTruthy();
        expect(screen.queryByTestId('canvas-build-banner')).toBeNull();
        expect(screen.queryByTestId('ghost-step')).toBeNull();
    });

    it('the south bar carries the build banner where the amber chip was; a refusal reads "Skipped:"', () => {
        const { rerender } = renderCanvas({ definition: DEF2, structuralEditsBlocked: true, buildCue: cue() });
        expect(screen.queryByText(/AI is editing/)).toBeNull();
        const banner = screen.getByTestId('canvas-build-banner');
        expect(banner.textContent).toContain('Building');
        expect(screen.queryByTestId('canvas-hint')).toBeNull();

        // The same shape BuildTab derives: tc.name plus describeToolCall's row.
        const tc = { name: 'builder_add_http_request', arguments: {}, result: { error: 'The HTTP app is not connected for this organisation' } };
        const lastCall = { name: tc.name, ...describeToolCall(tc) };
        rerender({ definition: DEF2, structuralEditsBlocked: true, buildCue: cue({ lastCall }) });
        expect(screen.getByTestId('canvas-build-verb').textContent).toContain('Skipped:');
        expect(screen.getByTestId('canvas-build-verb').textContent).toContain('not connected');
        // Nothing red on the cards for a refused call.
        expect(document.querySelectorAll('[data-status="error"]').length).toBe(0);
    });
});

/**
 * The dry run replayed (flow/useDryRunReplay.js lives in BuildTab; what the
 * pane owns is the camera and the chip). `replayStepId` names the card being
 * revealed; the pane centres on it once, at the current zoom but never under
 * 80%, and leaves the camera alone for null. The React Flow spy's `getNode`
 * is given the card's geometry for the duration — jsdom measures nothing.
 */
const RUN_ROWS = [
    { stepId: 'trg', status: 'success', output: null, startedAt: '2026-09-10T10:00:00Z' },
    { stepId: 'a', status: 'success', output: [1, 2, 3], startedAt: '2026-09-10T10:00:01Z' },
    { stepId: 'b', status: 'error', startedAt: '2026-09-10T10:00:02Z' },
];

describe('DiagramPane — the dry run replayed', () => {
    const nodeAt = { trg: { x: 0, y: ROW_Y }, a: { x: 320, y: ROW_Y }, b: { x: 640, y: ROW_Y } };
    const realGetNode = rfSpy.getNode;
    const realGetZoom = rfSpy.getZoom;
    beforeEach(() => {
        cleanup();
        rfSpy.setCenter.mockClear();
        rfSpy.fitView.mockClear();
        rfSpy.setViewport.mockClear();
        rfSpy.getNode = (id) => (nodeAt[id] ? { id, position: nodeAt[id], measured: { width: 240, height: 72 } } : null);
    });
    afterEach(() => {
        rfSpy.getNode = realGetNode;
        rfSpy.getZoom = realGetZoom;
    });

    it('centres the camera on the card being revealed — once per id, at the current zoom, never for null', () => {
        const { rerender } = renderCanvas({ definition: DEF2, runSteps: RUN_ROWS, replayStepId: null });
        expect(rfSpy.setCenter).not.toHaveBeenCalled();

        rerender({ definition: DEF2, runSteps: RUN_ROWS, replayStepId: 'a' });
        expect(rfSpy.setCenter).toHaveBeenCalledTimes(1);
        const [cx, cy, opts] = rfSpy.setCenter.mock.calls[0];
        expect(cx).toBe(320 + 120);
        expect(cy).toBe(ROW_Y + 36);
        expect(opts).toEqual({ duration: 300, zoom: 1 });

        // The same id again (any re-render mid-frame) is not a second move.
        rerender({ definition: DEF2, runSteps: RUN_ROWS, replayStepId: 'a' });
        expect(rfSpy.setCenter).toHaveBeenCalledTimes(1);

        rerender({ definition: DEF2, runSteps: RUN_ROWS, replayStepId: 'b' });
        expect(rfSpy.setCenter).toHaveBeenCalledTimes(2);
        expect(rfSpy.setCenter.mock.calls[1][0]).toBe(640 + 120);

        // The replay is over: the camera stays where the last move left it.
        rerender({ definition: DEF2, runSteps: RUN_ROWS, replayStepId: null });
        expect(rfSpy.setCenter).toHaveBeenCalledTimes(2);
        // None of it went through the choreography's fits.
        expect(rfSpy.fitView).not.toHaveBeenCalled();
        expect(rfSpy.setViewport).not.toHaveBeenCalled();
    });

    it('zoomed out to 50%, the centring brings the card up to 80% — the level the chip is drawn at', () => {
        rfSpy.getZoom = () => 0.5;
        const { rerender } = renderCanvas({ definition: DEF2, runSteps: RUN_ROWS, replayStepId: null });
        rerender({ definition: DEF2, runSteps: RUN_ROWS, replayStepId: 'a' });
        expect(rfSpy.setCenter.mock.calls[0][2]).toEqual({ duration: 300, zoom: 0.8 });
    });

    it('a card whose node is not on the canvas moves nothing', () => {
        const { rerender } = renderCanvas({ definition: DEF2, runSteps: RUN_ROWS, replayStepId: null });
        rerender({ definition: DEF2, runSteps: RUN_ROWS, replayStepId: 'nowhere' });
        expect(rfSpy.setCenter).not.toHaveBeenCalled();
    });

    it('a settled row puts the result chip at the head of the summary line; a running one does not', () => {
        renderCanvas({
            definition: DEF2,
            runSteps: [RUN_ROWS[0], { ...RUN_ROWS[1], status: 'running' }],
        });
        const first = cardNamed('First card');
        expect(first.getAttribute('data-status')).toBe('running');
        expect(first.querySelector('[data-testid="node-result-chip"]')).toBeNull();

        cleanup();
        renderCanvas({ definition: DEF2, runSteps: RUN_ROWS });
        const settled = cardNamed('First card');
        const chip = settled.querySelector('[data-testid="node-result-chip"]');
        expect(chip).toBeTruthy();
        expect(chip.textContent).toBe('3 items');
        expect(chip.className).toContain('bf-result-chip');
        // The summary line is still there beside it, in the same row.
        expect(chip.parentElement.getAttribute('data-testid')).toBe('node-sub-row');
        expect(chip.parentElement.querySelector('[data-testid="node-sub"]')).toBeTruthy();
        // The failed card says so.
        expect(cardNamed('Second card').querySelector('[data-testid="node-result-chip"]').textContent).toBe('failed');
    });
});
