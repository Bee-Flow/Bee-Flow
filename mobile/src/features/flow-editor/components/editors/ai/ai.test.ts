/**
 * The AI step's edits as the node editor saves them — who does the thinking
 * and what it may do, the skills and knowledge bases, the tool allowlist,
 * the structured output and the memory tick — plus the loop's list and item.
 */

import type { CatalogAppRow } from '@/features/flow-editor/api';
import type { FlowNode } from '@/features/flow-editor/bindings';
import { buildPatch, extractFormState, type FormDraft } from '@/features/flow-editor/formState';

import { AI_STEP_FORM } from './aiForm';
import { agentRowsOf, chooseAgent, chooseSpecificTools, isLegacyAllTools, setPermission, toggleApp, toggleKnowledgeBase, toggleSkill, toggleTool, toolLabel } from './aiModel';
import { freshName } from './StructuredOutput';
import { configuredTierKeys, tierOptions } from './tiers';
import { loopLists, pickLoopList, sanitizeItemVar } from '../loop/loopModel';

const ai = (extra: Record<string, unknown> = {}) => ({ id: 'ai1', type: 'ai_step', label: 'Think', prompt: 'Hi', ...extra }) as FlowNode;

function edit(step: FlowNode, change: (d: FormDraft) => FormDraft | null) {
    const draft = AI_STEP_FORM.extract(step);
    return AI_STEP_FORM.patch(step, { ...draft, ...(change(draft) ?? {}) });
}

const apps = [
    { id: 'gmail', label: 'Gmail', available: true, actions: [{ name: 'gmail_send', label: 'Send email' }, { name: 'gmail_search', label: '' }] },
    { id: 'off', label: 'Off', available: false, actions: [{ name: 'x' }] },
] as unknown as CatalogAppRow[];

describe('who does the thinking', () => {
    it('picking an agent starts its three permissions off, and a switch rebuilds all three', () => {
        const step = ai({ agentId: 'a1', agentPermissions: { useTools: true, startAutomations: true, useKnowledge: false } });
        expect(edit(step, () => chooseAgent('a2'))).toMatchObject({ agentId: 'a2', agentPermissions: { startAutomations: false, useKnowledge: false, useTools: false } });
        const draft = AI_STEP_FORM.extract(step);
        expect(setPermission(draft, 'useKnowledge', true)).toEqual({ agentPermissions: { startAutomations: true, useKnowledge: true, useTools: true } });
    });

    it('tells an unreadable agent list from an empty one', () => {
        expect(agentRowsOf(null)).toBeNull();
        expect(agentRowsOf({ agents: [], agentsError: 'boom' })).toBeNull();
        expect(agentRowsOf({ agents: [], agentsError: null })).toEqual([]);
    });

    it('keeps skills in the author’s order, capped', () => {
        let draft: FormDraft = { skillIds: [] };
        for (const id of ['a', 'b', 'c', 'd', 'e']) draft = { ...draft, ...toggleSkill(draft, id) };
        expect(toggleSkill(draft, 'f')).toBeNull();
        expect(toggleSkill(draft, 'a')).toEqual({ skillIds: ['b', 'c', 'd', 'e'] });
        expect(edit(ai(), () => ({ skillIds: ['s2', 's1'] })).skillIds).toEqual(['s2', 's1']);
    });

    it('grounds in knowledge bases', () => {
        expect(edit(ai({ knowledgeBaseIds: ['k1'] }), (d) => toggleKnowledgeBase(d, 'k2')).knowledgeBaseIds).toEqual(['k1', 'k2']);
        expect(toggleKnowledgeBase({ knowledgeBaseIds: ['k1'] }, 'k1')).toEqual({ knowledgeBaseIds: [] });
    });
});

describe('tools', () => {
    it('turns a legacy "all tools" step into an explicit list of every available tool', () => {
        const legacy = ai({ allowTools: true });
        expect(isLegacyAllTools(AI_STEP_FORM.extract(legacy))).toBe(true);
        const patch = edit(legacy, () => chooseSpecificTools(apps.filter((a) => a.available)));
        expect(patch).toMatchObject({ tools: ['gmail_send', 'gmail_search'] });
    });

    it('derives allowTools from the list, per tool and per app', () => {
        expect(edit(ai(), (d) => toggleTool(d, 'gmail_send'))).toMatchObject({ tools: ['gmail_send'], allowTools: true });
        const step = ai({ tools: ['gmail_send'], allowTools: true });
        expect(edit(step, (d) => toggleTool(d, 'gmail_send'))).toMatchObject({ tools: [], allowTools: false });
        expect(toggleApp({ tools: ['gmail_send'] }, apps[0] as CatalogAppRow, true)).toEqual({ tools: ['gmail_send', 'gmail_search'] });
        expect(toggleApp({ tools: ['gmail_send', 'x'] }, apps[0] as CatalogAppRow, false)).toEqual({ tools: ['x'] });
    });

    it('names a tool by its app and action', () => {
        expect(toolLabel('gmail_send', apps)).toBe('Gmail: Send email');
        expect(toolLabel('unknown_tool', apps)).toBe('Unknown Tool');
    });
});

describe('the rest of the AI step', () => {
    it('saves structured output as a JSON Schema', () => {
        const patch = edit(ai(), () => ({ outputFields: [{ key: 'urgent', type: 'boolean', description: 'Needs a reply today' }] }));
        expect(patch.outputSchema).toMatchObject({ type: 'object', properties: { urgent: { type: 'boolean' } } });
        expect(freshName(['field', 'field2'], 'field')).toBe('field3');
    });

    it('carries the personal-memory tick both ways, and leaves an untouched step alone', () => {
        expect(edit(ai(), () => ({ useMemory: true })).useMemory).toBe(true);
        const on = ai({ useMemory: true });
        expect(AI_STEP_FORM.extract(on).useMemory).toBe(true);
        const off = edit(on, () => ({ useMemory: false }));
        expect('useMemory' in off && off.useMemory === undefined).toBe(true);
        expect('useMemory' in edit(on, () => null)).toBe(false);
        expect(buildPatch(on, extractFormState(on)).useMemory).toBeUndefined();
    });

    it('offers the configured tiers, and keeps a stored one no longer offered', () => {
        const tiers = { auto: {}, fast: { modelId: 'm' }, swarm: {}, 'custom:acme': { label: 'Acme' }, weird: { modelId: 'x' } };
        expect(configuredTierKeys(tiers)).toEqual(['auto', 'fast', 'custom:acme']);
        const t = (_k: string, fb: string) => fb;
        expect(tierOptions(tiers, 'pro', t)[0]).toEqual({ value: 'pro', label: 'Deep Thinking' });
        expect(tierOptions(tiers, 'fast', t).map((o) => o.label)).toEqual(['Auto', 'Fast', 'Acme']);
    });
});

describe('the loop', () => {
    const groups = [{ id: 'g', label: 'Search', kind: 'step', basePath: 'steps.g.output', sample: {}, fields: [{ key: 'results', path: 'steps.g.output.results', sample: [{ a: 1 }] }] }];

    it('lists what it can repeat over, with how many items', () => {
        const lists = loopLists(groups, { steps: { g: { output: { results: [1, 2, 3] } } } }, null);
        expect(lists).toEqual([expect.objectContaining({ path: 'steps.g.output.results', preview: '3 items' })]);
        // By the step's name and the field, as the loop's card names it — never `g.results`.
        expect(loopLists(groups, null, new Map([['g', 'Search']]))[0]?.label).toBe('Search ▸ Results');
    });

    it('names the item after the list unless someone named it', () => {
        expect(pickLoopList({ itemVar: 'item' }, 'steps.g.output.results', 'result')).toEqual({ overRef: 'steps.g.output.results', itemVar: 'result' });
        expect(pickLoopList({ itemVar: 'row' }, 'p', 'result')).toEqual({ overRef: 'p', itemVar: 'row' });
        expect(sanitizeItemVar('my item!')).toBe('myitem');
        expect(sanitizeItemVar('!!')).toBe('item');
    });

    it('clamps the cap and the batch, and defaults the item name', () => {
        const loop = { id: 'l1', type: 'loop', overRef: '', body: [] } as unknown as FlowNode;
        const draft = extractFormState(loop);
        expect(draft).toMatchObject({ itemVar: 'item', maxIterations: 100, batchSize: 1 });
        expect(buildPatch(loop, { ...draft, maxIterations: 5000, batchSize: 0, itemVar: ' ' })).toMatchObject({ maxIterations: 1000, batchSize: 1, itemVar: 'item' });
    });
});
