import { describe, it, expect } from 'vitest';
import { buildLayout, seedPositions } from './layout';
import { DEFAULT_COLUMNS } from './arrange';
import { ROW_GAP } from './rowBands';

/**
 * Rows by default (builder redesign, artboard 1a).
 *
 * A routine with no saved positions is laid out in rows of DEFAULT_COLUMNS,
 * the connection from the end of one row to the start of the next is flagged
 * as a wrap (drawn dashed, with a "→ row 2 · step n" chip), and a routine
 * that already carries positions is left exactly as it is.
 */
const trigger = () => ({ id: 'trg', type: 'trigger', kind: 'manual' });
const step = (id) => ({ id, type: 'set' });

function chain(n) {
    const steps = Array.from({ length: n }, (_, i) => step(`s${i}`));
    const edges = [{ from: 'trg', to: 's0' }];
    for (let i = 1; i < n; i += 1) edges.push({ from: `s${i - 1}`, to: `s${i}` });
    return { trigger: trigger(), steps, edges };
}

const posOf = (nodes, id) => nodes.find(n => n.id === id)?.position;

describe('buildLayout — rows by default', () => {
    it('folds a chain longer than one row onto a second row', () => {
        // trigger + 8 steps = 9 ranks → two rows at five per row.
        const { nodes, edges } = buildLayout(chain(8), { runByStep: null, issuesByStep: null });
        const ys = new Set(nodes.map(n => Math.round(n.position.y)));
        expect(ys.size).toBeGreaterThanOrEqual(2);
        // The sixth rank starts the second row, back at the left edge.
        const lastOnRow1 = posOf(nodes, `s${DEFAULT_COLUMNS - 2}`);
        const firstOnRow2 = posOf(nodes, `s${DEFAULT_COLUMNS - 1}`);
        expect(firstOnRow2.x).toBeLessThan(lastOnRow1.x);
        expect(firstOnRow2.y - lastOnRow1.y).toBeGreaterThanOrEqual(ROW_GAP);

        // Exactly one wrap edge, and it is the one that folds.
        const wraps = edges.filter(e => e.data?.wrap);
        expect(wraps.length).toBe(1);
        expect(wraps[0].source).toBe(`s${DEFAULT_COLUMNS - 2}`);
        expect(wraps[0].target).toBe(`s${DEFAULT_COLUMNS - 1}`);
        expect(wraps[0].data.wrap).toEqual({ fromRow: 1, toRow: 2 });
    });

    it('flags no wrap on a chain that fits one row', () => {
        const { nodes, edges } = buildLayout(chain(3), { runByStep: null, issuesByStep: null });
        expect(new Set(nodes.map(n => Math.round(n.position.y))).size).toBe(1);
        expect(edges.some(e => e.data?.wrap)).toBe(false);
    });

    it('leaves a routine with saved positions exactly where it was', () => {
        const def = chain(8);
        const all = [def.trigger, ...def.steps];
        all.forEach((s, i) => { s.position = { x: i * 300, y: 40 }; });
        const { nodes, edges } = buildLayout(def, { runByStep: null, issuesByStep: null });
        for (const s of all) expect(posOf(nodes, s.id)).toEqual(s.position);
        expect(edges.some(e => e.data?.wrap)).toBe(false);
    });
});

describe('seedPositions — a routine grows into rows', () => {
    it('places a new step where the wrapped layout of the whole graph puts it', () => {
        // Build the routine step by step, seeding after every add, the way
        // the canvas does. The sixth step must land on row two.
        let def = seedPositions(chain(0));
        for (let i = 0; i < 8; i += 1) {
            def = {
                ...def,
                steps: [...def.steps, step(`s${i}`)],
                edges: [...def.edges, { from: i === 0 ? 'trg' : `s${i - 1}`, to: `s${i}` }],
            };
            def = seedPositions(def);
        }
        const p = (id) => [def.trigger, ...def.steps].find(s => s.id === id).position;
        expect(p('s3').y).toBe(p('trg').y);
        expect(p('s4').y - p('trg').y).toBeGreaterThanOrEqual(ROW_GAP);
        expect(p('s4').x).toBe(p('trg').x);
    });

    it('never overwrites a position that is already there', () => {
        const def = chain(2);
        def.steps[0].position = { x: 999, y: 999 };
        const out = seedPositions(def);
        expect(out.steps[0].position).toEqual({ x: 999, y: 999 });
        expect(out.trigger.position).toBeTruthy();
        expect(out.steps[1].position).toBeTruthy();
    });
});
