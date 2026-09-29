import { describe, it, expect } from 'vitest';
import { computeUpstreamGroups, describeNode } from './upstream';

/**
 * A data_extraction step's declared `fields` ARE its output shape. This is
 * what makes drag-and-drop binding work: the moment the author names a field,
 * a downstream step's variable tree lists `steps.<id>.output.<name>` — no
 * schema, no run needed. Placeholders are typed so the kind badges and the
 * mismatch box tell a date from an amount.
 */
const step = {
    id: 'ex_1', type: 'data_extraction', label: 'Read the invoice',
    source: { kind: 'ref', path: 'steps.read.output.content' },
    fields: [
        { name: 'datum', type: 'date', description: 'Invoice date', required: true },
        { name: 'totaal', type: 'number' },
        { name: 'betaald', type: 'boolean' },
        { name: 'leverancier', type: 'string' },
        { name: '', type: 'string' },              // the panel's blank seed row
        { name: 'datum', type: 'string' },         // a duplicate, not yet renamed
    ],
};

describe('upstream — data_extraction exposes its declared fields', () => {
    it('describeNode lists exactly the named fields, typed, at steps.<id>.output.<name>', () => {
        const g = describeNode(step, { steps: [step], edges: [] }, new Map(), {});
        expect(g.kind).toBe('data_extraction');
        expect(g.label).toBe('Read the invoice');
        expect(g.basePath).toBe('steps.ex_1.output');
        expect(g.fields.map(f => f.key)).toEqual(['datum', 'totaal', 'betaald', 'leverancier']);
        expect(g.fields.map(f => f.path)).toEqual([
            'steps.ex_1.output.datum', 'steps.ex_1.output.totaal', 'steps.ex_1.output.betaald', 'steps.ex_1.output.leverancier',
        ]);
        expect(g.sample).toEqual({ datum: '2026-01-15', totaal: 0, betaald: false, leverancier: '<string>' });
    });

    it('a step with nothing named yet contributes an empty group, never a crash or a fake field', () => {
        const g = describeNode({ id: 'ex_2', type: 'data_extraction', fields: [{ name: '' }] }, { steps: [], edges: [] }, new Map(), {});
        expect(g.label).toBe('Extract data');
        expect(g.fields).toEqual([]);
        expect(g.sample).toEqual({});
    });

    it('a downstream step sees the fields in its variable groups', () => {
        const next = { id: 'n1', type: 'notification', title: '', body: '' };
        const definition = {
            trigger: { id: 'trg', type: 'trigger', kind: 'manual', output: {} },
            steps: [step, next],
            edges: [{ from: 'trg', to: 'ex_1' }, { from: 'ex_1', to: 'n1' }],
        };
        const groups = computeUpstreamGroups(definition, 'n1', null);
        const mine = groups.find(g => g.id === 'ex_1');
        expect(mine).toBeTruthy();
        expect(mine.fields.map(f => f.path)).toContain('steps.ex_1.output.totaal');
    });

    it('a fan-out (forEach) reshapes the fields into results[*].output.<name>, like every other iterating step', () => {
        const fanned = { ...step, forEach: { overRef: 'steps.read.output.results', itemVar: 'f', maxIterations: 100 }, source: { kind: 'ref', path: 'loop.f.output.content' } };
        const next = { id: 'n1', type: 'notification', title: '', body: '' };
        const definition = {
            trigger: { id: 'trg', type: 'trigger', kind: 'manual', output: {} },
            steps: [{ id: 'read', type: 'code', code: 'return {results: []}' }, fanned, next],
            edges: [{ from: 'trg', to: 'read' }, { from: 'read', to: 'ex_1' }, { from: 'ex_1', to: 'n1' }],
        };
        const mine = computeUpstreamGroups(definition, 'n1', null).find(g => g.id === 'ex_1');
        expect(mine.forEach).toBe(true);
        expect(mine.fields.map(f => f.path)).toContain('steps.ex_1.output.results[*].output.totaal');
        expect(mine.fields.map(f => f.path)).toContain('steps.ex_1.output.iterations');
    });
});
