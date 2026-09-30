import type { FlowDefinition } from '@/features/flow-editor/model';
import { clone, switchy } from '@/features/flow-editor/model/testing/fixtures';

import { ARRANGE_CHOICES, arrangeFlow, moveNode } from './moves';
import { buildScene } from './scene';
import { bigFlow } from './testing';

describe('moving a node', () => {
    it('writes its stored position plus the move, and nothing else, on a placed routine', () => {
        const def = clone(switchy);
        const next = moveNode(def, 'g', { dx: 10.4, dy: -20.6 });
        const was = def.steps.find((s) => s.id === 'g')?.position;
        expect(next.steps.find((s) => s.id === 'g')?.position).toEqual({ x: (was?.x ?? 0) + 10, y: (was?.y ?? 0) - 21 });
        for (const s of def.steps.filter((x) => x.id !== 'g')) expect(next.steps.find((x) => x.id === s.id)).toBe(s);
        expect(next.trigger).toBe(def.trigger);
    });

    it('pins every drawn position on a routine the fallback layout drew, so nothing jumps', () => {
        const def = bigFlow(20);
        const drawn = buildScene(def);
        const next = moveNode(def, 's3', { dx: 50, dy: 0 });
        const after = buildScene(next);
        expect(after.seeded).toBe(false);
        for (const n of drawn.nodes) {
            const x = n.key === 's3' ? n.x + 50 : n.x;
            expect(after.byKey.get(n.key)).toMatchObject({ x, y: n.y });
        }
    });

    it('moves a trigger and a secondary trigger too, and ignores a no-op or an unknown node', () => {
        const def: FlowDefinition = {
            trigger: { id: 't', type: 'trigger', position: { x: 0, y: 0 } },
            triggers: [{ id: 'h', type: 'trigger', kind: 'webhook', position: { x: 0, y: 200 } }],
            steps: [{ id: 'a', type: 'set', position: { x: 300, y: 0 } }],
            edges: [],
        };
        expect(moveNode(def, 't', { dx: 5, dy: 5 }).trigger?.position).toEqual({ x: 5, y: 5 });
        expect(moveNode(def, 'h', { dx: 0, dy: 10 }).triggers?.[0]?.position).toEqual({ x: 0, y: 210 });
        expect(moveNode(def, 'a', { dx: 0, dy: 0 })).toBe(def);
        expect(moveNode(def, 'nope', { dx: 3, dy: 3 })).toBe(def);
    });
});

describe('arranging', () => {
    it('offers the web modes in its order', () => {
        expect(ARRANGE_CHOICES.map((c) => c.mode)).toEqual(['serpentine', 'compact', 'roomy']);
    });

    it('re-lays every node out, rows fitting a phone', () => {
        const def = bigFlow(12);
        const rows = buildScene(arrangeFlow(def, 'serpentine', { width: 390, height: 700 }));
        const line = buildScene(arrangeFlow(def, 'compact', { width: 390, height: 700 }));
        const widthOf = (s: ReturnType<typeof buildScene>) => s.bounds?.width ?? 0;
        expect(rows.seeded).toBe(false);
        expect(widthOf(rows)).toBeLessThan(widthOf(line));
    });
});
