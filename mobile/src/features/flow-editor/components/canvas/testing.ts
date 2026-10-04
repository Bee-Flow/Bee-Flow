/**
 * Test data for the canvas: an automation as long as the canvas is asked to
 * carry — 150 steps, with a Condition every fifteen whose two sides meet
 * again — unplaced (the fallback layout draws it) or placed (the positions
 * that layout gives it, as a saved automation would carry them). Test data
 * only: nothing in the app imports this.
 */

import { PORT, seedPositions, type FlowDefinition, type FlowEdge, type FlowStep } from '@/features/flow-editor/model';

export function bigFlow(n = 150): FlowDefinition {
    const steps: FlowStep[] = [];
    const edges: FlowEdge[] = [];
    let prev = 'trg';
    let prevIsCondition = false;
    for (let i = 0; i < n; i += 1) {
        const id = `s${i}`;
        const isCondition = i % 15 === 7;
        steps.push(isCondition ? { id, type: 'condition', expr: `x > ${i}` } : { id, type: i % 4 === 0 ? 'ai_step' : 'set', label: `Step ${i}` });
        if (prevIsCondition) {
            const side = `side${i}`;
            steps.push({ id: side, type: 'notification' });
            edges.push({ from: prev, to: id, label: PORT.then }, { from: prev, to: side, label: PORT.else }, { from: side, to: id });
        } else {
            edges.push({ from: prev, to: id });
        }
        prev = id;
        prevIsCondition = isCondition;
    }
    return { trigger: { id: 'trg', type: 'trigger', kind: 'manual' }, steps, edges };
}

/** The same automation with a position on every node. */
export function placedBigFlow(n = 150): FlowDefinition {
    return seedPositions(bigFlow(n)) as FlowDefinition;
}
