import { createRequire } from 'node:module';
import { stepsOf } from '../core/cowork/plan/planWalk.mts';
import type { Definition } from '../core/cowork/plan/planTypes.mts';

const require = createRequire(import.meta.url);
const { applyRemoveStep, findDanglingRefs } = require('../automation/builderTools/stepEditing/removeStep') as {
    applyRemoveStep(graph: Definition, args: {stepId: string}): {removed?: string};
    findDanglingRefs(graph: Definition, id: string): string[];
};

/** Use Studio's graph edit on a copy. Only consult the planner if surviving inputs need rewiring. */
export async function removePlanSteps(original: Definition, ids: string[], repair: () => Promise<Definition>): Promise<Definition> {
    const graph = structuredClone(original);
    const selected = new Set(ids);
    const before = stepsOf(original);
    const targets = before.filter(step => selected.has(step.id));
    if (!targets.length || targets.length !== selected.size) throw new Error('The selected steps have changed');
    for (const {id} of targets.reverse()) {
        if (applyRemoveStep(graph, {stepId: id}).removed !== id) throw new Error('Could not remove the requested step');
    }
    const remaining = new Set(stepsOf(graph).map(step => step.id));
    const removed = before.filter(step => !remaining.has(step.id));
    if (!removed.some(({id}) => findDanglingRefs(graph, id).length)) return graph;
    const repaired = await repair();
    const after = stepsOf(repaired);
    if (after.length !== remaining.size || new Set(after.map(step => step.id)).size !== remaining.size || after.some(({id}) => !remaining.has(id))
        || removed.some(({id}) => findDanglingRefs(repaired, id).length)) {
        throw new Error('The surviving steps still need inputs from the removed steps');
    }
    return repaired;
}
