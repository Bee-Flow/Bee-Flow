import { describe, expect, it } from 'vitest';
import { applyAddNode as applyAddNodeJs } from './applyAddNode';
import { branchFromHandle, spliceStepIntoEdge } from './flow/branchEdges';
import { isRouteStep, routePorts } from './flow/routeModel';
import { followAfterAdd, followedMessages } from './flow/routeFollowNotes';
import { FILTER_LIST_ITEM } from './flow/stepPalette';
import { applyAutoMapToStep } from './mapping/autoMapInputs';
import { buildRealOutputMap } from './mapping/realOutputs';
import { MAIL_CONDITION_STEP_RESULTS, mailConditionAutomationFields } from '../../../demo/fixtures/automationsMailCondition';

/**
 * W1 on the demo automation ("Fabrikam attachments by type"): a Condition
 * inserted on the Read many → Read attachment connection becomes a list
 * Condition (auto-map), and in the SAME definition Read attachment is
 * re-pointed at what the Condition keeps, with one toast naming both.
 *
 * BuildTab has no render harness (it needs the whole builder around it), so
 * this runs the pure steps of its handleAddNode in the order it runs them:
 * applyAddNode, the edge splice, auto-map, then followAfterAdd.
 */
type Obj = Record<string, any>;

// applyAddNode is JavaScript whose `= null` defaults read as the parameters' whole type.
const applyAddNode = applyAddNodeJs as (def: Obj, payload: Obj, position: Obj, sourceId?: string | null, sourceHandle?: string | null) => Obj;

const t = (_key: string, fallback: string, vars: Record<string, unknown> = {}) =>
    fallback.replace(/\{(\w+)\}/g, (_m, k: string) => String(vars[k] ?? ''));

/** The demo's definition before the Condition existed: Read many → Read attachment. */
function withoutCondition(): Obj {
    const def = mailConditionAutomationFields().definition as Obj;
    return {
        ...def,
        steps: def.steps.filter((s: Obj) => s.id !== 'mc_condition'),
        edges: [
            ...def.edges.filter((e: Obj) => e.from !== 'mc_condition' && e.to !== 'mc_condition'),
            { from: 'mc_read_many', to: 'mc_read_attachment' },
        ],
    };
}

/** handleAddNode's pure part for a Condition dropped on `source → target`. */
function insertCondition(base: Obj, sourceId: string, targetId: string, payload: Obj = { kind: 'condition', label: 'Condition' }) {
    let next = applyAddNode(base, payload, { x: 0, y: 0 }, sourceId, null);
    const inserted = next.steps[next.steps.length - 1];
    const withoutAuto = next.edges.filter((e: Obj) => !(e.from === sourceId && e.to === inserted.id));
    const firstPort = isRouteStep(inserted) ? routePorts(inserted)[0] : null;
    next = { ...next, edges: spliceStepIntoEdge(withoutAuto, inserted.id, sourceId, targetId, branchFromHandle(null), firstPort) };
    const runSteps = Object.entries(MAIL_CONDITION_STEP_RESULTS).map(([stepId, r]) => ({ stepId, status: 'success', output: r.output }));
    const realOutputById = buildRealOutputMap(next, runSteps);
    const mapped = applyAutoMapToStep(next, inserted.id, { apps: [], steps: [] }, { realOutputById }) as { definition: Obj };
    return { id: inserted.id as string, ...followAfterAdd(mapped.definition as never, inserted.id, t) };
}

const stepOf = (def: Obj, id: string) => def.steps.find((s: Obj) => s.id === id);

describe('BuildTab insert — a Condition on Read many → Read attachment (W1)', () => {
    it('turns into a list Condition over the mails', () => {
        const { definition, id } = insertCondition(withoutCondition(), 'mc_read_many', 'mc_read_attachment');
        expect(stepOf(definition, id)).toMatchObject({ type: 'filter', arrayRef: 'steps.mc_read_many.output.messages' });
    });

    it('re-points Read attachment at what the Condition keeps, parents included', () => {
        const { definition, id } = insertCondition(withoutCondition(), 'mc_read_many', 'mc_read_attachment');
        const fe = stepOf(definition, 'mc_read_attachment').forEach;
        expect(fe.overRef).toBe(`steps.${id}.output.items[*].attachments`);
        expect(fe.parents).toEqual([{ itemVar: 'message', overRef: `steps.${id}.output.items` }]);
    });

    it('touches no other step', () => {
        const before = withoutCondition();
        const { definition } = insertCondition(before, 'mc_read_many', 'mc_read_attachment');
        // applyAddNode gives every card a stored position; nothing else may change.
        const unplaced = (s: Obj) => ({ ...s, position: undefined });
        for (const sid of ['mc_search', 'mc_read_many']) expect(unplaced(stepOf(definition, sid))).toEqual(unplaced(stepOf(before, sid)));
    });

    it('says so in one toast naming the step and the Condition', () => {
        const { messages } = insertCondition(withoutCondition(), 'mc_read_many', 'mc_read_attachment');
        expect(messages).toEqual(['“Read attachment” now works through what “Condition” keeps.']);
    });

    it('does the same for "Filter a list" from the palette (BFSF-485 F1)', () => {
        const { definition, id, messages } = insertCondition(withoutCondition(), 'mc_read_many', 'mc_read_attachment', FILTER_LIST_ITEM.payload);
        expect(stepOf(definition, id)).toMatchObject({ type: 'filter', arrayRef: 'steps.mc_read_many.output.messages' });
        expect(stepOf(definition, 'mc_read_attachment').forEach.overRef).toBe(`steps.${id}.output.items[*].attachments`);
        expect(messages).toEqual(['“Read attachment” now works through what “Condition” keeps.']);
    });

    it('says nothing when the step after it reads nothing of the list', () => {
        const base = withoutCondition();
        base.steps = base.steps.map((s: Obj) => (s.id === 'mc_read_attachment' ? { ...s, forEach: undefined, inputs: {} } : s));
        const { rebound, messages } = insertCondition(base, 'mc_read_many', 'mc_read_attachment');
        expect(rebound).toEqual([]);
        expect(messages).toEqual([]);
    });
});

describe('followedMessages', () => {
    it('names a step rewritten in several places once', () => {
        const def = { steps: [{ id: 'c', type: 'filter', label: 'Keep PDFs' }, { id: 's', type: 'notification', label: 'Tell finance' }] };
        const rebound = [
            { stepId: 's', from: 'steps.r.output.messages', to: 'steps.c.output.items' },
            { stepId: 's', from: 'steps.r.output.messages[*].attachments', to: 'steps.c.output.items[*].attachments' },
        ];
        expect(followedMessages(rebound, def as never, t)).toEqual(['“Tell finance” now works through what “Keep PDFs” keeps.']);
    });
});
