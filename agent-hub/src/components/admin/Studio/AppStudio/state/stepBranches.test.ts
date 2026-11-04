import { describe, expect, it } from 'vitest';
import { mapStepBranches } from './stepBranches';
import { removeNode, removeScreen } from './definitionOps';
import type { Step } from './definitionOps.types';

const drop = (kind: string) => (list: Step[] | undefined): Step[] | undefined => {
    if (!Array.isArray(list)) return list;
    const next = list.filter((s) => s.kind !== kind);
    return next.length === list.length ? list : next;
};

describe('mapStepBranches', () => {
    it('maps every branch and the onError handler; an untouched step comes back by reference', () => {
        const step = {
            kind: 'condition', then: [{ kind: 'toast' }, { kind: 'navigate' }], else: [{ kind: 'toast' }],
            cases: [{ value: 1, steps: [{ kind: 'navigate' }] }], default: [], onError: { steps: [{ kind: 'navigate' }, { kind: 'toast' }], stop: true },
        } as unknown as Step;
        const out = mapStepBranches(step, drop('navigate')) as unknown as Record<string, unknown>;
        expect(out.then).toEqual([{ kind: 'toast' }]);
        expect(out.else).toBe((step as unknown as Record<string, unknown>).else);
        expect(out.cases).toEqual([{ value: 1, steps: [] }]);
        expect(out.onError).toEqual({ steps: [{ kind: 'toast' }], stop: true });
        const plain = { kind: 'ai_generate', onError: { steps: [{ kind: 'toast' }] } } as unknown as Step;
        expect(mapStepBranches(plain, drop('navigate'))).toBe(plain);
    });

    it('leaves an effects onError and the legacy array alone', () => {
        const effects = { kind: 'kb_query', onError: { toast: { message: 'x' } } } as unknown as Step;
        expect(mapStepBranches(effects, drop('toast'))).toBe(effects);
    });
});

describe('the screen and dialog clean-ups reach into handlers', () => {
    const def = (step: Record<string, unknown>) => ({
        schemaVersion: 2, homeScreenId: 'scr_home01',
        screens: [
            { id: 'scr_home01', name: 'Home', sections: [{ id: 'sec_home01', children: [{ id: 'cmp_mod001', type: 'modal', props: {}, children: [] }] }] },
            { id: 'scr_gone01', name: 'Gone', sections: [] },
        ],
        actions: { act_err001: { kind: 'sequence', steps: [step] } },
    });

    it('removeScreen drops a navigate to it inside an onError handler, keeping the handler', () => {
        const next = removeScreen(def({ kind: 'ai_generate', onError: { steps: [{ kind: 'navigate', screenId: 'scr_gone01' }, { kind: 'toast', message: 'x' }], stop: true } }) as never, 'scr_gone01') as unknown as { actions: Record<string, { steps: Array<Record<string, unknown>> }> };
        expect(next.actions.act_err001.steps[0].onError).toEqual({ steps: [{ kind: 'toast', message: 'x' }], stop: true });
    });

    it('removing a dialog (removeNode) drops an open_modal of it inside an onError handler', () => {
        const next = removeNode(def({ kind: 'ai_generate', onError: { steps: [{ kind: 'open_modal', modalId: 'cmp_mod001' }] } }) as never, 'cmp_mod001') as unknown as { actions: Record<string, { steps: Array<Record<string, unknown>> }> } | null;
        expect(next?.actions.act_err001.steps[0].onError).toEqual({ steps: [] });
    });
});
