/**
 * Where a node's lines leave and arrive — the handles each web node component
 * draws (StepNodeBase's `sourceHandles`, ConditionNode, GuardNode, SwitchNode,
 * LoopNode, LoopItemNode), with their positions down the card's right edge.
 *
 * Two ports share the card's height at a third and two thirds; three or more
 * sit on their own 22px rows, which is what the card grew for
 * (model/geometry cardHeightForPorts). An open loop keeps both of its ports
 * on its header strip, where the eye expects "done" to leave from.
 *
 * A port's `id` is the web's handle id (what the edge model reports as the
 * line's `sourceHandle`); its `wire` is what a new line from it is wired
 * with — `branchFromHandle`'s input — so a loop's "Done" wires a plain edge.
 */

import { cardHeightForPorts, isTerminalStep, PORT_PAD, PORT_PITCH, type AnyNode } from '@/features/flow-editor/model';
import { branchPorts, type LaneTone, type RowText } from '@/features/flow-editor/model/outline';

import { CONTAINER_HEADER } from './inlineLoops';

export interface PortSpec {
    id: string;
    wire: string | null;
    /** The name printed beside the port; null for a plain one. */
    text: RowText | null;
    tone: LaneTone | null;
    /** From the node's top edge. */
    dy: number;
}

/** A card's one plain way out. */
export const OUT = 'out';

type Unplaced = Omit<PortSpec, 'dy'>;

const LOOP_PORTS: readonly Unplaced[] = [
    { id: 'done', wire: null, text: { key: 'automations.canvas.loop_port_done', fallback: 'Done' }, tone: 'then' },
    { id: 'on_error', wire: 'on_error', text: { key: 'automations.canvas.loop_port_on_error', fallback: 'On error' }, tone: 'error' },
];

function unplacedPorts(node: AnyNode): Unplaced[] {
    if (node.type === 'note' || isTerminalStep(node)) return [];
    if (node.type === 'loop') return [...LOOP_PORTS];
    const named = branchPorts(node);
    if (named.length > 0) return named.map((p) => ({ id: p.handle, wire: p.handle, text: p.text, tone: p.tone }));
    return [{ id: OUT, wire: null, text: null, tone: null }];
}

/** The y of port `i` of `n` on a card `height` tall. */
export function portDy(i: number, n: number, height: number): number {
    return n > 2 ? PORT_PAD + PORT_PITCH * (i + 0.5) : ((i + 1) / (n + 1)) * height;
}

/** A card's height: taller than the standard 72 only for more than two ports. */
export function cardHeightFor(node: AnyNode): number {
    return cardHeightForPorts(unplacedPorts(node).length);
}

/**
 * A node's source ports, placed. `container` is an open loop's box: its two
 * ports ride on the header strip (LoopNode's ExpandedLoop).
 */
export function sourcePorts(node: AnyNode, height: number, container = false): PortSpec[] {
    const ports = unplacedPorts(node);
    if (container) {
        return ports.map((p) => ({ ...p, dy: p.id === 'on_error' ? CONTAINER_HEADER / 2 + 10 : CONTAINER_HEADER / 2 - 8 }));
    }
    return ports.map((p, i) => ({ ...p, dy: portDy(i, ports.length, height) }));
}

/** Where lines arrive, from the node's top; null for a node nothing flows into. */
export function targetDy(kind: 'trigger' | 'step' | 'note' | 'entry' | 'container', height: number): number | null {
    if (kind === 'trigger' || kind === 'note' || kind === 'entry') return null;
    return kind === 'container' ? CONTAINER_HEADER / 2 : height / 2;
}

/** The port a drawn line leaves by: its handle's, else the first (an old case, an unrouted line). */
export function portFor(ports: readonly PortSpec[], sourceHandle: string | null): PortSpec | null {
    const id = sourceHandle ?? OUT;
    return ports.find((p) => p.id === id) ?? ports[0] ?? null;
}
