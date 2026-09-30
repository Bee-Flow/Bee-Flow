/**
 * The rules this app must not invent for itself: who may edit a skill, what an
 * edit is allowed to send back, how a delete is confirmed, and that a model
 * call is never retried.
 *
 * All are server contracts that fail quietly when they drift — a missing
 * `canEdit` would paint an editor that 403s, a text facet in the PUT body would
 * re-mint every step id the Studio laid down, and a wrongly spelled
 * confirmation turns "delete anyway" into a 400.
 */

import { api } from '@/core/api/client';

import { deleteSkill, draftSkill, getSkillUsage, getSkillUsageSummary, improveSkill, updateSkill } from './endpoints';
import { canEditSkill } from '../model/permissions';
import { buildSavePayload, draftOf } from '../model/skillModel';
import type { Skill } from '../model/types';

jest.mock('@/core/api/client', () => {
    const actual = jest.requireActual('@/core/api/client');
    return { ...actual, api: { ...actual.api, get: jest.fn(), post: jest.fn(), put: jest.fn(), delete: jest.fn() } };
});

const get = api.get as jest.Mock;
const post = api.post as jest.Mock;
const put = api.put as jest.Mock;
const del = api.delete as jest.Mock;

const skill = (over: Partial<Skill> = {}): Skill => ({
    id: 'sk1',
    orgId: 'org1',
    userId: 'u1',
    name: 'Sales tone',
    description: 'How we write to prospects.',
    instructions: 'Short sentences.',
    workflow: '1. Read the thread',
    rules: 'Never promise a date.',
    examples: '',
    icon: '⚡',
    isShared: false,
    dynamicActivation: false,
    sharedGroups: [],
    automationId: null,
    enabledIntegrations: [],
    steps: [{ id: 's1', text: 'Read the thread', refs: [{ kind: 'kb', id: 'kb1' }] }],
    rulesV2: [{ id: 'r1', polarity: 'never', text: 'Never promise a date.' }],
    examplesV2: [],
    outputSchema: null,
    knowledgeBaseIds: [],
    allowedAutomationIds: [],
    lastTest: null,
    lastUsedAt: null,
    createdAt: null,
    updatedAt: null,
    ...over,
});

beforeEach(() => {
    for (const fn of [get, post, put, del]) fn.mockReset();
});

describe('canEditSkill — the server verdict, read fail-closed', () => {
    it('refuses when the row carries no verdict at all', () => {
        expect(canEditSkill(skill())).toBe(false);
    });

    it('refuses when the server says no, and a truthy non-boolean', () => {
        expect(canEditSkill(skill({ canEdit: false }))).toBe(false);
        expect(canEditSkill(skill({ canEdit: 'yes' as unknown as boolean }))).toBe(false);
    });

    it('allows when the server says yes — even on a row this session does not own', () => {
        expect(canEditSkill(skill({ userId: 'someone-else', canEdit: true }))).toBe(true);
    });
});

describe('updateSkill — the structure, never the text', () => {
    it('PUTs the structured facets and none of workflow / rules / examples', async () => {
        put.mockResolvedValue({ success: true });
        await updateSkill('sk1', buildSavePayload(draftOf(skill())));
        const [path, body] = put.mock.calls[0] as [string, Record<string, unknown>];
        expect(path).toBe('/api/skills/sk1');
        expect(body).not.toHaveProperty('workflow');
        expect(body).not.toHaveProperty('rules');
        expect(body).not.toHaveProperty('examples');
        expect(body.steps).toEqual([{ id: 's1', text: 'Read the thread', refs: [{ kind: 'kb', id: 'kb1' }] }]);
        expect(body.rulesV2).toEqual([{ id: 'r1', polarity: 'never', text: 'Never promise a date.' }]);
    });
});

describe('deleteSkill — the confirmation the route actually accepts', () => {
    it('sends the first request without a confirmation', async () => {
        await deleteSkill('sk1');
        expect(del).toHaveBeenCalledWith('/api/skills/sk1', undefined);
    });

    it('confirms with ?confirmBreaking=true, not the confirm=1 the other guards take', async () => {
        await deleteSkill('sk1', { confirmedBreaking: true });
        expect(del).toHaveBeenCalledWith('/api/skills/sk1', { query: { confirmBreaking: 'true' } });
    });
});

describe('the AI calls — one model call per tap', () => {
    it('drafts from a sentence without retrying, and reads the proposal', async () => {
        post.mockResolvedValue({ draft: { name: 'Quotes', steps: [{ id: 'a', text: 'Look up' }], outputSchema: 'nope' } });
        const proposal = await draftSkill('Answer quote questions');
        expect(post).toHaveBeenCalledWith('/api/skills/ai/draft', { sentence: 'Answer quote questions' }, { retry: false, timeoutMs: 90_000 });
        expect(proposal?.name).toBe('Quotes');
        expect(proposal?.outputSchema).toBeUndefined();
    });

    it('answers null when the model produced no skill', async () => {
        post.mockResolvedValue({});
        expect(await draftSkill('x')).toBeNull();
    });

    it('improves and adopts the STORED row', async () => {
        post.mockResolvedValue({ skill: { id: 'sk1', name: 'Better', canEdit: true } });
        const stored = await improveSkill('sk1');
        expect(post).toHaveBeenCalledWith('/api/skills/sk1/ai/improve', { note: '' }, { retry: false, timeoutMs: 90_000 });
        expect(stored?.name).toBe('Better');
        expect(stored?.steps).toEqual([]);
    });
});

describe('usage reads', () => {
    it('keeps a summary entry the server sent and nothing else', async () => {
        get.mockResolvedValue({ summary: { sk1: { agents: '2', automations: 1, lastUsedAt: null }, bad: 3 } });
        const summary = await getSkillUsageSummary();
        expect(summary).toEqual({ sk1: { agents: 2, automations: 1, lastUsedAt: null, automationsUnchecked: undefined } });
        expect(summary.sk2).toBeUndefined();
    });

    it('reads the used-by rows and the kinds nobody could check', async () => {
        get.mockResolvedValue({ usage: [{ kind: 'agent', id: 7, title: 'Sales bot', role: 'chat' }, null], unchecked: ['automation'] });
        const answer = await getSkillUsage('sk1');
        expect(get).toHaveBeenCalledWith('/api/skills/sk1/usage', { signal: undefined });
        expect(answer.usage).toHaveLength(1);
        expect(answer.usage[0]).toMatchObject({ kind: 'agent', id: '7', title: 'Sales bot', role: 'chat' });
        expect(answer.unchecked).toEqual(['automation']);
    });
});
