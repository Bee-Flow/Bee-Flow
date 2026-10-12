/**
 * Where a finding's step lives, so its row can open it: the step's address in
 * its graph (a loop or branch child as `container/child`, the step editor's
 * address) and the flowlet that graph is, if any.
 *
 * The web's resolveOwningStepId (model/issues.ts, pinned to the web) matches a
 * TOP-LEVEL id inside the path, so a finding about a step in a flowlet, in a
 * loop body or on a second trigger named no step: its row said "This automation"
 * and could not be tapped. This follows the paths the server writes
 * (server/automation/validate/graph.js stepIdFromPath): a top-level step by
 * index or id (`steps[3]`, `steps[<id>]`), a nested one by id
 * (`steps[3].body.steps[<id>]`, `….branches[0].steps[<id>]`), a trigger by id
 * (`triggers[<id>]`), and a flowlet's records under `layers.<key>.`. The
 * deepest addressed node wins, as on the server.
 */

import type { DefinitionInput, FlowDefinition } from '@/features/flow-editor/model';

export interface IssueLocation {
    /** The step editor's address: an id, or `container/child` for a held step. */
    address: string;
    /** The flowlet (definition.layers key) the step is in; null in the automation itself. */
    flowlet: string | null;
}

const NODE_SEG = /^(trigger|triggers|steps)(?:\[(.+)\])?$/;
const LAYER_PATH = /^layers\.([a-z][a-z0-9_]*)\.(.*)$/;

/** A list's node by id, or by index when the token is a number. */
function byToken(list: unknown, tok: string): string | null {
    if (!Array.isArray(list)) return null;
    const nodes = list as { id?: unknown }[];
    if (nodes.some((n) => n?.id === tok)) return tok;
    if (!/^\d+$/.test(tok)) return null;
    const at = nodes[Number(tok)];
    return typeof at?.id === 'string' && at.id ? at.id : null;
}

/** The chain of ids down to the addressed node, empty when the path names none. */
function chainIn(graph: FlowDefinition, path: string): string[] {
    let chain: string[] = [];
    let topLevel = true;
    for (const part of path.split('.')) {
        const m = NODE_SEG.exec(part);
        if (!m) continue;
        const [, seg, tok] = m;
        if (seg === 'trigger') {
            if (!tok && typeof graph.trigger?.id === 'string') chain = [graph.trigger.id];
        } else if (seg === 'triggers') {
            const id = tok ? byToken(graph.triggers, tok) : null;
            if (id) chain = [id];
        } else if (tok && tok !== '?') {
            // The first `steps[…]` is the top-level list; below it, children by id.
            const id = topLevel ? byToken(graph.steps, tok) : tok;
            if (id) chain = topLevel ? [id] : [...chain, id];
            topLevel = false;
        }
    }
    return chain;
}

export function locateIssue(record: { path?: unknown } | null | undefined, def: DefinitionInput): IssueLocation | null {
    // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- LAYER_PATH is anchored at ^, its [a-z0-9_]* cannot match the \. that follows it and (.*)$ is its one trailing quantifier, so it runs in linear time
    const path = record?.path;
    if (typeof path !== 'string' || !path || !def) return null;
    const layer = LAYER_PATH.exec(path);
    const flowlet = layer ? (layer[1] as string) : null;
    const graph = flowlet ? (def as FlowDefinition).layers?.[flowlet] : (def as FlowDefinition);
    if (!graph) return null;
    const chain = chainIn(graph, layer ? (layer[2] as string) : path);
    return chain.length ? { address: chain.join('/'), flowlet } : null;
}
