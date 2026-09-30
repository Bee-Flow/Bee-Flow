/**
 * Card geometry, shared by the canvas and the layout so the two cannot
 * disagree about how big a card is — the numbers from the web builder's
 * flow/nodeTypeColors.js and flow/aiToolNodes.js, pinned by
 * layout.lockstep.test.ts.
 */

import { toolStateOf } from './aiTools';
import { routePorts } from './route/routeModel';
import type { AnyNode } from './types';

/** A step card: 240×72; the layout box is 240×96 (room for the tool port). */
export const CARD_W = 240;
export const CARD_H = 72;

/** A card with more than two output ports grows one row per port. */
export const PORT_PITCH = 22;
export const PORT_PAD = 10;

/** How much taller an AI step with tools is, for layout only. */
export const TOOL_ROW_EXTRA_H = 76;

export function cardHeightForPorts(portCount: unknown): number {
    const n = Number(portCount) || 0;
    if (n <= 2) return CARD_H;
    return Math.max(CARD_H, n * PORT_PITCH + 2 * PORT_PAD);
}

/**
 * Per-node layout heights for the nodes taller than the standard box: an AI
 * step whose tool row needs room underneath, and a branch card with more than
 * two ports. Empty for a graph with neither.
 */
export function toolLayoutHeights(steps: readonly (AnyNode | null | undefined)[] | null | undefined, baseHeight: number): Map<string, number> {
    const m = new Map<string, number>();
    for (const s of steps || []) {
        if (!s) continue;
        if (s.type === 'ai_step') {
            const state = toolStateOf(s);
            if (state.mode === 'none' || (state.mode === 'explicit' && state.tools.length === 0)) continue;
            m.set(s.id, baseHeight + TOOL_ROW_EXTRA_H);
            continue;
        }
        if (s.type === 'condition' || s.type === 'switch') {
            const cardH = cardHeightForPorts(routePorts(s).length);
            if (cardH > CARD_H) m.set(s.id, cardH + Math.max(0, baseHeight - CARD_H));
        }
    }
    return m;
}
