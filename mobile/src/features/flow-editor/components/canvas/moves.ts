/**
 * Where things go when you move them: a dragged node's new place, and the
 * Arrange menu (the web's ArrangeMenu over flow/arrange.js). Both are pure
 * edits, so each is one undo step through the draft store.
 *
 * A drag writes the node's STORED position (what it was, plus how far it
 * moved — never the pushed-aside display position an open loop gives its
 * neighbours). On a canvas that was drawn from the fallback layout, the drag
 * also writes every other node's drawn position, so nothing jumps when the
 * definition stops being "unplaced" — the web's commitNodePositions followed
 * by seedPositions, without the jump.
 */

import { arrangeDefinition, type AnyNode, type ArrangeMode, type FlowDefinition, type Position } from '@/features/flow-editor/model';

import { topPositions } from './scene';
import type { Size } from './viewport';

export interface Delta {
    dx: number;
    dy: number;
}

/** The definition with node `id` moved by `delta` (world units); the same one when nothing moved. */
export function moveNode(def: FlowDefinition, id: string, delta: Delta): FlowDefinition {
    const { positions, seeded } = topPositions(def);
    const from = positions.get(id);
    if (!from || (delta.dx === 0 && delta.dy === 0)) return def;
    const to: Position = { x: Math.round(from.x + delta.dx), y: Math.round(from.y + delta.dy) };
    const place = <N extends AnyNode>(n: N): N => {
        if (n.id === id) return { ...n, position: to };
        const drawn = seeded && n.type !== 'note' ? positions.get(n.id) : undefined;
        return drawn ? { ...n, position: drawn } : n;
    };
    return {
        ...def,
        ...(def.trigger ? { trigger: place(def.trigger) } : {}),
        ...(Array.isArray(def.triggers) ? { triggers: def.triggers.map(place) } : {}),
        steps: def.steps.map(place),
    };
}

export interface ArrangeChoice {
    mode: ArrangeMode;
    key: string;
    fallback: string;
}

/** The Arrange menu, in the web's order: rows that fit this screen, one tight line, roomy. */
export const ARRANGE_CHOICES: readonly ArrangeChoice[] = [
    { mode: 'serpentine', key: 'routines.canvas.arrange_rows', fallback: 'Rows that fit the screen' },
    { mode: 'compact', key: 'routines.canvas.arrange_compact', fallback: 'One tight line' },
    { mode: 'roomy', key: 'mobile.flow.canvas.arrange_roomy', fallback: 'Roomy' },
];

/** Re-lay-out every node (and, for 'roomy', every flowlet's inside) for a screen of `size`. */
export function arrangeFlow(def: FlowDefinition, mode: ArrangeMode, size: Size): FlowDefinition {
    return arrangeDefinition(def, { mode, viewportWidth: size.width, viewportHeight: size.height });
}
