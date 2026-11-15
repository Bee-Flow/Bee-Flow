/**
 * A Windmill module list as Bee Flow steps and edges (PLAN B3 mapModules.mts):
 * one mapper per module type (modules/*.mts), the options around each one
 * (mapOptions.mts), and the sequence that wires them together. `identity`
 * disappears; notes and groups become `note` steps (convert.mts).
 */

import type { WmNode } from './ir.mts';
import type { MapCtx, Port } from './context.mts';
import { placeholder, reportModule } from './emit.mts';
import { mapWithOptions } from './mapOptions.mts';
import { mapScript } from './modules/script.mts';
import { mapBranchAll, mapBranchOne, mapForLoop, mapSubflow, mapWhileLoop } from './modules/control.mts';
import { mapAiAgent, mapAiDecision } from './modules/ai.mts';

export function mapSequence(ctx: MapCtx, nodes: WmNode[], ports: Port[]): Port[] {
    let open = ports;
    for (const node of nodes) open = mapWithOptions(ctx, node, open, mapCore);
    return open;
}

function mapCore(ctx: MapCtx, node: WmNode, ports: Port[]): Port[] {
    switch (node.kind) {
        case 'identity':
            reportModule(ctx, node, ['dropped', 'high', 'A pass-through step has nothing to do in Bee Flow.', []]);
            return ports;
        case 'script': case 'rawscript': return mapScript(ctx, node, ports);
        case 'flow': return mapSubflow(ctx, node, ports, mapSequence);
        case 'forloopflow': return mapForLoop(ctx, node, ports, mapSequence);
        case 'whileloopflow': return mapWhileLoop(ctx, node, ports);
        case 'branchone': return mapBranchOne(ctx, node, ports, mapSequence);
        case 'branchall': return mapBranchAll(ctx, node, ports, mapSequence);
        case 'aiagent': return mapAiAgent(ctx, node, ports);
        case 'aidecision': return mapAiDecision(ctx, node, ports);
        default:
            return placeholder(ctx, node, `The Windmill step type "${node.rawType ?? 'unknown'}" is not known to the converter.`, ports, { status: 'unsupported' });
    }
}
