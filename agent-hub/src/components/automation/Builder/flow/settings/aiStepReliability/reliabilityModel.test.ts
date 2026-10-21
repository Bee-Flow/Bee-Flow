// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
    bindingFromText, buildReliabilityPatch, canRunItemsInParallel, issueSlot, outputFieldPaths,
    readReliability, reliabilityIsSet, reliabilityProblems, textFromBinding, tidyCheck,
    type Check,
} from './reliabilityModel';

const draftOf = (over: Record<string, unknown> = {}) => ({ ...readReliability({}), ...over });

describe('readReliability', () => {
    it('reads an untouched step as everything off', () => {
        expect(readReliability({ id: 's1', type: 'ai_step' })).toEqual({
            temperature: null, enumFrom: [], checks: [], fallback: null, askOnce: undefined,
        });
    });

    it('keeps what is stored and drops what it cannot read', () => {
        const got = readReliability({
            temperature: 0.7,
            enumFrom: [{ field: 'category', ref: 'steps.s1.output.rows', value: 'name' }, 'junk', null],
            checks: [{ kind: 'items', field: 'tags[]', minItems: 1 }, { kind: 'nope' }, 7],
            fallback: { kind: 'value', fields: { category: { kind: 'literal', value: 'Other' } } },
            askOnce: { acrossRuns: true },
        });
        expect(got.temperature).toBe(0.7);
        expect(got.enumFrom).toEqual([{ field: 'category', ref: 'steps.s1.output.rows', value: 'name' }]);
        expect(got.checks).toEqual([{ kind: 'items', field: 'tags[]', minItems: 1 }]);
        expect(got.fallback).toEqual({ kind: 'value', fields: { category: { kind: 'literal', value: 'Other' } } });
        expect(got.askOnce).toEqual({ acrossRuns: true });
    });

    it('does not alias the stored step', () => {
        const step = { checks: [{ kind: 'script', field: 'text', script: 'latin' }] };
        const got = readReliability(step);
        (got.checks[0] as { script: string }).script = 'greek';
        expect(step.checks[0].script).toBe('latin');
    });

    it('ignores a temperature that is not a number', () => {
        expect(readReliability({ temperature: 'warm' }).temperature).toBeNull();
    });
});

describe('buildReliabilityPatch', () => {
    it('adds nothing for an untouched legacy step', () => {
        expect(buildReliabilityPatch(readReliability({}), {})).toEqual({});
    });

    it('is the identity for a canonical step', () => {
        const step = {
            temperature: 0,
            enumFrom: [{ field: 'category', ref: 'steps.s1.output.rows', value: 'name', ignoreCase: false }],
            checks: [
                { kind: 'numbersFrom', field: 'summary', ref: 'steps.s1.output.text', tolerance: 0.5, ignoreUpTo: 10, percent: false },
                { kind: 'script', field: 'summary', script: 'greek', minRatio: 0.9 },
                { kind: 'items', field: 'rows[]', maxItems: 5, sameCountAs: 'steps.s1.output.rows' },
            ],
            fallback: { kind: 'value', fields: { summary: { kind: 'literal', value: 'n/a' } } },
        };
        expect(buildReliabilityPatch(readReliability(step), step)).toEqual(step);
    });

    it('drops empty optional keys and keeps the defaults implicit', () => {
        const checks: Check[] = [
            { kind: 'allowedFrom', field: 'c', ref: ' steps.a.output.l ', value: '', ignoreCase: true, allowEmpty: false },
            { kind: 'numbersFrom', field: 's', ref: 'steps.a.output.t', tolerance: 0, ignoreUpTo: undefined, percent: true, ignoreDates: true },
            { kind: 'script', field: 's', script: 'latin', minRatio: 1 },
            { kind: 'items', field: 'l', minItems: 0, maxItems: undefined, sameCountAs: '' },
        ];
        expect(checks.map(tidyCheck)).toEqual([
            { kind: 'allowedFrom', field: 'c', ref: 'steps.a.output.l' },
            { kind: 'numbersFrom', field: 's', ref: 'steps.a.output.t' },
            { kind: 'script', field: 's', script: 'latin' },
            { kind: 'items', field: 'l' },
        ]);
    });

    it('keeps the required keys of a card that is not filled in yet, so the validator can point at it', () => {
        const patch = buildReliabilityPatch(draftOf({ checks: [{ kind: 'items', field: '' }] }), {});
        expect(patch.checks).toEqual([{ kind: 'items', field: '' }]);
    });

    it('writes a temperature, but not the default one on a step that has none', () => {
        expect(buildReliabilityPatch(draftOf({ temperature: 0.7 }), {})).toEqual({ temperature: 0.7 });
        expect(buildReliabilityPatch(draftOf({ temperature: 0.2 }), {})).toEqual({});
        expect(buildReliabilityPatch(draftOf({ temperature: 0.2 }), { temperature: 0.2 })).toEqual({ temperature: 0.2 });
    });

    it('clears with undefined, the one spelling of off', () => {
        const step = { temperature: 0.7, enumFrom: [{ field: 'a', ref: 'steps.s.output.l' }], checks: [{ kind: 'items', field: 'l', minItems: 1 }], fallback: { kind: 'value', fields: { a: { kind: 'literal', value: 'x' } } } };
        const patch = buildReliabilityPatch(draftOf(), step);
        expect(Object.keys(patch).sort()).toEqual(['checks', 'enumFrom', 'fallback', 'temperature']);
        for (const v of Object.values(patch)) expect(v).toBeUndefined();
    });

    it('writes the fail fallback as no fallback, unless the author stored one next to checks', () => {
        const withCheck = { checks: [{ kind: 'items', field: 'l', minItems: 1 }] };
        expect(buildReliabilityPatch(draftOf({ ...withCheck, fallback: { kind: 'fail' } }), withCheck).fallback).toBeUndefined();
        expect('fallback' in buildReliabilityPatch(draftOf({ ...withCheck, fallback: { kind: 'fail' } }), withCheck)).toBe(false);
        const stored = { ...withCheck, fallback: { kind: 'fail' } };
        expect(buildReliabilityPatch(readReliability(stored), stored).fallback).toEqual({ kind: 'fail' });
        // Switching a stored value fallback back to fail removes it.
        const valued = { ...withCheck, fallback: { kind: 'value', fields: { a: { kind: 'literal', value: 'x' } } } };
        const patch = buildReliabilityPatch(draftOf({ ...withCheck, fallback: { kind: 'fail' } }), valued);
        expect('fallback' in patch && patch.fallback === undefined).toBe(true);
    });

    it('treats a value fallback with no values typed yet as no fallback', () => {
        expect(buildReliabilityPatch(draftOf({ fallback: { kind: 'value', fields: {} } }), {})).toEqual({});
    });
});

describe('fallback bindings', () => {
    it('is a template when it holds {{ }}, else a literal typed after the field', () => {
        expect(bindingFromText('Hello {{trigger.output.name}}', 'string')).toEqual({ kind: 'template', value: 'Hello {{trigger.output.name}}' });
        expect(bindingFromText('Other', 'string')).toEqual({ kind: 'literal', value: 'Other' });
        expect(bindingFromText('12.5', 'number')).toEqual({ kind: 'literal', value: 12.5 });
        expect(bindingFromText('abc', 'number')).toEqual({ kind: 'literal', value: 'abc' });
        expect(bindingFromText('true', 'boolean')).toEqual({ kind: 'literal', value: true });
        expect(bindingFromText('["a","b"]', 'array')).toEqual({ kind: 'literal', value: ['a', 'b'] });
        expect(bindingFromText('[oops', 'array')).toBeNull();
        expect(bindingFromText('   ', 'string')).toBeNull();
    });

    it('shows a binding as the text that made it', () => {
        expect(textFromBinding({ kind: 'literal', value: 12.5 })).toBe('12.5');
        expect(textFromBinding({ kind: 'literal', value: ['a'] })).toBe('["a"]');
        expect(textFromBinding({ kind: 'ref', path: 'trigger.output.x' })).toBe('{{trigger.output.x}}');
        expect(textFromBinding({ kind: 'template', value: 'a {{b}}' })).toBe('a {{b}}');
        expect(textFromBinding(undefined)).toBe('');
    });
});

describe('outputFieldPaths', () => {
    const fields = [
        { key: 'category', type: 'string' },
        { key: 'score', type: 'number' },
        { key: 'when', type: 'datetime' },
        { key: 'ok', type: 'boolean' },
        { key: 'tags', type: 'array' },
        { key: 'rows', type: 'array', columns: [{ key: 'name', type: 'string' }, { key: 'qty', type: 'number' }] },
        { key: 'labels', type: 'array', itemsSpec: { type: 'string' } },
        { key: 'address', type: 'object', objectSpec: { city: { type: 'string' }, geo: { type: 'object' } } },
        { key: 'bad.key', type: 'string' },
        { key: '', type: 'string' },
    ];
    const byPath = Object.fromEntries(outputFieldPaths(fields).map(o => [o.path, o.kind]));

    it('offers the top-level fields by kind', () => {
        expect(byPath).toMatchObject({ category: 'text', score: 'number', when: 'text', ok: 'other', tags: 'list', rows: 'list', labels: 'list', address: 'other' });
    });

    it('offers each item of a list, the columns of a table and the parts of an object', () => {
        expect(byPath).toMatchObject({
            'tags[]': 'text', 'rows[].name': 'text', 'rows[].qty': 'number', 'labels[]': 'text', 'address.city': 'text', 'address.geo': 'other',
        });
        expect(byPath).not.toHaveProperty('rows[]');
    });

    it('leaves out names the server would refuse', () => {
        expect(Object.keys(byPath).some(p => p.startsWith('bad'))).toBe(false);
        expect(outputFieldPaths(null)).toEqual([]);
    });

    it('says which field a path belongs to', () => {
        const o = outputFieldPaths(fields).find(x => x.path === 'rows[].qty');
        expect(o).toMatchObject({ field: 'rows', column: 'qty', each: true });
    });
});

describe('canRunItemsInParallel', () => {
    it('allows a step with no tools, and a draft without any tool keys', () => {
        expect(canRunItemsInParallel({ allowTools: false, tools: null, skillIds: [], agentId: null })).toBe(true);
        expect(canRunItemsInParallel({ fields: [] })).toBe(true);
        expect(canRunItemsInParallel(null)).toBe(true);
    });

    it('refuses once the model could be offered a tool', () => {
        expect(canRunItemsInParallel({ allowTools: true })).toBe(false);
        expect(canRunItemsInParallel({ tools: ['gmail_search'] })).toBe(false);
        expect(canRunItemsInParallel({ skillIds: ['sk1'] })).toBe(false);
        expect(canRunItemsInParallel({ agentId: 'a1', agentPermissions: { useTools: true } })).toBe(false);
        expect(canRunItemsInParallel({ agentId: 'a1', agentPermissions: { startAutomations: true } })).toBe(false);
        expect(canRunItemsInParallel({ agentId: 'a1', agentPermissions: { useTools: false } })).toBe(true);
        expect(canRunItemsInParallel({ agentId: null, agentPermissions: { useTools: true } })).toBe(true);
    });
});

describe('problems per card', () => {
    it('finds the card a finding belongs to', () => {
        expect(issueSlot('steps[s1].enumFrom[0].ref')).toBe('enumFrom:0');
        expect(issueSlot('steps[s1].checks[12].field')).toBe('checks:12');
        expect(issueSlot('steps[s1].fallback.fields.category')).toBe('fallback');
        expect(issueSlot('steps[s1].inputs.x')).toBeNull();
        expect(issueSlot(undefined)).toBeNull();
    });

    it('keeps the first error per card, without the step id in front', () => {
        const got = reliabilityProblems({ errors: [
            { path: 'steps[s1].checks[1].ref', message: 'Step s1: checks[1].ref is required.' },
            { path: 'steps[s1].checks[1].field', message: 'second' },
            { path: 'steps[s1].prompt', message: 'unrelated' },
        ] });
        expect([...got]).toEqual([['checks:1', 'checks[1].ref is required.']]);
    });
});

describe('reliabilityIsSet', () => {
    it('is on for any list, check or value fallback, and off otherwise', () => {
        expect(reliabilityIsSet(draftOf())).toBe(false);
        expect(reliabilityIsSet(draftOf({ enumFrom: [{ field: 'a', ref: 'r' }] }))).toBe(true);
        expect(reliabilityIsSet(draftOf({ checks: [{ kind: 'items', field: 'a' }] }))).toBe(true);
        expect(reliabilityIsSet(draftOf({ fallback: { kind: 'value', fields: {} } }))).toBe(true);
        expect(reliabilityIsSet(draftOf({ fallback: { kind: 'fail' } }))).toBe(false);
    });
});
