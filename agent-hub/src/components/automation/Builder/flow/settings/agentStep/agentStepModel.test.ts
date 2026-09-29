import { describe, it, expect } from 'vitest';
import type { AgentStepPreview } from '../../../../../../api/queries/automation/agents';
import { agentMetaLine, stepSkillRows, toggleDisabledSkill, toolGroupsOf, withPermission } from './agentStepModel';

const t = (_k: string, fb?: unknown, p?: Record<string, unknown>) =>
    String(fb ?? '').replace(/\{(\w+)\}/g, (_m, k: string) => String(p?.[k] ?? `{${k}}`));

const preview = (over: Partial<AgentStepPreview> = {}): AgentStepPreview => ({
    id: 'a', canUse: true, name: 'Bot', version: null, scope: null, runtimeSource: null,
    knowledgeBases: null, skills: null, tools: null, allowed: [], withheld: [], degraded: false, error: null, ...over,
});

describe('stepSkillRows', () => {
    const names = new Map([['s1', 'One'], ['s2', 'Two']]);

    it('puts the step\'s own skills first and lets the first one lead', () => {
        const rows = stepSkillRows(['s1'], [{ id: 'a1', name: 'Agent skill', fromAgent: true }], [], names);
        expect(rows.map((r) => [r.id, r.source, r.leading])).toEqual([['s1', 'step', true], ['a1', 'agent', false]]);
    });

    it('an agent skill switched off does not lead; the next enabled one does', () => {
        const rows = stepSkillRows([], [
            { id: 'a1', name: 'A', fromAgent: true },
            { id: 'a2', name: 'B', fromAgent: true },
        ], ['a1'], names);
        expect(rows.map((r) => [r.id, r.enabled, r.leading])).toEqual([['a1', false, false], ['a2', true, true]]);
    });

    it('lists a skill the step and the agent share only once, as the step\'s', () => {
        const rows = stepSkillRows(['s2'], [{ id: 's2', name: 'Two', fromAgent: true }], [], names);
        expect(rows).toHaveLength(1);
        expect(rows[0].source).toBe('step');
    });
});

describe('withPermission / toggleDisabledSkill', () => {
    it('always writes all three keys as booleans', () => {
        expect(withPermission({ useTools: true }, 'useKnowledge', true)).toEqual({ startAutomations: false, useKnowledge: true, useTools: true });
        expect(withPermission(null, 'useTools', false)).toEqual({ startAutomations: false, useKnowledge: false, useTools: false });
    });

    it('adds and removes an exclusion without duplicates', () => {
        expect(toggleDisabledSkill(['a'], 'a', false)).toEqual(['a']);
        expect(toggleDisabledSkill(['a', 'b'], 'a', true)).toEqual(['b']);
    });
});

describe('toolGroupsOf', () => {
    it('uses the server\'s groups when it sends them', () => {
        const tools = [{ integration: 'web', label: 'Web', tools: ['web_search'], withheld: false, reason: null }];
        expect(toolGroupsOf(preview({ tools }))).toBe(tools);
    });

    it('groups the bare names per app, striking a group only when every tool in it is withheld', () => {
        const apps = [
            { id: 'gmail', label: 'Gmail', actions: [{ name: 'gmail_search' }, { name: 'gmail_compose' }] },
            { id: 'slack', label: 'Slack', actions: [{ name: 'slack_post' }] },
        ];
        const groups = toolGroupsOf(preview({
            allowed: ['gmail_search'],
            withheld: [{ name: 'gmail_compose', reason: 'confirm' }, { name: 'slack_post', reason: 'confirm' }],
        }), apps);
        expect(groups.map((g) => [g.label, g.withheld, g.reason])).toEqual([['Gmail', false, null], ['Slack', true, 'confirm']]);
    });
});

describe('agentMetaLine', () => {
    it('reads like the design: version · scope · knowledge · skills', () => {
        const line = agentMetaLine(t, preview({ version: 8, scope: 'org', knowledgeBases: [{ id: 'k', name: 'Terms' }] }), 2);
        expect(line).toBe('v8 · organisation · knows Terms · 2 skills');
    });

    it('leaves out what it does not know', () => {
        expect(agentMetaLine(t, preview(), 1)).toBe('1 skill');
        expect(agentMetaLine(t, null, 3)).toBe('');
    });
});
