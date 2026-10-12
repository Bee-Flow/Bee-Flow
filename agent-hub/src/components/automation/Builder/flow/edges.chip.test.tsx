import { describe, expect, it } from 'vitest';
import { chipAnchorX, chipPlacement, compactChipText, FULL_CHIP_MIN_GAP, PORT_LABEL_ROOM, PORT_PILL_CLEAR, TARGET_ROOM } from './edgeChip';
import { buildLayout } from './layout';

/**
 * C4: the data chip ("4 records") of an edge leaving a node with named ports
 * (a Condition's Match / Otherwise, a split's pdf / word / Otherwise) sits at
 * clamp(labelX, sourceX + 88, targetX - 40), so it never covers the port
 * names; every other edge keeps its chip at the midpoint.
 */
describe('chipAnchorX', () => {
    it('leaves an ordinary edge at its midpoint', () => {
        expect(chipAnchorX(60, 0, 120, false)).toBe(60);
    });

    it('pushes a chip that would sit on the port names clear of them', () => {
        expect(PORT_LABEL_ROOM).toBe(88);
        expect(TARGET_ROOM).toBe(40);
        expect(chipAnchorX(60, 0, 200, true)).toBe(88);
    });

    it('keeps a midpoint that is already clear', () => {
        expect(chipAnchorX(150, 0, 300, true)).toBe(150);
    });

    it('never pushes the chip onto the target', () => {
        expect(chipAnchorX(60, 0, 110, true)).toBe(70);
    });
});

describe('chipPlacement', () => {
    const geo = { labelX: 100, labelY: 30, sourceX: 0, sourceY: 10, targetX: 200 };

    it('an ordinary edge: centred at the midpoint', () => {
        expect(chipPlacement(geo, false)).toEqual({ x: 100, y: 30, align: 'center', compact: false });
    });

    it('out of a named port: starts past the pill, on the port\'s line', () => {
        expect(chipPlacement(geo, true)).toEqual({ x: PORT_PILL_CLEAR, y: 10, align: 'start', compact: false });
    });

    it('the canvas\'s usual 60-unit gap is too narrow for the whole chip', () => {
        expect(chipPlacement({ ...geo, targetX: 59 }, true).compact).toBe(true);
        expect(chipPlacement({ ...geo, targetX: FULL_CHIP_MIN_GAP }, true).compact).toBe(false);
        // Zoomed out the chip is bigger in flow units, so it goes compact sooner.
        expect(chipPlacement({ ...geo, targetX: FULL_CHIP_MIN_GAP }, true, 1.5).compact).toBe(true);
    });
});

describe('compactChipText', () => {
    it('the count alone, the label when there is no count', () => {
        expect(compactChipText({ count: 4, label: '4 records' })).toBe('4');
        expect(compactChipText({ label: 'text' })).toBe('text');
        expect(compactChipText(null)).toBe('');
    });
});

const layoutOf = (def: Record<string, unknown>) => buildLayout(def, { runByStep: new Map(), issuesByStep: new Map() });
type LaidEdge = { source: string; target: string; data?: Record<string, unknown> };
const edgeTo = (def: Record<string, unknown>, to: string) => (layoutOf(def).edges as LaidEdge[]).find((e) => e.target === to);

describe('layout marks the edges whose source prints port names', () => {
    const trigger = { id: 'trg', type: 'trigger', kind: 'manual' };
    const tail = (id: string) => ({ id, type: 'set' });

    it('condition and switch edges carry fromPortLabels', () => {
        const def = {
            trigger,
            steps: [
                { id: 'c', type: 'condition', expr: 'true' }, tail('yes'),
                { id: 'sw', type: 'switch', arrayRef: 'steps.c.output.items', cases: [{ name: 'pdf', expr: 'equals(fileType(item), "pdf")' }] }, tail('pdf'),
            ],
            edges: [
                { from: 'trg', to: 'c' },
                { from: 'c', to: 'sw', label: 'then' },
                { from: 'c', to: 'yes', label: 'else' },
                { from: 'sw', to: 'pdf', label: 'case:pdf' },
            ],
        };
        expect(edgeTo(def, 'yes')?.data?.fromPortLabels).toBe(true);
        expect(edgeTo(def, 'pdf')?.data?.fromPortLabels).toBe(true);
    });

    it('a filter (one unnamed output) and a plain step do not', () => {
        const def = {
            trigger,
            steps: [{ id: 'f', type: 'filter', arrayRef: 'trigger.output.items', expr: 'true' }, tail('next')],
            edges: [{ from: 'trg', to: 'f' }, { from: 'f', to: 'next' }],
        };
        expect(edgeTo(def, 'f')?.data?.fromPortLabels).toBeUndefined();
        expect(edgeTo(def, 'next')?.data?.fromPortLabels).toBeUndefined();
    });
});
