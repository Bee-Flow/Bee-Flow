/**
 * The shape of one presentation record per node type (see ./index.ts).
 */

/** The nine visual families a step card is painted with (`--type-<family>`). */
export const NODE_FAMILIES = ['trigger', 'ai', 'app', 'branch', 'loop', 'data', 'pause', 'guard', 'end'] as const;
export type NodeFamily = (typeof NODE_FAMILIES)[number];

/**
 * `null` in an issue map = a flat, always-visible field (Label, Prompt) with
 * no section to open.
 */
export const FLAT = null;

/** Validation path → the editor section that holds the offending control. */
export interface IssueSections {
    /** The section an unrecognised field tail opens, so an error is never hidden. */
    fallback: string;
    map: Record<string, string | null>;
}

export interface NodeDef {
    family: NodeFamily | null;
    /** What KIND of node this is (the node editor's heading). */
    typeLabel: string;
    /** The name a freshly dropped node gets. Absent on canvas-only types. */
    defaultLabel?: string;
    /** How the palette invites you to pick it (absent for types you cannot add). */
    label?: string;
    /** The one-line palette description. */
    desc?: string;
    /** "What does this node do?", one or two sentences. */
    help: string;
    /** The accordion sections this type's editor renders. */
    sectionKeys?: string[];
    /** The subset shown in Simple mode; absent → the global advanced rule. */
    simpleSections?: string[];
    issueSections?: IssueSections;
}

/**
 * A record as the family files write it: the palette wording is
 * `labelFallback`, the house name for the English under a key (here
 * `routines.node.<type>.label`), and ./index.ts serves it as `label`.
 */
export type NodeDefSource = Omit<NodeDef, 'label'> & { labelFallback?: string };
