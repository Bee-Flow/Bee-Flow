import { describe, it, expect } from 'vitest';
import { parseAgentStepPreview, parseCatalogSkill, parseSkillRows, permissionBits } from './agents';

describe('parseAgentStepPreview', () => {
    it('reads the full round 3 answer', () => {
        const p = parseAgentStepPreview({
            id: 'a1', canUse: true, name: 'Quote bot', version: 8, scope: 'org',
            knowledgeBases: [{ id: 'kb1', name: 'Prices' }, 'kb2'],
            skills: [{ id: 's1', name: 'Explain', fromAgent: true }, { id: 's2', name: 'Extra', fromAgent: false }],
            tools: [{ integration: 'gmail', label: 'Gmail', tools: ['gmail_compose'], withheld: true, reason: 'confirm' }],
            allowed: ['x'], withheld: [{ name: 'gmail_compose', reason: 'confirm' }],
        }, 'a1');
        expect(p.version).toBe(8);
        expect(p.scope).toBe('org');
        expect(p.knowledgeBases).toEqual([{ id: 'kb1', name: 'Prices' }, { id: 'kb2', name: 'kb2' }]);
        expect(p.skills?.map((s) => s.fromAgent)).toEqual([true, false]);
        expect(p.tools?.[0]).toEqual({ integration: 'gmail', label: 'Gmail', tools: ['gmail_compose'], withheld: true, reason: 'confirm' });
    });

    it('an older server without the new keys reads as unknown (null), never as empty', () => {
        const p = parseAgentStepPreview({ canUse: true, allowed: ['a'], withheld: ['b'] }, 'a1');
        expect(p.id).toBe('a1');
        expect(p.skills).toBeNull();
        expect(p.tools).toBeNull();
        expect(p.knowledgeBases).toBeNull();
        expect(p.withheld).toEqual([{ name: 'b', reason: 'unavailable' }]);
    });

    it('canUse false survives', () => {
        expect(parseAgentStepPreview({ canUse: false }, 'x').canUse).toBe(false);
    });
});

describe('parseCatalogSkill', () => {
    it('reads outputFields rows', () => {
        const s = parseCatalogSkill({ id: 's', name: 'N', version: 4, outputFields: [{ key: 'h', type: 'number', title: 'Hours' }, { key: 'x', type: 'weird' }] }, 's');
        expect(s.outputFields).toEqual([{ key: 'h', type: 'number', title: 'Hours' }, { key: 'x', type: 'string', title: null }]);
        expect(s.version).toBe(4);
    });

    it('falls back to a JSON-schema output_schema', () => {
        const s = parseCatalogSkill({ output_schema: { type: 'object', properties: { when: { type: 'string', format: 'date' }, n: { type: 'integer' } } } }, 's');
        expect(s.outputFields).toEqual([{ key: 'when', type: 'datetime', title: null }, { key: 'n', type: 'string', title: null }]);
        expect(s.name).toBe('s');
    });
});

describe('parseSkillRows / permissionBits', () => {
    it('accepts a bare array or {skills}', () => {
        expect(parseSkillRows([{ id: 'a', name: 'A' }, { name: 'no id' }])).toEqual([{ id: 'a', name: 'A', description: null }]);
        expect(parseSkillRows({ skills: [{ id: 'b' }] })).toEqual([{ id: 'b', name: 'b', description: null }]);
    });

    it('encodes the three switches in a fixed order', () => {
        expect(permissionBits({ useTools: true })).toBe('001');
        expect(permissionBits(null)).toBe('000');
    });
});
