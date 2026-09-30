/**
 * A run's steps are named, never shown by id.
 *
 * `friendlyStepName` / `buildNameMap` / `nameFor` are pinned to the web
 * (DryRunPanel.jsx) by flow-editor's run.lockstep.test.ts; this file pins what
 * the Automations screens add on top: loop bodies, branches and secondary
 * triggers named too, a kind in the web's words, and the fallbacks when the
 * definition does not know the step.
 *
 * Run: cd mobile && ./node_modules/.bin/jest src/features/automations/model/stepLabels.test.ts
 */

import { buildNameMap, friendlyStepName, nameFor, runStepNames, runStepTitle, type NamedDefinition } from './stepLabels';

const english = (_key: string, fallback: string) => fallback;

const DEF: NamedDefinition & Record<string, unknown> = {
    trigger: { id: 'trg', type: 'trigger', label: 'New mail' },
    triggers: [{ id: 'wh', kind: 'webhook' }],
    steps: [
        { id: 'act_4d4307a', type: 'integration_action', label: 'Send the invoice', tool: 'gmail_send' },
        { id: 'act_2', type: 'integration_action', tool: 'gmail_send' },
        { id: 'ai_1', type: 'ai_step' },
        { id: 'kw', type: 'knowledge_write', label: '   ' },
        { id: 'loop_1', type: 'loop', label: 'Each lead', body: [{ id: 'in_loop', type: 'ai_step', label: 'Score the lead' }] } as never,
        { id: 'par', type: 'parallel', branches: [[{ id: 'b1', type: 'set', label: 'Left' }], [{ id: 'b2', type: 'wait' }]] } as never,
        { id: 'call_1', type: 'call_layer', layerKey: 'lk' },
        { id: 'next', type: 'invented_next_year' },
    ],
    layers: { lk: { title: 'Tidy the address', trigger: { id: 'li', type: 'trigger' }, steps: [{ id: 'act_9f2c', type: 'set', label: 'Split the street' }] } },
};

describe('the web port', () => {
    it('names by label, flowlet title and humanised tool, as the dry-run sheet does', () => {
        const names = buildNameMap(DEF, english);
        expect(names.get('act_4d4307a')).toBe('Send the invoice');
        expect(names.get('act_2')).toBe('Gmail Send');
        expect(names.get('call_1')).toBe('Tidy the address');
        expect(names.get('act_9f2c')).toBe('Split the street');
        // The web's own last resort, kept byte-for-byte for the lockstep.
        expect(names.get('ai_1')).toBe('ai step');
        expect(friendlyStepName(null, DEF, english)).toBeNull();
    });

    it('finds a flowlet step by its bare id, and says "Step" for no id at all', () => {
        const names = buildNameMap(DEF, english);
        expect(nameFor('call_1/act_9f2c', names, english)).toBe('Split the street');
        expect(nameFor(null, names, english)).toBe('Step');
        expect(nameFor('ghost', names, english)).toBe('ghost');
    });
});

describe('runStepNames — every node the run could have recorded', () => {
    const names = runStepNames(DEF, english);

    it('names the trigger and the secondary triggers', () => {
        expect(names.get('trg')).toBe('New mail');
        // A secondary trigger as the server stores it carries no `type`.
        expect(names.get('wh')).toBe('Trigger');
        expect(names.get('li')).toBe('Trigger');
    });

    it('names the steps inside a loop body and a parallel branch', () => {
        expect(names.get('in_loop')).toBe('Score the lead');
        expect(names.get('b1')).toBe('Left');
        expect(names.get('b2')).toBe('Wait');
    });

    it('calls a step without a label by its kind, in the web builder’s words', () => {
        expect(names.get('ai_1')).toBe('AI step');
        expect(names.get('kw')).toBe('To knowledge base');
        expect(names.get('act_2')).toBe('Gmail Send');
        expect(names.get('next')).toBe('invented next year');
    });

    it('reads nothing from a missing definition', () => {
        expect(runStepNames(null, english).size).toBe(0);
        expect(runStepNames({ steps: null }, english).size).toBe(0);
    });
});

describe('runStepTitle — never the id', () => {
    const names = runStepNames(DEF, english);

    it('titles a known step, a flowlet’s inner step and the trigger by name', () => {
        expect(runStepTitle({ stepId: 'act_4d4307a', stepType: 'integration_action' }, names, english)).toBe('Send the invoice');
        expect(runStepTitle({ stepId: 'call_1/act_9f2c', stepType: 'set' }, names, english)).toBe('Split the street');
        expect(runStepTitle({ stepId: 'trg', stepType: 'trigger' }, names, english)).toBe('New mail');
    });

    it('falls back to the step’s kind when the definition does not know it', () => {
        const empty = new Map<string, string>();
        expect(runStepTitle({ stepId: 'act_4d4307a', stepType: 'integration_action' }, empty, english)).toBe('Action');
        expect(runStepTitle({ stepId: 'x', stepType: 'ai_step' }, empty, english)).toBe('AI step');
        expect(runStepTitle({ stepId: 'x', stepType: 'constructor' }, empty, english)).toBe('constructor');
        expect(runStepTitle({ stepId: 'x', stepType: null }, empty, english)).toBe('Step');
    });
});
