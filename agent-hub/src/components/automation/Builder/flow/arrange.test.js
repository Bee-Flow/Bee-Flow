import { describe, it, expect } from 'vitest';
import { arrangeDefinition, DEFAULT_DIMS } from './arrange';
import { DEFAULT_SPACING } from './dagreLayout';
import { ROW_GAP } from './rowBands';
import { seedPositions } from './layout';

// Two nodes stacked inside one rank sit a card height plus one nodesep apart
// (96 + 64); a node on the next row is at least a ROW_GAP (270) further down.
// Anything under this therefore means "same row", not "wrapped".
const ROW_GAP_GUARD = ROW_GAP - 20;

const trigger = (over = {}) => ({ id: 'trg', type: 'trigger', kind: 'manual', ...over });
const step = (id, over = {}) => ({ id, type: 'ai_step', ...over });

/** A straight chain of n steps hanging off the trigger. */
function chain(n, stepOver = {}) {
    const steps = Array.from({ length: n }, (_, i) => step(`s${i}`, stepOver));
    const edges = [{ from: 'trg', to: 's0' }];
    for (let i = 1; i < n; i += 1) edges.push({ from: `s${i - 1}`, to: `s${i}` });
    return { trigger: trigger(), steps, edges };
}

const posOf = (def, id) => [def.trigger, ...(def.steps || [])].find(s => s.id === id)?.position;
const allPositions = (def) => [def.trigger, ...(def.steps || [])].map(s => s.position);
const spread = (def) => {
    const xs = allPositions(def).map(p => p.x);
    return Math.max(...xs) - Math.min(...xs);
};

describe('arrangeDefinition', () => {
    it('overwrites hand-placed positions — that is what the button is for', () => {
        // Every node positioned: seedPositions deliberately does nothing here,
        // which is precisely why Arrange cannot be built on top of it.
        const def = {
            ...chain(3),
            trigger: trigger({ position: { x: 999, y: 999 } }),
        };
        def.steps = def.steps.map(s => ({ ...s, position: { x: 999, y: 999 } }));

        expect(seedPositions(def)).toBe(def);

        const out = arrangeDefinition(def, { mode: 'roomy' });
        expect(out).not.toBe(def);
        for (const p of allPositions(out)) {
            expect(p).not.toEqual({ x: 999, y: 999 });
        }
    });

    it('lays out a graph that has no positions at all', () => {
        const out = arrangeDefinition(chain(3), { mode: 'roomy' });
        for (const p of allPositions(out)) {
            expect(Number.isFinite(p.x)).toBe(true);
            expect(Number.isFinite(p.y)).toBe(true);
        }
    });

    it('compact really is narrower than roomy for the same graph', () => {
        const def = chain(5);
        expect(spread(arrangeDefinition(def, { mode: 'compact' })))
            .toBeLessThan(spread(arrangeDefinition(def, { mode: 'roomy' })));
    });

    it('never packs the cards tighter than the edge badges need', () => {
        // The gap between two cards is not empty: "1 record", the branch name,
        // "otherwise" and the add button all live there. dagreLayout settled on
        // ranksep 120 / nodesep 48 as the point where those stop overlapping
        // the cards, so no mode — least of all "compact" — may go under it.
        const def = {
            trigger: trigger(),
            steps: [step('cond', { type: 'condition' }), step('yes'), step('no')],
            edges: [
                { from: 'trg', to: 'cond' },
                { from: 'cond', to: 'yes', label: 'then' },
                { from: 'cond', to: 'no', label: 'else' },
            ],
        };
        for (const mode of ['compact', 'roomy', 'serpentine']) {
            const out = arrangeDefinition(def, { mode, viewportWidth: 1600, viewportHeight: 800 });
            const horizontal = posOf(out, 'cond').x - posOf(out, 'trg').x - DEFAULT_DIMS.width;
            const vertical = Math.abs(posOf(out, 'yes').y - posOf(out, 'no').y) - DEFAULT_DIMS.height;
            expect(horizontal, `${mode} rank gap`).toBeGreaterThanOrEqual(DEFAULT_SPACING.ranksep);
            expect(vertical, `${mode} sibling gap`).toBeGreaterThanOrEqual(48);
        }
    });

    it('keeps the flow left-to-right in the non-wrapping modes', () => {
        const out = arrangeDefinition(chain(4), { mode: 'compact' });
        const xs = ['trg', 's0', 's1', 's2', 's3'].map(id => posOf(out, id).x);
        for (let i = 1; i < xs.length; i += 1) expect(xs[i]).toBeGreaterThan(xs[i - 1]);
    });

    describe('serpentine', () => {
        // 10 cards at 240px + 96px gap will not fit in 900px; it has to wrap.
        const narrow = { mode: 'serpentine', viewportWidth: 900 };

        it('wraps a long chain onto more than one row', () => {
            const out = arrangeDefinition(chain(9), narrow);
            const ys = new Set(allPositions(out).map(p => Math.round(p.y)));
            expect(ys.size).toBeGreaterThan(1);
        });

        it('reads every row left to right, like text', () => {
            // Ploughing the second row backwards gives shorter connectors, and
            // it puts step 10 to the left of step 6. On a numbered routine that
            // is unreadable, so each row carriage-returns instead.
            const out = arrangeDefinition(chain(9), narrow);
            const nodes = [trigger(), ...out.steps].map(s => ({
                id: s.id,
                ...posOf(out, s.id),
            }));
            const rows = new Map();
            for (const n of nodes) {
                const key = Math.round(n.y);
                if (!rows.has(key)) rows.set(key, []);
                rows.get(key).push(n);
            }
            const ordered = [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
            expect(ordered.length).toBeGreaterThan(1);

            // Flow order runs rightward inside EVERY row, and every row starts
            // back at the same left-hand column.
            const flowIndex = (id) => (id === 'trg' ? -1 : Number(id.slice(1)));
            const byFlow = (arr) => [...arr].sort((a, b) => flowIndex(a.id) - flowIndex(b.id)).map(n => n.x);
            for (const row of ordered) {
                const xs = byFlow(row);
                for (let i = 1; i < xs.length; i += 1) expect(xs[i]).toBeGreaterThan(xs[i - 1]);
            }
            const leftEdges = ordered.map(row => Math.min(...row.map(n => n.x)));
            expect(new Set(leftEdges).size).toBe(1);
        });

        it('shapes the result to the viewport rather than counting cards', () => {
            // fitView rescales whatever we produce, so what decides whether the
            // flow fills the screen is the bounding box's SHAPE. A wide, short
            // viewport should therefore yield wider rows than a tall, narrow
            // one — for the very same graph.
            const def = chain(11);
            const boxOf = (out) => {
                const ps = allPositions(out);
                return {
                    w: Math.max(...ps.map(p => p.x)) - Math.min(...ps.map(p => p.x)),
                    h: Math.max(...ps.map(p => p.y)) - Math.min(...ps.map(p => p.y)),
                };
            };
            const wide = boxOf(arrangeDefinition(def, { mode: 'serpentine', viewportWidth: 2000, viewportHeight: 500 }));
            const tall = boxOf(arrangeDefinition(def, { mode: 'serpentine', viewportWidth: 600, viewportHeight: 1400 }));
            expect(wide.w).toBeGreaterThan(tall.w);
            expect(wide.h).toBeLessThan(tall.h);
        });

        it('does not wrap when everything already fits', () => {
            const out = arrangeDefinition(chain(2), { mode: 'serpentine', viewportWidth: 4000 });
            const ys = new Set(allPositions(out).map(p => Math.round(p.y)));
            expect(ys.size).toBe(1);
        });

        it('keeps a condition and its two arms on the same row', () => {
            // The arms share a rank; cutting between the condition and them
            // would strand one branch on the row below.
            const def = {
                trigger: trigger(),
                steps: [
                    step('a'), step('b'), step('c'),
                    step('cond', { type: 'condition' }),
                    step('yes'), step('no'),
                    step('tail'),
                ],
                edges: [
                    { from: 'trg', to: 'a' }, { from: 'a', to: 'b' }, { from: 'b', to: 'c' },
                    { from: 'c', to: 'cond' },
                    { from: 'cond', to: 'yes', label: 'then' },
                    { from: 'cond', to: 'no', label: 'else' },
                    { from: 'yes', to: 'tail' }, { from: 'no', to: 'tail' },
                ],
            };
            const out = arrangeDefinition(def, { mode: 'serpentine', viewportWidth: 1200 });
            // The arms share a rank, and rows are cut on rank boundaries, so
            // they wrap together: same row, same column, stacked.
            expect(posOf(out, 'yes').x).toBe(posOf(out, 'no').x);
            expect(Math.abs(posOf(out, 'yes').y - posOf(out, 'no').y)).toBeLessThan(ROW_GAP_GUARD);
        });
    });

    describe('flowlets', () => {
        const withLayer = () => ({
            ...chain(2),
            steps: [step('s0'), step('call', { type: 'call_layer', layerKey: 'L1' })],
            edges: [{ from: 'trg', to: 's0' }, { from: 's0', to: 'call' }],
            layers: {
                L1: {
                    trigger: { id: 'lt', type: 'trigger', kind: 'layer_input', position: { x: 500, y: 500 } },
                    steps: [step('i0', { position: { x: 500, y: 500 } }), step('i1', { position: { x: 500, y: 500 } })],
                    edges: [{ from: 'lt', to: 'i0' }, { from: 'i0', to: 'i1' }],
                },
            },
        });

        it('tidies the inside of every flowlet in roomy mode', () => {
            const out = arrangeDefinition(withLayer(), { mode: 'roomy' });
            const inner = out.layers.L1;
            const xs = [inner.trigger, ...inner.steps].map(s => s.position.x);
            expect(new Set(xs).size).toBeGreaterThan(1);
        });

        it('leaves flowlet interiors alone in compact mode', () => {
            const out = arrangeDefinition(withLayer(), { mode: 'compact' });
            expect(out.layers.L1.steps[0].position).toEqual({ x: 500, y: 500 });
        });

        it('honours an explicit includeLayers override', () => {
            const out = arrangeDefinition(withLayer(), { mode: 'compact', includeLayers: true });
            expect(out.layers.L1.steps[0].position).not.toEqual({ x: 500, y: 500 });
        });
    });

    it('never touches inline (expanded-flowlet) nodes', () => {
        // Inline copies carry coordinates in their own flowlet's space; mixing
        // them into the parent layout is the bug inlineFlowlets.js exists to
        // avoid.
        const def = {
            trigger: trigger(),
            steps: [step('s0'), step('call/inner', { position: { x: 7, y: 7 } })],
            edges: [{ from: 'trg', to: 's0' }],
        };
        const out = arrangeDefinition(def, { mode: 'compact' });
        expect(posOf(out, 'call/inner')).toEqual({ x: 7, y: 7 });
    });

    it('returns the definition untouched when there is no trigger yet', () => {
        const def = { steps: [], edges: [] };
        expect(arrangeDefinition(def, { mode: 'compact' })).toBe(def);
    });

    it('falls back to a known mode when handed nonsense', () => {
        const out = arrangeDefinition(chain(2), { mode: 'diagonal' });
        for (const p of allPositions(out)) expect(Number.isFinite(p.x)).toBe(true);
    });

    it('uses the card size it is given', () => {
        const wide = arrangeDefinition(chain(3), { mode: 'compact', dims: { width: 600, height: DEFAULT_DIMS.height } });
        const normal = arrangeDefinition(chain(3), { mode: 'compact' });
        expect(spread(wide)).toBeGreaterThan(spread(normal));
    });

    // BFSF-411 — a note carries no edges, so dagre has nothing to rank it
    // against; Arrange must leave it exactly where the author put it rather
    // than dropping it wherever a disconnected node happens to land.
    it('never touches a note\'s position — free-floating, not laid out', () => {
        const def = {
            ...chain(3),
            steps: [...chain(3).steps, { id: 'note_1', type: 'note', text: 'x', position: { x: 12345, y: -678 } }],
        };
        const out = arrangeDefinition(def, { mode: 'roomy' });
        expect(posOf(out, 'note_1')).toEqual({ x: 12345, y: -678 });
        // The real chain still got laid out — the exclusion is note-specific,
        // not a side effect that broke Arrange for everything else.
        expect(posOf(out, 's0')).not.toEqual({ x: 999, y: 999 });
        expect(Number.isFinite(posOf(out, 's0').x)).toBe(true);
    });

    it('a note with NO stored position yet is left unpositioned by Arrange too', () => {
        // Nothing to preserve, so nothing is asserted about where it ends up —
        // only that Arrange does not crash and does not invent wiring for it.
        const def = { ...chain(2), steps: [...chain(2).steps, { id: 'note_1', type: 'note', text: 'x' }] };
        const out = arrangeDefinition(def, { mode: 'roomy' });
        expect(out.edges.some(e => e.from === 'note_1' || e.to === 'note_1')).toBe(false);
    });
});
