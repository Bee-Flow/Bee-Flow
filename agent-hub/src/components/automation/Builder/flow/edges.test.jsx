import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { STATUS_COLORS } from '../../../../constants/palette';

/**
 * The custom edge's own logic: identity colour on the stroke, tinted case
 * chips, the hover palette, and the parallel-lane fan-out.
 *
 * ReactFlow's primitives are mocked: real edges only mount after node
 * measurement, which never happens in jsdom, and EdgeLabelRenderer portals
 * into a canvas element a bare provider doesn't create. The mock keeps the
 * exact prop contract (BaseEdge gets the merged style; getSmoothStepPath gets
 * the fanned-out coordinates) so what's asserted is OUR component, not the
 * vendor's plumbing.
 */
const viewport = { zoom: 1 };
// Identity screen→flow mapping, so a test can point at a flow coordinate by
// passing it as clientX/clientY and read the result straight off the transform.
const reactFlow = { screenToFlowPosition: ({ x, y }) => ({ x, y }) };
vi.mock('@xyflow/react', () => ({
    // className and pathLength are forwarded because the real BaseEdge spreads
    // them onto its <path> — the build choreography's draw-in rides on both.
    BaseEdge: ({ id, path, style, className, pathLength }) => (
        <path data-testid="base-edge" data-id={id} d={path} style={style} className={className} pathLength={pathLength} />
    ),
    EdgeLabelRenderer: ({ children }) => <div data-testid="label-layer">{children}</div>,
    useViewport: () => viewport,
    useReactFlow: () => reactFlow,
    getSmoothStepPath: ({ sourceX, sourceY, targetX, targetY }) => [
        `M${sourceX},${sourceY} L${targetX},${targetY}`,
        (sourceX + targetX) / 2,
        (sourceY + targetY) / 2,
    ],
}));

const { LabelledEdge } = await import('./edges');
const { EdgeCrossingProvider } = await import('./EdgeCrossingContext');

const BASE = {
    id: 'a->b||', source: 'a', target: 'b',
    sourceX: 0, sourceY: 0, targetX: 200, targetY: 0,
    sourcePosition: 'right', targetPosition: 'left',
};

// DiagramPane hands every editable edge all three action callbacks, and each
// button is only drawn when its own handler is there — an edge inside an
// expanded loop is DERIVED from the body's order, so it gets "+" but no delete
// and no colour. Tests that want a control withheld pass it explicitly as null.
const EDIT_HANDLERS = { onInsert: () => {}, onDelete: () => {}, onSetColor: () => {} };

function renderEdge(props = {}) {
    const data = props.data?.editable ? { ...EDIT_HANDLERS, ...props.data } : props.data;
    const { container } = render(<svg><LabelledEdge {...BASE} {...props} data={data} /></svg>);
    return container;
}

describe('LabelledEdge', () => {
    beforeEach(cleanup);

    it('the caller style merges over the base stroke', () => {
        renderEdge({ style: { stroke: STATUS_COLORS.red } });
        const path = screen.getByTestId('base-edge');
        expect(path.style.stroke).toBe('rgb(239, 68, 68)');
        expect(path.style.strokeWidth).toBe('1.5'); // base width kept
    });

    it('keeps the neutral base look without a style override', () => {
        renderEdge();
        expect(screen.getByTestId('base-edge').style.stroke).toBe('var(--border-default)');
    });

    it('a case chip tints to the identity colour; semantic chips keep their tone', () => {
        renderEdge({ data: { kind: 'pdf', chipColor: STATUS_COLORS.red } });
        const chip = screen.getByText('pdf');
        expect(chip.style.color).toBe('rgb(239, 68, 68)');
        cleanup();
        renderEdge({ data: { kind: 'then', chipColor: STATUS_COLORS.red } });
        const thenChip = screen.getByText('match');
        expect(thenChip.style.color).toBe('');
        expect(thenChip.getAttribute('class')).toMatch(/emerald/);
    });

    it('the hover palette offers eight swatches + auto, and reports the row identity', () => {
        const onSetColor = vi.fn();
        const container = renderEdge({
            data: { kind: 'pdf', editable: true, defLabel: 'case:pdf', defCaseName: 'pdf', defColor: null, onSetColor },
        });
        // Reveal the hover controls, then open the swatches.
        fireEvent.mouseEnter(container.querySelector('path[stroke="transparent"]'));
        fireEvent.click(screen.getByLabelText('Colour this connection'));
        expect(screen.getAllByLabelText(/Colour this connection \w+/).length).toBe(8);
        fireEvent.click(screen.getByLabelText('Colour this connection red'));
        expect(onSetColor).toHaveBeenCalledWith({
            source: 'a', target: 'b', sourceHandle: null, label: 'case:pdf', caseName: 'pdf', color: 'red',
        });
    });

    it('the auto dot clears the colour (null)', () => {
        const onSetColor = vi.fn();
        const container = renderEdge({
            data: { editable: true, defColor: 'red', defLabel: null, defCaseName: null, onSetColor },
        });
        fireEvent.mouseEnter(container.querySelector('path[stroke="transparent"]'));
        fireEvent.click(screen.getByLabelText('Colour this connection'));
        fireEvent.click(screen.getByLabelText('Automatic colour'));
        expect(onSetColor).toHaveBeenCalledWith(expect.objectContaining({ color: null }));
    });

    it('read-only edges offer no palette at all', () => {
        renderEdge({ data: { kind: 'pdf' } });
        expect(screen.queryByLabelText('Colour this connection')).toBeNull();
    });

    it('parallel lanes shift the target Y so the paths separate, and stagger the chips', () => {
        // `closest`, not `parentElement`: the chip is wrapped in its opaque
        // ground, and this is asking about the CLUSTER's placement.
        const clusterOf = (text) => screen.getByText(text).closest('[data-edge-cluster]');
        renderEdge({ data: { kind: 'pdf', parallelIndex: 0, parallelCount: 2 } });
        const d1 = screen.getByTestId('base-edge').getAttribute('d');
        const t1 = clusterOf('pdf').style.transform;
        cleanup();
        renderEdge({ data: { kind: 'word', parallelIndex: 1, parallelCount: 2 } });
        const d2 = screen.getByTestId('base-edge').getAttribute('d');
        const t2 = clusterOf('word').style.transform;
        expect(d1).not.toBe(d2);
        expect(t1).not.toBe(t2);
        cleanup();
        // A lone edge keeps the exact unshifted path.
        renderEdge({ data: {} });
        expect(screen.getByTestId('base-edge').getAttribute('d')).toBe('M0,0 L200,0');
    });

    it('never renders a banned colour family', () => {
        const container = renderEdge({ data: { kind: 'pdf', chipColor: STATUS_COLORS.cyan, editable: true } });
        expect(/purple|violet|indigo|fuchsia/i.test(container.innerHTML)).toBe(false);
    });

    it('hover controls counter-scale against the canvas zoom (never billboard-sized)', () => {
        viewport.zoom = 2;
        const container = renderEdge({ data: { editable: true } });
        fireEvent.mouseEnter(container.querySelector('path[stroke="transparent"]'));
        const controls = screen.getByTitle('Insert a step here').parentElement;
        expect(controls.style.transform).toContain('scale(0.5)'); // exact inverse of 2× zoom
        viewport.zoom = 1;
    });
});

/**
 * BFSF-331 — the hover target and the cluster. Every one of these was a
 * distinct way the actions were unreachable.
 */
describe('LabelledEdge — reaching the connection controls', () => {
    beforeEach(() => { cleanup(); viewport.zoom = 1; });
    afterEach(() => { viewport.zoom = 1; });

    const band = (container) => container.querySelector('path[stroke="transparent"]');
    const bandWidth = (container) => Number(band(container).getAttribute('stroke-width'));

    it('the hit band is measured in SCREEN pixels, so zooming out widens it', () => {
        // A fixed flow-unit width shrank to 12 screen px at 0.5× zoom — and
        // fitView routinely lands below 1×.
        viewport.zoom = 1;
        const at1 = bandWidth(renderEdge({ data: { editable: true } }));
        cleanup();
        viewport.zoom = 0.5;
        const atHalf = bandWidth(renderEdge({ data: { editable: true } }));
        expect(atHalf).toBeGreaterThan(at1);
        cleanup();
        // …but never beyond a sane cap, or the whole canvas becomes one edge.
        viewport.zoom = 0.05;
        expect(bandWidth(renderEdge({ data: { editable: true } }))).toBeLessThanOrEqual(96);
        cleanup();
        viewport.zoom = 4;
        expect(bandWidth(renderEdge({ data: { editable: true } }))).toBeGreaterThanOrEqual(16);
    });

    it('parallel lanes never get overlapping hit bands', () => {
        // The lanes are LANE_PITCH apart; a band wider than that would mean two
        // neighbours fight over the same pixels and the wrong edge wins.
        viewport.zoom = 0.3;
        const container = renderEdge({ data: { editable: true, parallelIndex: 0, parallelCount: 3 } });
        const d1 = screen.getByTestId('base-edge').getAttribute('d');
        expect(bandWidth(container)).toBeLessThan(26);
        cleanup();
        const c2 = renderEdge({ data: { editable: true, parallelIndex: 1, parallelCount: 3 } });
        expect(screen.getByTestId('base-edge').getAttribute('d')).not.toBe(d1);
        expect(bandWidth(c2)).toBeLessThan(26);
    });

    // BASE runs from (0,0) to (200,0), so the midpoint is (100,0).
    const cluster = (container) => container.querySelector('[data-edge-cluster]');
    const anchorOf = (container) => {
        const m = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)\s*scale/.exec(cluster(container).style.transform);
        return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
    };
    // Where the cluster rests on BASE: the line's own midpoint. It sits ON the
    // line by design — pushing it clear was tried and put the labels on the
    // cards, because the only direction that clears a riser is sideways into a
    // 120px gap that the source node's port chips are already in.
    const REST = { x: 100, y: 0 };

    /**
     * A label the line runs through cannot be read, and a switch has as many of
     * them as it has branches. The chip is OPAQUE rather than moved: edges are
     * painted before this layer, so a solid background hides the line under the
     * text — which is why the white "1 record" chip never had the problem while
     * the branch chips, tinted at 15% alpha, always did.
     */
    describe('the label hides the line rather than dodging it', () => {
        // The label layer lives inside an <svg> in this harness, so elements
        // there are SVG-namespaced and `.className` is an SVGAnimatedString.
        // The attribute is the string either way.
        const classOf = (el) => el.getAttribute('class') || '';

        it('rests on the midpoint — the spot that fits between two cards', () => {
            const container = renderEdge({ data: { kind: 'then' } });
            expect(anchorOf(container)).toEqual(REST);
        });

        it('lays an opaque ground behind the tint', () => {
            renderEdge({ data: { kind: 'then' } });
            const chip = screen.getByText('match');
            expect(classOf(chip)).toContain('bg-emerald-500/15'); // the tint
            // The ground is a wrapper, not this span and not a ::before: one
            // background-color cannot sit under another, and a negative-z-index
            // pseudo-element paints ABOVE its host's background, so it would
            // cover the tint rather than back it.
            expect(classOf(chip.parentElement)).toContain('bg-[var(--bg-primary)]');
        });

        it('paints above the cards, so a label it overlaps is still readable', () => {
            // The label layer has no z-index of its own and is painted before
            // the nodes, so a chip that lands on a card vanished behind it.
            const container = renderEdge({ data: { kind: 'then' } });
            expect(Number(cluster(container).style.zIndex)).toBeGreaterThan(1000);
        });
    });

    /**
     * Every brancher node prints its branch names at its own ports. Printing
     * them again on the line gave each branch two labels a few pixels apart —
     * `match` at the port and `MATCH` on the wire — which is most of what made
     * a switch with three outputs look broken.
     */
    describe('the chip stands down where the port already says it', () => {
        it('draws no branch chip when the source node labels the port', () => {
            renderEdge({ data: { kind: 'then', labelledAtPort: true } });
            expect(screen.queryByText('match')).toBeNull();
        });

        it('still shows the run data on that same edge', () => {
            // Only the duplicated NAME goes; the record count is the edge's own.
            renderEdge({ data: { kind: 'then', labelledAtPort: true, dataSummary: { label: '17 records' } } });
            expect(screen.getByText('17 records')).toBeTruthy();
        });

        it('keeps the chip where the port is silent', () => {
            // `on error` out of an ordinary step, and `never runs`, have no
            // port chip behind them — dropping theirs would lose the label.
            renderEdge({ data: { kind: 'on_error' } });
            expect(screen.getByText('on error')).toBeTruthy();
            cleanup();
            renderEdge({ data: { kind: 'unrouted' } });
            expect(screen.getByText('never runs')).toBeTruthy();
        });

        it('mounts no empty cluster on a read-only edge with nothing left to say', () => {
            const container = renderEdge({ data: { kind: 'then', labelledAtPort: true } });
            expect(cluster(container)).toBeNull();
        });

        it('still mounts the cluster on an editable one — the controls live there', () => {
            const container = renderEdge({ data: { kind: 'then', labelledAtPort: true, editable: true } });
            expect(cluster(container)).not.toBeNull();
        });
    });

    it('the controls come to where you pointed, not to the middle of the line', () => {
        // The reachability half of the report: on a long connection the
        // midpoint is nowhere near the cursor, so the buttons "appeared
        // somewhere else".
        const container = renderEdge({ data: { editable: true } });
        expect(anchorOf(container)).toEqual(REST);
        fireEvent.mouseEnter(band(container), { clientX: 20, clientY: 0 });
        expect(anchorOf(container)).toEqual({ x: 20, y: 0 });
    });

    it('but a hover near the middle leaves the cluster where a label belongs', () => {
        const container = renderEdge({ data: { editable: true } });
        fireEvent.mouseEnter(band(container), { clientX: 120, clientY: 0 });
        expect(anchorOf(container)).toEqual(REST);
    });

    it('the cluster stays put once anchored — it is not a moving target', () => {
        const container = renderEdge({ data: { editable: true } });
        fireEvent.mouseEnter(band(container), { clientX: 20, clientY: 0 });
        fireEvent.mouseMove(band(container), { clientX: 180, clientY: 0 });
        expect(anchorOf(container)).toEqual({ x: 20, y: 0 });
    });

    it('returns to the midpoint once the cluster closes', async () => {
        vi.useFakeTimers();
        try {
            const container = renderEdge({ data: { editable: true } });
            fireEvent.mouseEnter(band(container), { clientX: 20, clientY: 0 });
            expect(anchorOf(container)).toEqual({ x: 20, y: 0 });
            fireEvent.mouseLeave(band(container));
            await act(async () => { vi.advanceTimersByTime(400); });
            expect(anchorOf(container)).toEqual(REST);
        } finally {
            vi.useRealTimers();
        }
    });

    it('the hit band follows the line as DRAWN, hops and all', () => {
        // The band used to trace the undecorated geometry, so where this line
        // bridged over another it sat beside the line you can see.
        const container = render(
            <EdgeCrossingProvider>
                <svg>
                    <LabelledEdge {...BASE} id="a" data={{ editable: true }} />
                    <LabelledEdge {...BASE} id="b" sourceX={100} sourceY={-50} targetX={100} targetY={50}
                        sourcePosition="bottom" targetPosition="top" data={{ editable: true }} />
                </svg>
            </EdgeCrossingProvider>,
        ).container;
        const drawn = [...container.querySelectorAll('[data-testid="base-edge"]')].map(p => p.getAttribute('d'));
        const bands = [...container.querySelectorAll('path[stroke="transparent"]')].map(p => p.getAttribute('d'));
        expect(bands).toEqual(drawn);
    });

    it('a read-only edge carrying run data is still hoverable', () => {
        // On a run replay the badge IS the point of the edge; gating the band
        // on `editable` left it with nothing to hover at all.
        const container = renderEdge({ data: { dataSummary: { label: '201 records' } } });
        expect(band(container)).toBeTruthy();
        expect(screen.getByText('201 records')).toBeTruthy();
    });

    it('a chip on an edge out of named ports starts past the port pill, on the port\'s own line (C4)', () => {
        // The cluster is chip + controls, so a CENTRED cluster put the chip on
        // the port names; out of a named port it starts PORT_PILL_CLEAR past the
        // handle, at the source's height, and grows rightwards.
        const ported = { ...BASE, targetX: 300, targetY: 40 };
        const { container } = render(<svg><LabelledEdge {...ported} data={{ fromPortLabels: true, dataSummary: { count: 4, label: '4 records' } }} /></svg>);
        const cluster = container.querySelector('[data-edge-cluster]');
        expect(cluster.style.transform).toContain('translate(0, -50%) translate(26px, 0px)');
        expect(cluster.style.transformOrigin).toBe('left center');
        expect(screen.getByText('4 records')).toBeTruthy();
        cleanup();
        const plain = render(<svg><LabelledEdge {...BASE} targetX={120} data={{ dataSummary: { label: '4 records' } }} /></svg>).container;
        expect(plain.querySelector('[data-edge-cluster]').style.transform).toContain('translate(-50%, -50%) translate(60px, 0px)');
    });

    it('in a gap too narrow for the whole chip it shows the count; the label is its name and returns on hover', async () => {
        const narrow = { ...BASE, targetX: 60 };
        const { container } = render(<svg><LabelledEdge {...narrow} data={{ fromPortLabels: true, dataSummary: { count: 4, label: '4 records' } }} /></svg>);
        const chip = screen.getByRole('button', { name: '4 records' });
        expect(chip.textContent).toBe('4');
        expect(chip.getAttribute('data-compact')).toBe('true');
        // Its squeezed cluster lets clicks through to the card next to it.
        expect(container.querySelector('[data-edge-cluster]').style.pointerEvents).toBe('none');
        await userEvent.hover(band(container));
        expect(screen.getByRole('button', { name: /4 records/ }).textContent).toBe('4 records');
    });

    it('a read-only edge with nothing to show gets no hit band', () => {
        expect(band(renderEdge({ data: { kind: 'then' } }))).toBeNull();
    });

    it('the branch chip opens the cluster when the line itself is a hairline', () => {
        // Zoomed out, a parallel lane's band is only a few screen px — but a
        // parallel edge is always a branch edge, so it always has a chip, and
        // hovering that reaches the same controls.
        viewport.zoom = 0.3;
        const container = renderEdge({
            data: { kind: 'then', editable: true, parallelIndex: 0, parallelCount: 3 },
        });
        fireEvent.mouseEnter(cluster(container));
        const insert = screen.getByTitle('Insert a step here');
        expect(insert.style.opacity).toBe('1');
    });

    it('the data badge and the actions are visible AT THE SAME TIME', () => {
        // They used to be mutually exclusive: hovering unmounted the badge.
        const container = renderEdge({
            data: { kind: 'pdf', editable: true, dataSummary: { label: '12 records' } },
        });
        fireEvent.mouseEnter(band(container));
        expect(screen.getByText('12 records')).toBeTruthy();
        expect(screen.getByText('pdf')).toBeTruthy();
        expect(screen.getByTitle('Remove this connection').style.opacity).toBe('1');
    });

    it('hidden actions are inert; "+" stays as the resting hint', () => {
        const container = renderEdge({ data: { editable: true } });
        const remove = screen.getByTitle('Remove this connection');
        expect(remove.style.opacity).toBe('0');
        expect(remove.style.pointerEvents).toBe('none');
        // "+" is dimmed but live — the only signal a connection is editable.
        const plus = screen.getByTitle('Insert a step here');
        expect(plus.style.opacity).toBe('0.35');
        expect(plus.style.pointerEvents).not.toBe('none');
        fireEvent.mouseEnter(band(container));
        expect(screen.getByTitle('Remove this connection').style.pointerEvents).toBe('all');
    });

    it('the controls survive the trip from the line to a button', async () => {
        // The buttons hang off the midpoint, so the pointer must leave the
        // line to reach them. Without the grace period that mouseleave took
        // them away mid-reach.
        vi.useFakeTimers();
        try {
            const container = renderEdge({ data: { editable: true } });
            fireEvent.mouseEnter(band(container));
            fireEvent.mouseLeave(band(container));
            // Still up: the close is only scheduled.
            expect(screen.getByTitle('Remove this connection').style.opacity).toBe('1');
            act(() => { vi.advanceTimersByTime(100); });
            fireEvent.mouseEnter(screen.getByTitle('Insert a step here').parentElement);
            act(() => { vi.advanceTimersByTime(400); });
            expect(screen.getByTitle('Remove this connection').style.opacity).toBe('1');
        } finally {
            vi.useRealTimers();
        }
    });

    it('offers only "+" on a derived line, and still inserts', () => {
        // A line inside an expanded loop is drawn FROM the body's order
        // (flow/inlineFlowlets.js), so DiagramPane withholds delete and colour:
        // there is nothing there to remove or recolour, and the next render
        // would draw it straight back. Inserting a step IS an order change, so
        // "+" stays.
        const onInsert = vi.fn();
        const container = renderEdge({ data: { editable: true, onInsert, onDelete: null, onSetColor: null } });
        fireEvent.mouseEnter(band(container));
        expect(screen.queryByTitle('Remove this connection')).toBeNull();
        expect(screen.queryByTitle('Colour this connection')).toBeNull();
        fireEvent.click(screen.getByTitle('Insert a step here'));
        expect(onInsert).toHaveBeenCalledTimes(1);
    });

    it('leaving for good does close it', () => {
        vi.useFakeTimers();
        try {
            const container = renderEdge({ data: { editable: true } });
            fireEvent.mouseEnter(band(container));
            fireEvent.mouseLeave(band(container));
            act(() => { vi.advanceTimersByTime(400); });
            expect(screen.getByTitle('Remove this connection').style.opacity).toBe('0');
        } finally {
            vi.useRealTimers();
        }
    });

    it('an open colour picker survives a mouseleave', () => {
        vi.useFakeTimers();
        try {
            const container = renderEdge({ data: { editable: true, onSetColor: vi.fn() } });
            fireEvent.mouseEnter(band(container));
            fireEvent.click(screen.getByLabelText('Colour this connection'));
            fireEvent.mouseLeave(band(container));
            act(() => { vi.advanceTimersByTime(500); });
            expect(screen.getByLabelText('Automatic colour')).toBeTruthy();
        } finally {
            vi.useRealTimers();
        }
    });

    it('clicking the line latches the controls open until you dismiss them', () => {
        vi.useFakeTimers();
        try {
            const container = renderEdge({ data: { editable: true } });
            fireEvent.click(band(container));
            fireEvent.mouseLeave(band(container));
            act(() => { vi.advanceTimersByTime(500); });
            expect(screen.getByTitle('Remove this connection').style.opacity).toBe('1');

            fireEvent.mouseDown(document.body);
            expect(screen.getByTitle('Remove this connection').style.opacity).toBe('0');
        } finally {
            vi.useRealTimers();
        }
    });

    it('Escape releases a latched cluster', () => {
        const container = renderEdge({ data: { editable: true } });
        fireEvent.click(band(container));
        expect(screen.getByTitle('Remove this connection').style.opacity).toBe('1');
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(screen.getByTitle('Remove this connection').style.opacity).toBe('0');
    });

    it('a read-only edge with only a label chip does not swallow pointer events', () => {
        renderEdge({ data: { kind: 'pdf' } });
        // `closest`: the chip sits inside its opaque ground, and it is the
        // CLUSTER that decides whether the label is inert.
        expect(screen.getByText('pdf').closest('[data-edge-cluster]').style.pointerEvents).toBe('none');
    });
});

/**
 * Build choreography (flow/useRenderedGraph.js stamps `data.buildFx` on a
 * connection the AI just added). The line draws in from its source: the
 * <path> needs pathLength=1 so the dash unit is "the whole path" and the class
 * the stylesheet animates, plus the delay of the card it leads to.
 */
describe('LabelledEdge — a fresh connection draws in', () => {
    beforeEach(cleanup);

    it('with data.buildFx the base path carries pathLength="1", bf-edge-draw and the delay', () => {
        renderEdge({ data: { buildFx: { delayMs: 400 } } });
        const path = screen.getByTestId('base-edge');
        expect(path.getAttribute('pathLength')).toBe('1');
        expect(path.getAttribute('class')).toBe('bf-edge-draw');
        expect(path.style.getPropertyValue('--bf-reveal-delay')).toBe('400ms');
        // The base look is untouched underneath.
        expect(path.style.stroke).toBe('var(--border-default)');
    });

    it('a missing delay reads as 0ms — the delay is a <time>, never a bare number', () => {
        renderEdge({ data: { buildFx: {} } });
        expect(screen.getByTestId('base-edge').style.getPropertyValue('--bf-reveal-delay')).toBe('0ms');
    });

    it('without it, none of that is written', () => {
        renderEdge({ data: { kind: 'then' } });
        const path = screen.getByTestId('base-edge');
        expect(path.hasAttribute('pathLength')).toBe(false);
        expect(path.getAttribute('class')).toBeNull();
        expect(path.style.getPropertyValue('--bf-reveal-delay')).toBe('');
    });

    it('a wrap edge draws in too, keeping its own dash for afterwards', () => {
        renderEdge({ data: { wrap: { toRow: 2 }, buildFx: { delayMs: 0 } } });
        const path = screen.getByTestId('base-edge');
        expect(path.getAttribute('pathLength')).toBe('1');
        expect(path.style.strokeDasharray).toBe('6 5');
    });
});

describe('LabelledEdge — crossing another line', () => {
    beforeEach(cleanup);

    const drawn = (container) => container.querySelector('[data-testid="base-edge"]').getAttribute('d');

    it('bridges over an edge that crosses it', async () => {
        const { container } = render(
            <EdgeCrossingProvider>
                <svg>
                    {/* Horizontal, and a vertical straight through it. */}
                    <LabelledEdge {...BASE} id="h" sourceX={0} sourceY={50} targetX={200} targetY={50} />
                    <LabelledEdge {...BASE} id="v" sourceX={100} sourceY={0} targetX={100} targetY={100} />
                </svg>
            </EdgeCrossingProvider>,
        );
        // The first pass has nobody to hop over; each edge publishes, and the
        // bridge appears on the pass after.
        await waitFor(() => expect(container.querySelectorAll('[data-testid="base-edge"]')[0].getAttribute('d')).toContain('A'));

        const [horizontal, vertical] = container.querySelectorAll('[data-testid="base-edge"]');
        // Exactly ONE of them bridges. If both did, the two arcs would meet at
        // the crossing and read as a knot.
        expect(horizontal.getAttribute('d')).toContain('A6,6 0 0 0');
        expect(vertical.getAttribute('d')).not.toContain('A');
    });

    it('leaves a lone edge exactly as React Flow drew it', () => {
        const { container } = render(
            <EdgeCrossingProvider><svg><LabelledEdge {...BASE} /></svg></EdgeCrossingProvider>,
        );
        expect(drawn(container)).toBe('M0,0 L200,0');
    });

    it('draws normally with no provider at all — a hop is decoration, not a dependency', () => {
        const container = renderEdge();
        expect(drawn(container)).toBe('M0,0 L200,0');
    });

    it('SETTLES — it does not re-render itself forever', async () => {
        // The first version of this wired the publish/retract API and the
        // "something moved" counter into one context value. Every bump handed
        // each edge a new dependency, so its effect tore down (retract → bump)
        // and re-ran (publish → bump), which started the next round. Under a
        // drag it hid in the churn; on mouse-up the canvas locked solid.
        let renders = 0;
        function Counting(props) {
            renders += 1;
            return <LabelledEdge {...props} />;
        }
        const { container } = render(
            <EdgeCrossingProvider>
                <svg>
                    <Counting {...BASE} id="h" sourceX={0} sourceY={50} targetX={200} targetY={50} />
                    <Counting {...BASE} id="v" sourceX={100} sourceY={0} targetX={100} targetY={100} />
                </svg>
            </EdgeCrossingProvider>,
        );
        await waitFor(() => expect(drawn(container)).toContain('A'));

        const settled = renders;
        // Give the loop every chance to start again.
        for (let i = 0; i < 8; i += 1) await act(async () => { await Promise.resolve(); });
        expect(renders).toBe(settled);
    });

    it('stops hopping over an edge that was removed', async () => {
        const two = (
            <EdgeCrossingProvider>
                <svg>
                    <LabelledEdge {...BASE} id="h" sourceX={0} sourceY={50} targetX={200} targetY={50} />
                    <LabelledEdge {...BASE} id="v" sourceX={100} sourceY={0} targetX={100} targetY={100} />
                </svg>
            </EdgeCrossingProvider>
        );
        const { container, rerender } = render(two);
        await waitFor(() => expect(drawn(container)).toContain('A'));

        rerender(
            <EdgeCrossingProvider>
                <svg><LabelledEdge {...BASE} id="h" sourceX={0} sourceY={50} targetX={200} targetY={50} /></svg>
            </EdgeCrossingProvider>,
        );
        await waitFor(() => expect(drawn(container)).toBe('M0,50 L200,50'));
    });
});
