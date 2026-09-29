import { flowOrder, stepNumbers } from '../flowOrder';
import { isInlineId, parseInlineId } from '../inlineFlowlets';
import { defaultTriggerLabel } from '../triggerLabels';
import { nodeTypeLabel } from '../nodeDefs';

/**
 * Where a ribbon click lands: "Adds after [step n · label]" (design 5a).
 *
 * The step open in the drawer is the author's selection. Without one, a click
 * appends after the last step the flow runs, which is what "add a step" means
 * when nobody said where.
 */

interface NodeLike {
    id?: string;
    type?: string;
    kind?: string;
    label?: string;
    [key: string]: unknown;
}

interface EdgeLike {
    from?: string;
    to?: string;
    label?: unknown;
    caseName?: unknown;
    sourceHandle?: unknown;
}

interface DefinitionLike {
    trigger?: NodeLike | null;
    triggers?: NodeLike[];
    steps?: NodeLike[];
    edges?: EdgeLike[];
}

// flowOrder.stepNumbers, typed: its `= null` defaults read as `null` from TypeScript.
const numberSteps = stepNumbers as unknown as (
    definition: DefinitionLike,
    helpers: { isInlineId: (id: string) => boolean; parseInlineId: (id: string) => unknown },
) => Map<string, number | string>;

export interface RibbonAnchor {
    id: string;
    number: number | string | null;
    label: string;
    /** The node itself, for the Suggested tab's output-shape reading. */
    step: NodeLike;
    /** True when the author picked it (the open step), false for the default. */
    explicit: boolean;
}

function nameOf(node: NodeLike): string {
    if (typeof node.label === 'string' && node.label.trim()) return node.label.trim();
    if (node.type === 'trigger') return defaultTriggerLabel(node.kind || 'manual') as string;
    return (nodeTypeLabel(node.type) as string) || node.type || '';
}

export function ribbonAnchor(definition: DefinitionLike | null | undefined, selectedId: string | null = null): RibbonAnchor | null {
    if (!definition?.trigger) return null;
    const nodes = [definition.trigger, ...(definition.triggers || []), ...(definition.steps || [])].filter((n): n is NodeLike => !!n && !!n.id);
    const byId = new Map(nodes.map(n => [n.id as string, n]));
    const numbers = numberSteps(definition, { isInlineId, parseInlineId });
    const make = (node: NodeLike, explicit: boolean): RibbonAnchor => ({
        id: node.id as string,
        number: numbers.get(node.id as string) ?? null,
        label: nameOf(node),
        step: node,
        explicit,
    });

    const picked = selectedId ? byId.get(selectedId) : null;
    if (picked && picked.type !== 'note') return make(picked, true);

    const order = (flowOrder(definition) as string[]).filter((id) => {
        const n = byId.get(id);
        return n && n.type !== 'note' && !isInlineId(id);
    });
    const last = order.length ? byId.get(order[order.length - 1]) : null;
    return last ? make(last, false) : null;
}

/**
 * The insert options for a ribbon add after `anchor`: spliced into its one
 * plain outgoing connection (so "after step 2" really sits between 2 and 3),
 * otherwise wired from it as a new branch end.
 */
export function addOptionsFor(
    definition: DefinitionLike | null | undefined,
    anchor: RibbonAnchor | null,
): { sourceId?: string; targetId?: string } {
    if (!anchor) return {};
    const out = (definition?.edges || []).filter(e => e?.from === anchor.id);
    if (out.length === 1 && out[0].to && !out[0].label && !out[0].caseName && !out[0].sourceHandle) {
        return { sourceId: anchor.id, targetId: out[0].to };
    }
    return { sourceId: anchor.id };
}
