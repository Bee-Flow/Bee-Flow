import { sameNodeProps, type CanvasNodeProps } from './CanvasNode';
import { moveNode } from './moves';
import { buildScene } from './scene';
import { placedBigFlow } from './testing';

const FRAME = { x: -2048, y: -2048, width: 8192, height: 8192 };

function propsOf(scene: ReturnType<typeof buildScene>, key: string, over: Partial<CanvasNodeProps> = {}): CanvasNodeProps {
    const node = scene.byKey.get(key);
    if (!node) throw new Error(key);
    return { node, card: { name: key, kicker: 'SET · 1' } as never, frame: FRAME, lod: 'card', state: 'idle', ...over };
}

describe('a canvas node redraws only when what it draws changes', () => {
    const def = placedBigFlow(40);
    const before = buildScene(def);
    const after = buildScene(moveNode(def, 's10', { dx: 12, dy: 0 }));

    it('keeps every untouched node across an edit elsewhere', () => {
        for (const n of before.nodes) {
            if (n.key === 's10') continue;
            expect(sameNodeProps(propsOf(before, n.key), propsOf(after, n.key))).toBe(true);
        }
        expect(sameNodeProps(propsOf(before, 's10'), propsOf(after, 's10'))).toBe(false);
    });

    it('redraws for new words, a new zoom level, a new state or a moved frame', () => {
        const base = propsOf(before, 's3');
        expect(sameNodeProps(base, { ...base, card: { name: 'renamed', kicker: 'SET · 1' } as never })).toBe(false);
        expect(sameNodeProps(base, { ...base, lod: 'tile' })).toBe(false);
        expect(sameNodeProps(base, { ...base, state: 'dim' })).toBe(false);
        expect(sameNodeProps(base, { ...base, frame: { ...FRAME, x: 0 } })).toBe(false);
        expect(sameNodeProps(base, { ...base, card: { ...(base.card as object) } as never })).toBe(true);
    });
});
