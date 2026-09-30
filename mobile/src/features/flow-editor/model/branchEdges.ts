/**
 * Edge identity — what makes two definition edges "the same edge". A port of
 * the web builder's flow/branchEdges.js, pinned by branchEdges.lockstep.test.ts.
 *
 * An edge's real identity is `(from, to, label, caseName)`: an If or a Switch
 * can route several branches to the SAME next step, so `(from, to)` alone is
 * ambiguous. Deleting or splicing one branch edge must never take its
 * siblings with it.
 */

import type { EdgeIdentity, FlowEdge } from './types';

/**
 * The output ports the runtime routes on, as the edge labels that name them:
 * a condition's two sides, a switch's catch-all, and the error port.
 */
export const PORT = Object.freeze({
    then: 'then',
    else: 'else',
    onError: 'on_error',
    defaultCase: 'default',
    /** `case:default` — the switch catch-all's label. */
    defaultCaseLabel: 'case:default',
} as const);

/**
 * A port name → the edge branch fields the runtime routes on: `then`/`else`
 * for a condition, `case:<name>` (incl. `case:default`) for a switch,
 * `on_error` for the error port. Any other port → an unlabelled edge.
 */
export function branchFromHandle(sourceHandle: unknown): { label?: string; caseName?: string } {
    if (sourceHandle === PORT.then || sourceHandle === PORT.else || sourceHandle === PORT.onError) return { label: sourceHandle };
    if (typeof sourceHandle === 'string' && sourceHandle.startsWith('case:')) {
        return { label: sourceHandle, caseName: sourceHandle.slice(5) };
    }
    return {};
}

/** Canonical string key for an edge. Two edges with the same key are duplicates. */
export function edgeKey(e: Partial<FlowEdge>): string {
    return `${e.from}->${e.to}|${e.label || ''}|${e.caseName ?? ''}`;
}

/** The branch part of an edge's identity, normalised to nulls. */
export function edgeIdentity(e: EdgeIdentity | null | undefined): { label: string | null; caseName: string | null } {
    return { label: e?.label ?? null, caseName: e?.caseName ?? null };
}

const caseOfLabel = (label: string | null): string | null =>
    label && label.startsWith('case:') ? label.slice(5) : null;

/**
 * Does edge `e` carry the branch identity `identity`? A `case:` identity
 * matches an edge carrying EITHER legacy shape (label-only `case:vip` or
 * caseName-only `vip`); a plain identity matches only an unlabelled edge.
 */
export function matchesEdgeIdentity(e: EdgeIdentity, identity: EdgeIdentity | null | undefined): boolean {
    const want = edgeIdentity(identity || {});
    const have = edgeIdentity(e);
    if (want.caseName != null || (want.label && want.label.startsWith('case:'))) {
        const wantCase = want.caseName ?? caseOfLabel(want.label);
        const haveCase = have.caseName ?? caseOfLabel(have.label);
        return haveCase === wantCase;
    }
    return (have.label || null) === (want.label || null);
}

/**
 * Copy every NON-identity key (a persisted `color`, say) from one edge onto
 * another. Every helper that rebuilds an edge runs its output through this,
 * or the metadata silently dies on a splice, bridge or duplicate.
 */
export function copyExtraEdgeKeys<T extends object>(src: Partial<FlowEdge> | null | undefined, out: T): T {
    if (!src || typeof src !== 'object') return out;
    const target = out as Record<string, unknown>;
    for (const k of Object.keys(src)) {
        if (k !== 'from' && k !== 'to' && k !== 'label' && k !== 'caseName') target[k] = src[k];
    }
    return out;
}

export interface SpliceSpec {
    insertedId: string;
    sourceId: string;
    targetId: string;
    /** The branch identity of the ONE edge being split. */
    identity?: EdgeIdentity | null;
    /** The port the continuation leaves the inserted step by (a brancher must name one). */
    insertedPort?: EdgeIdentity | null;
}

/**
 * Splice a freshly inserted step onto one specific edge:
 * `source --(identity)--> inserted --(insertedPort)--> target`. Only the
 * matched edge is removed; its extra keys ride on the source→inserted half,
 * where the branch decision lives.
 */
export function spliceStepIntoEdge(edges: FlowEdge[] | null | undefined, spec: SpliceSpec): FlowEdge[] {
    const { insertedId, sourceId, targetId, identity = null, insertedPort = null } = spec;
    const list = Array.isArray(edges) ? edges : [];
    const isMatch = (e: FlowEdge) => e.from === sourceId && e.to === targetId && matchesEdgeIdentity(e, identity);
    const replaced = list.find(isMatch) || null;
    const kept = list.filter((e) => !isMatch(e));
    const id = edgeIdentity(identity || {});
    const sourceToNew: FlowEdge = { from: sourceId, to: insertedId };
    if (id.label) sourceToNew.label = id.label;
    if (id.caseName != null) sourceToNew.caseName = id.caseName;
    copyExtraEdgeKeys(replaced, sourceToNew);
    const newToTarget: FlowEdge = { from: insertedId, to: targetId };
    if (insertedPort?.label) newToTarget.label = insertedPort.label;
    if (insertedPort?.caseName != null) newToTarget.caseName = insertedPort.caseName;
    return [...kept, sourceToNew, newToTarget];
}

/** Remove exactly the edges named by `identities` (`[{from, to, label?, caseName?}]`). */
export function removeEdgesByIdentity(
    edges: FlowEdge[] | null | undefined,
    identities: (Partial<FlowEdge> | null | undefined)[] | Partial<FlowEdge> | null | undefined,
): FlowEdge[] {
    const list = Array.isArray(edges) ? edges : [];
    const wanted = (Array.isArray(identities) ? identities : [identities]).filter(
        (w): w is Partial<FlowEdge> => !!w,
    );
    return list.filter((e) => !wanted.some((w) => e.from === w.from && e.to === w.to && matchesEdgeIdentity(e, w)));
}
