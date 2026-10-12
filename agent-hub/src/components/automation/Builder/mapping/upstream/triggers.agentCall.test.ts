import { describe, expect, it } from 'vitest';
import { describeTrigger } from './triggers';
import { paramsToSchema } from '../../flow/triggerSchemaUtils';

// What the server catalog answers for kinds it has no per-automation fields
// for: the manual trigger's `now`. An agent_call must not fall back to it.
const OUTPUTS = {
    __manual: { fields: [{ key: 'now', sample: '2026-01-01T00:00:00.000Z' }], sample: { now: '2026-01-01T00:00:00.000Z' } },
    __agent_call: { fields: [], sample: {} },
};

type Field = { key: string; path: string };
type Group = { label: string; basePath: string; fields: Field[]; sample: Record<string, unknown> };
const describe_ = (t: unknown) => describeTrigger(t as never, OUTPUTS) as Group;

describe('describeTrigger for an agent_call', () => {
    it('lists the declared parameters as trigger.output.<name>, not the manual trigger\'s `now`', () => {
        const g = describe_({
            id: 'trg',
            kind: 'agent_call',
            parametersSchema: paramsToSchema([
                { name: 'serial_number', type: 'string', required: true, description: 'The serial number' },
                { name: 'limit', type: 'number' },
            ]),
        });
        expect(g.basePath).toBe('trigger.output');
        expect(g.fields.map(f => f.path)).toEqual(['trigger.output.serial_number', 'trigger.output.limit']);
        expect(g.fields.map(f => f.key)).not.toContain('now');
        expect(g.sample).toEqual({ serial_number: '<string>', limit: 0 });
    });

    it('reads a schema the server builder wrote (same shape as paramsToSchema)', () => {
        // Mirrors server/automation/agentCallContract.test.js: the builder writes
        // the exact shape the canvas editor reads.
        const g = describe_({
            id: 'trg',
            kind: 'agent_call',
            parametersSchema: {
                type: 'object',
                properties: { limit: { type: 'number', description: 'how many' }, verbose: { type: 'boolean' } },
                required: ['limit'],
                additionalProperties: false,
            },
        });
        expect(g.fields.map(f => f.path)).toEqual(['trigger.output.limit', 'trigger.output.verbose']);
    });

    it('a tool without declared parameters offers nothing to bind, and does not crash', () => {
        expect(describe_({ id: 'trg', kind: 'agent_call' }).fields).toEqual([]);
        expect(describe_({ id: 'trg', kind: 'agent_call', parametersSchema: { type: 'object', properties: {} } }).fields).toEqual([]);
    });

    it('is labelled as an agent trigger', () => {
        expect(describe_({ id: 'trg', kind: 'agent_call' }).label).toBe('Agent inputs');
    });
});
