/**
 * App Studio runtime: the pure part of the wizard (AppWizard.tsx, schema 3).
 */

/** A child definition as the wizard reads it. */
export interface StepDef {
    id?: string;
    props?: { name?: unknown } & Record<string, unknown>;
    children?: StepDef[];
}

/** Depth-first: is `id` this definition or one below it? */
function holds(def: StepDef | undefined, id: string): boolean {
    if (!def) return false;
    if (def.id === id) return true;
    return (def.children ?? []).some((child) => holds(child, id));
}

/** The step whose body holds the node selected on the canvas, or -1. */
export function stepHolding(steps: readonly StepDef[], selectedNodeId: string | null | undefined): number {
    if (!selectedNodeId) return -1;
    return steps.findIndex((def) => holds(def, selectedNodeId));
}

/** The field names inside one step's body: what Next asks the form to check. */
export function stepFieldNames(def: StepDef | undefined): string[] {
    const out: string[] = [];
    const visit = (n: StepDef | undefined) => {
        if (!n || typeof n !== 'object') return;
        if (typeof n.props?.name === 'string' && n.props.name) out.push(n.props.name);
        for (const child of n.children ?? []) visit(child);
    };
    visit(def);
    return out;
}
