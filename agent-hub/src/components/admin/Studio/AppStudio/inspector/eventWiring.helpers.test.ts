import { describe, expect, it } from 'vitest';
import {
    appRefOf, kindSwitchOf, nextParamName, paramMetaOf, renamedMapping, targetTriggerOf, withEffect,
    withPickedAutomation, withoutMapping, type WiredAutomation,
} from './eventWiring.helpers';
import type { AppAction, AppDefinition, FormFieldRef } from './appDefinition';

const definition: AppDefinition = {
    screens: [{ id: 's1', sections: [{ children: [{ id: 'form', type: 'form', children: [{ id: 'btn', type: 'button' }] }] }] }],
};
const fields: FormFieldRef[] = [
    { name: 'amount', type: 'input_number', multiple: false },
    { name: 'invoice', type: 'input_file', multiple: false },
];

describe('appRefOf', () => {
    it('is a whole pointer or nothing', () => {
        expect(appRefOf('app1', definition, 'btn')).toEqual({ appId: 'app1', screenId: 's1', nodeId: 'btn' });
        expect(appRefOf(null, definition, 'btn')).toBeNull();
        expect(appRefOf('app1', definition, 'missing')).toBeNull();
    });
});

describe('targetTriggerOf and paramMetaOf', () => {
    const automations: WiredAutomation[] = [{
        id: 'a1',
        definition: { trigger: { kind: 'app_trigger', params: [{ name: 'amount', type: 'number', required: true }, null, { description: 'no name' }] } },
    }];

    it('reads the trigger of the automation the action runs', () => {
        expect(targetTriggerOf({ kind: 'run_automation', automationId: 'a1' }, automations)?.kind).toBe('app_trigger');
        expect(targetTriggerOf({ kind: 'toast' }, automations)).toBeNull();
    });

    it('describes typed app_trigger params and agent_call schema properties', () => {
        expect(paramMetaOf(automations[0].definition?.trigger ?? null)).toEqual({
            amount: { type: 'number', required: true, description: '' },
        });
        expect(paramMetaOf({
            kind: 'agent_call',
            parametersSchema: { properties: { q: { type: 'string', description: 'Question' }, n: { type: 7 } }, required: ['q'] },
        })).toEqual({
            q: { type: 'string', required: true, description: 'Question' },
            n: { type: 'string', required: false, description: '' },
        });
        expect(paramMetaOf(null)).toBeNull();
    });
});

describe('kindSwitchOf', () => {
    it('does nothing without an action or for the same kind', () => {
        expect(kindSwitchOf(null, 'toast')).toEqual({ type: 'none' });
        expect(kindSwitchOf({ kind: 'toast' }, 'toast')).toEqual({ type: 'none' });
    });

    it('keeps the action as the first step of a new flow and flags a lost onError', () => {
        const change = kindSwitchOf({ kind: 'toast', message: 'hi', onError: { toast: { message: 'x' } } }, 'sequence');
        expect(change.type).toBe('sequence');
        expect(change).toMatchObject({ dropsOnError: true });
        expect(kindSwitchOf({ kind: 'toast', message: 'hi' }, 'sequence')).toMatchObject({ dropsOnError: false });
    });

    it('asks before flattening a real flow and otherwise replaces', () => {
        expect(kindSwitchOf({ kind: 'sequence', steps: [{ kind: 'toast' }, { kind: 'navigate' }] }, 'toast')).toEqual({ type: 'confirm' });
        expect(kindSwitchOf({ kind: 'toast' }, 'navigate')).toEqual({ type: 'replace' });
    });
});

describe('withPickedAutomation', () => {
    const action: AppAction = { kind: 'run_automation', automationId: 'old', inputMapping: { amount: { kind: 'static', value: '5' }, stale: { kind: 'static', value: '' } } };

    it('keeps only the declared params, prefilled from the form', () => {
        const next = withPickedAutomation(action, {
            id: 'a2',
            definition: { trigger: { kind: 'app_trigger', params: [{ name: 'amount' }, { name: 'file', type: 'file' }, { name: 'note' }] } },
        }, fields, ['amount', 'invoice']);
        expect(next.automationId).toBe('a2');
        expect(next.inputMapping).toEqual({
            amount: { kind: 'static', value: '5' },
            file: { kind: 'field', name: 'invoice' },
            note: { kind: 'static', value: '' },
        });
    });

    it('drops the mapping when the contract is empty and keeps it when there is none', () => {
        const empty = withPickedAutomation(action, { id: 'a3', definition: { trigger: { kind: 'agent_call', parametersSchema: { properties: {} } } } }, fields, []);
        expect(empty).not.toHaveProperty('inputMapping');
        const none = withPickedAutomation(action, { id: 'a4' }, fields, []);
        expect(none.inputMapping).toBe(action.inputMapping);
    });
});

describe('mapping edits', () => {
    it('renames a parameter in place and refuses a clash or a blank name', () => {
        const current = { a: { kind: 'static' as const, value: '1' }, b: { kind: 'static' as const, value: '2' } };
        expect(Object.keys(renamedMapping(current, 'a', 'c') ?? {})).toEqual(['c', 'b']);
        expect(renamedMapping(current, 'a', 'b')).toBeNull();
        expect(renamedMapping(current, 'a', '  ')).toBeNull();
    });

    it('removes a parameter and the empty mapping with it', () => {
        expect(withoutMapping({ kind: 'run_automation', inputMapping: { a: { kind: 'static' } } }, 'a')).toEqual({ kind: 'run_automation' });
    });

    it('finds the first free parameter name', () => {
        expect(nextParamName(undefined)).toBe('param');
        expect(nextParamName({ param: { kind: 'static' }, param2: { kind: 'static' } })).toBe('param3');
    });

    it('sets and clears an effect slot', () => {
        expect(withEffect({ kind: 'toast' }, 'onSuccess', { navigateTo: 's2' })).toEqual({ kind: 'toast', onSuccess: { navigateTo: 's2' } });
        expect(withEffect({ kind: 'toast', onError: { navigateTo: 's1' } }, 'onError', null)).toEqual({ kind: 'toast' });
    });
});
