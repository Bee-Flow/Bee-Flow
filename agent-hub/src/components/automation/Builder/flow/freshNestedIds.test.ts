// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { withFreshNestedIds } from './freshNestedIds';
import { applyDuplicateNode } from './nodeOps';
import type { FlowDefinition, FlowStep } from './types';

const loopDef = (): FlowDefinition => ({
    trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
    steps: [
        { id: 'list', type: 'integration_action', tool: 'gmail.search' },
        {
            id: 'loop_1', type: 'loop', overRef: 'steps.list.output.items', itemVar: 'item',
            body: [
                { id: 'ai_a', type: 'ai_step', prompt: 'Summarise {{loop.item.subject}} for {{steps.list.output.owner}}' },
                { id: 'act_b', type: 'integration_action', tool: 'slack.post', inputs: { text: { kind: 'ref', path: 'steps.ai_a.output.text' } } },
                {
                    id: 'loop_in', type: 'loop', overRef: 'steps.ai_a.output.lines',
                    body: [{ id: 'act_c', type: 'integration_action', inputs: { v: { kind: 'expr', value: 'upper(steps.act_b.output.ts)' } } }],
                },
            ],
        },
    ],
    edges: [{ from: 'trg', to: 'list' }, { from: 'list', to: 'loop_1' }],
});

/** Every step id of a definition, nested ones included, with repeats. */
function allIds(def: FlowDefinition): string[] {
    const out: string[] = [];
    const walk = (steps: unknown) => {
        for (const s of (Array.isArray(steps) ? steps : []) as FlowStep[]) {
            out.push(s.id);
            walk(s.body);
            for (const b of (Array.isArray(s.branches) ? s.branches : []) as Array<FlowStep[] | { steps?: FlowStep[] }>) walk(Array.isArray(b) ? b : b?.steps);
        }
    };
    walk(def.steps);
    return out;
}

describe('withFreshNestedIds: the copy of a container gets nested ids of its own', () => {
    it('a duplicated loop no longer shares a body step id with the original', () => {
        const { definition: duplicated, newStepId } = applyDuplicateNode(loopDef(), 'loop_1');
        // The bug: the plain clone repeats ai_a / act_b / loop_in / act_c.
        expect(new Set(allIds(duplicated)).size).toBeLessThan(allIds(duplicated).length);

        const next = withFreshNestedIds(duplicated, newStepId as string);
        const ids = allIds(next);
        expect(new Set(ids).size).toBe(ids.length);
        // The original is untouched, the copy keeps its shape.
        expect(next.steps?.[1]).toBe(duplicated.steps?.[1]);
        const copy = next.steps?.[2] as FlowStep & { body: FlowStep[] };
        expect(copy.body.map(s => s.type)).toEqual(['ai_step', 'integration_action', 'loop']);
    });

    it('re-points the bindings between the copied steps, and only those', () => {
        const { definition: duplicated, newStepId } = applyDuplicateNode(loopDef(), 'loop_1');
        const next = withFreshNestedIds(duplicated, newStepId as string);
        const copy = next.steps?.[2] as FlowStep & { body: Array<FlowStep & { body?: FlowStep[]; inputs?: Record<string, { path?: string; value?: string }> }> };
        const [ai, act, inner] = copy.body;
        expect(act.inputs?.text.path).toBe(`steps.${ai.id}.output.text`);
        expect(inner.overRef).toBe(`steps.${ai.id}.output.lines`);
        expect((inner.body?.[0] as typeof act).inputs?.v.value).toBe(`upper(steps.${act.id}.output.ts)`);
        // A step outside the loop kept its id, so what reads it is left alone.
        expect(ai.prompt).toBe('Summarise {{loop.item.subject}} for {{steps.list.output.owner}}');
        expect(copy.overRef).toBe('steps.list.output.items');
    });

    it('handles parallel branches in both shapes', () => {
        const def: FlowDefinition = {
            trigger: { id: 'trg', type: 'trigger' },
            steps: [{
                id: 'par', type: 'parallel',
                branches: [[{ id: 'act_x', type: 'integration_action' }], { steps: [{ id: 'act_y', type: 'integration_action' }] }],
            }],
            edges: [],
        };
        const { definition: duplicated, newStepId } = applyDuplicateNode(def, 'par');
        const ids = allIds(withFreshNestedIds(duplicated, newStepId as string));
        expect(new Set(ids).size).toBe(ids.length);
        expect(ids).toHaveLength(6);
    });

    it('returns the same object for a step that nests nothing, or an unknown id', () => {
        const def = loopDef();
        expect(withFreshNestedIds(def, 'list')).toBe(def);
        expect(withFreshNestedIds(def, 'nope')).toBe(def);
        const input = loopDef();
        const snapshot = JSON.stringify(input);
        withFreshNestedIds(input, 'loop_1');
        expect(JSON.stringify(input)).toBe(snapshot);
    });
});
