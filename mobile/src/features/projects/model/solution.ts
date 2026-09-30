/**
 * The builder's view of a project: the Solutions overview row
 * (server/projects/summary.js), the wiring graph (server/projects/graph.js)
 * and the checks (server/projects/completeness.js).
 *
 * The rule every one of these shapes carries: a number or a verdict the server
 * could not read arrives as `null`, and stays `null` here. A `null` that
 * became a 0 or a `true` on the way to the screen would say "none" or "all
 * clear" about a Solution nobody could look at.
 */

import type { ProjectRole } from './types';

/** The checks a summary row carries: the aggregator's verdicts, copied. */
export interface RowCompleteness {
    blocked: boolean;
    complete: boolean;
    findings: number;
    errors: number;
    warnings: number;
}

/** Whether a newer Blueprint exists; `available: null` = could not tell. */
export interface RowUpdate {
    installedVersion: number | null;
    latestVersion: number | null;
    available: boolean | null;
}

export interface SolutionRow {
    id: string;
    name: string;
    description: string;
    icon: string | null;
    permission: ProjectRole;
    installedFromBlueprintId: string | null;
    updatedAt: string | null;
    /** Per membership section: a tally, or null when it could not be counted. */
    counts: Record<string, number | null>;
    /** Today's runs; null when they could not be counted. */
    runs: { today: number | null; failed: number | null } | null;
    completeness: RowCompleteness | null;
    update: RowUpdate | null;
}

export interface SolutionSummary {
    rows: SolutionRow[];
    /** Gaps that hit every card at once — machine keys, see words.ts. */
    unavailable: string[];
    hasMore: boolean;
}

/** One Finding: graph problems and completeness findings share the shape. */
export interface Finding {
    code: string;
    severity: string;
    message: string;
    remediation: string | null;
    /** 'activate' | 'publish' — where on the ladder it blocks. */
    blockedAt: string | null;
    /** A web `/app/...` path to the object to fix, or null. */
    deepLink: string | null;
    targetRef: { kind: string; id: string | null } | null;
    /** The graph node that holds the broken reference (graph problems only). */
    from: string | null;
    targetId: string | null;
}

export interface GraphNode {
    id: string;
    /** automation | app | webpage | datatable | agent | knowledge_base | approval | meeting | form */
    type: string;
    name: string;
    entityId: string | null;
    /** A form node: the routine node it starts. */
    triggers: string | null;
}

export interface GraphEdge {
    from: string;
    to: string | null;
    /** runs | calls | asks | uses | grounds | feeds | triggers */
    kind: string;
    targetId: string | null;
    problem: string | null;
}

export interface GraphExternal {
    kind: string;
    id: string;
    referencedBy: string[];
}

export interface SolutionGraph {
    nodes: GraphNode[];
    edges: GraphEdge[];
    externals: GraphExternal[];
    problems: Finding[];
    unavailable: string[];
    /** true = the whole Solution was read; false = part was not; null = not said. */
    complete: boolean | null;
}

/** GET /:id/completeness — only ever built from an answer that carried `blocked`. */
export interface Completeness {
    blocked: boolean;
    complete: boolean | null;
    findings: Finding[];
    unavailable: string[];
}
