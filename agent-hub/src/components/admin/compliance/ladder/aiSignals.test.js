// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
    AI_STEP_TYPES,
    isAiStep,
    listSteps,
    stepLabel,
    definitionOf,
    signalsForAutomation,
    signalsForAgent,
    fallbackSignals,
} from './aiSignals';

const quote = {
    id: 'a1',
    name: 'Offerte berekenen',
    definition: {
        trigger: { kind: 'form', formId: 'f1' },
        steps: [
            { id: 's1', type: 'form_page', label: 'Nieuwe aanvraag' },
            { id: 's2', type: 'set', label: 'Prijs' },
            { id: 's3', type: 'ai_step', label: "Foto's beoordelen" },
            { id: 's4', type: 'summarize', label: 'Samenvatten' },
            { id: 's5', type: 'generate_document', label: 'Offerte-PDF' },
        ],
    },
};

describe('aiSignals — the AI step list', () => {
    it('matches CONTRACTS.md: ai_step, data_extraction, ai_tool — and NOT summarize', () => {
        expect([...AI_STEP_TYPES]).toEqual(['ai_step', 'data_extraction', 'ai_tool']);
        expect(isAiStep({ type: 'ai_step' })).toBe(true);
        expect(isAiStep({ type: 'data_extraction' })).toBe(true);
        expect(isAiStep({ type: 'ai_tool' })).toBe(true);
        expect(isAiStep({ type: 'summarize' })).toBe(false);
        expect(isAiStep({ type: 'set' })).toBe(false);
        expect(isAiStep(null)).toBe(false);
    });

    it('a routine whose only "AI-looking" step is summarize does not contain AI', () => {
        const sig = signalsForAutomation({ id: 'x', definition: { steps: [{ id: 's', type: 'summarize' }, { id: 't', type: 'set' }] } });
        expect(sig.contains_ai).toBe(false);
        expect(sig.steps.ai).toEqual([]);
        expect(sig.step_count).toBe(2);
    });
});

describe('aiSignals.listSteps — nesting like the server walker', () => {
    it('descends into loop bodies and parallel branches, parents first', () => {
        const def = {
            steps: [
                { id: 'l', type: 'loop', body: [{ id: 'l1', type: 'ai_step' }, { id: 'l2', type: 'set' }] },
                { id: 'p', type: 'parallel', branches: [[{ id: 'p1', type: 'data_extraction' }], [{ id: 'p2', type: 'generate_document' }]] },
                { id: 'c', type: 'condition' },
            ],
            layers: { L: { steps: [{ id: 'x1', type: 'ai_tool' }] } },
        };
        const ids = listSteps(def).map(x => x.step.id);
        expect(ids).toEqual(['l', 'l1', 'l2', 'p', 'p1', 'p2', 'c', 'x1']);
        const l1 = listSteps(def).find(x => x.step.id === 'l1');
        expect(l1.parentId).toBe('l');
        expect(l1.layer).toBeNull();
        expect(listSteps(def).find(x => x.step.id === 'x1').layer).toBe('L');

        const sig = signalsForAutomation({ id: 'n', definition: def });
        expect(sig.steps.ai.map(s => s.id)).toEqual(['l1', 'p1', 'x1']);
        expect(sig.generates_content).toBe(true);
    });

    it('tolerates junk: no definition, string definition, non-object steps', () => {
        expect(listSteps(null)).toEqual([]);
        expect(listSteps({ steps: [null, 'x', 3] })).toEqual([]);
        expect(definitionOf({ definition: '{"steps":[{"id":"a","type":"ai_step"}]}' }).steps).toHaveLength(1);
        expect(definitionOf({ definition: '{not json' })).toBeNull();
        expect(signalsForAutomation({ id: 'q' })).toMatchObject({ contains_ai: false, customer_facing: false, generates_content: false, step_count: 0 });
    });
});

describe('aiSignals.signalsForAutomation — the artboard routine', () => {
    it('produces the server shape: 1 AI step, customer-facing via the form, generates content, unknowns null', () => {
        const sig = signalsForAutomation(quote);
        expect(sig).toEqual({
            contains_ai: true,
            customer_facing: true,
            generates_content: true,
            disclosure_present: null,
            marking_enabled: null,
            annex_iii_hint: null,
            steps: { ai: [{ id: 's3', label: "Foto's beoordelen" }], generating: [{ id: 's5', label: 'Offerte-PDF' }] },
            step_count: 5,
            surface: 'form',
            source: 'client',
        });
    });

    it('customer-facing from a form trigger in triggers[], or from a form_page step, and false otherwise', () => {
        const base = [{ id: 's', type: 'ai_step' }];
        expect(signalsForAutomation({ definition: { triggers: [{ kind: 'schedule' }, { kind: 'form' }], steps: base } }).customer_facing).toBe(true);
        expect(signalsForAutomation({ definition: { trigger: { kind: 'webhook' }, steps: [...base, { id: 'f', type: 'form_page' }] } }).customer_facing).toBe(true);
        const internal = signalsForAutomation({ definition: { trigger: { kind: 'schedule' }, steps: base } });
        expect(internal.customer_facing).toBe(false);
        expect(internal.surface).toBeNull();
    });

    it('stepLabel prefers label, then name, title, id, type', () => {
        expect(stepLabel({ id: 'x', type: 'ai_step', label: ' Lbl ' })).toBe('Lbl');
        expect(stepLabel({ id: 'x', type: 'ai_step', name: 'Nm' })).toBe('Nm');
        expect(stepLabel({ id: 'x', type: 'ai_step' })).toBe('x');
        expect(stepLabel({ type: 'ai_step' })).toBe('ai_step');
    });
});

describe('aiSignals.signalsForAgent / fallbackSignals', () => {
    it('an agent always contains AI and generates content; customer-facing when published', () => {
        expect(signalsForAgent({ id: 'g', is_published: true })).toMatchObject({ contains_ai: true, generates_content: true, customer_facing: true, surface: 'published_agent', disclosure_present: null });
        expect(signalsForAgent({ id: 'g', is_published: false })).toMatchObject({ customer_facing: false, surface: null });
        expect(signalsForAgent(null)).toMatchObject({ contains_ai: true, customer_facing: false });
    });

    it('dispatches on kind and returns null for an unknown kind', () => {
        expect(fallbackSignals('automation', quote).contains_ai).toBe(true);
        expect(fallbackSignals('agent', { id: 'g' }).contains_ai).toBe(true);
        expect(fallbackSignals('webpage', {})).toBeNull();
    });
});
