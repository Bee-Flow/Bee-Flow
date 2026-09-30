/**
 * The editor's calls: the paths and bodies the web's agent builder sends,
 * none of them retried, and every answer read through the allow-list.
 */

import { api } from '@/core/api/client';

import {
    createAgent,
    getAgentDraft,
    publishAgentVersion,
    refineAgent,
    restoreAgentVersion,
    setAgentAudience,
    snapshotBeforeRefine,
    updateAgent,
} from './editorEndpoints';
import { createPayload, emptyDraft, savePayload } from '../model/draft';

jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());

const get = api.get as jest.Mock;
const post = api.post as jest.Mock;
const put = api.put as jest.Mock;
const patch = api.patch as jest.Mock;

const ROW = { id: 'a1', name: 'Desk', system_prompt: 'Help.', persona: { mode: 'free' }, published_version: 2, unpublishedChanges: '1', rev: 4, config: {} };

beforeEach(() => jest.resetAllMocks());

describe('agent editor endpoints', () => {
    it('opens the concept with ?draft=1 and reads its editor-only columns', async () => {
        get.mockResolvedValue(ROW);
        const agent = await getAgentDraft('a 1');
        expect(get).toHaveBeenCalledWith('/agents/a%201', expect.objectContaining({ query: { draft: '1' } }));
        expect(agent).toMatchObject({ system_prompt: 'Help.', persona: { mode: 'free' }, published_version: 2, unpublishedChanges: 1, rev: 4 });
    });

    it('reads a missing persona as unread, not as empty', async () => {
        get.mockResolvedValue({ ...ROW, persona: null });
        expect((await getAgentDraft('a1'))?.persona).toBeUndefined();
    });

    it('creates and saves without retrying', async () => {
        post.mockResolvedValue(ROW);
        put.mockResolvedValue(ROW);
        const draft = emptyDraft('Desk');
        await createAgent(createPayload(draft));
        expect(post).toHaveBeenCalledWith('/agents', createPayload(draft), { retry: false });
        await updateAgent('a1', savePayload(draft, 4));
        expect(put).toHaveBeenCalledWith('/agents/a1', expect.objectContaining({ baseVersion: 4 }), { retry: false });
    });

    it('publishes audience and content through their own verbs', async () => {
        patch.mockResolvedValue({ success: true });
        await setAgentAudience('a1', { isPublished: true, sharedGroups: [] });
        expect(patch).toHaveBeenCalledWith('/agents/a1/publish', { isPublished: true, sharedGroups: [] }, { retry: false });
        post.mockResolvedValue({ publishedVersion: 3 });
        expect(await publishAgentVersion('a1')).toMatchObject({ publishedVersion: 3 });
        expect(post).toHaveBeenCalledWith('/agents/a1/publish-version', undefined, { retry: false });
    });

    it('refines with a long deadline and reads the plan', async () => {
        post.mockResolvedValue({ plan: { name: 'X', skills: [{ id: null, name: 'S' }], model: 'fast' }, preserved: { model: 'tier:fast' } });
        const body = { prompt: 'p', refinement: 'r', modelTier: 'fast', plan: { name: '', description: '', avatar: '', systemPrompt: '', capabilities: [] }, current: { model: null, enabledIntegrations: [], attachedSkills: [], knowledge_base_ids: [] } };
        const answer = await refineAgent(body);
        expect(post).toHaveBeenCalledWith('/agents/wizard/refine', body, { retry: false, timeoutMs: 120_000 });
        expect(answer.plan).toMatchObject({ name: 'X', model: 'fast', skills: [{ id: null, name: 'S' }] });
        expect(answer.plan.systemPrompt).toBeUndefined();
        expect(answer.preserved).toEqual({ model: 'tier:fast', enabledIntegrations: [], attachedSkillIds: [], knowledge_base_ids: [] });
    });

    it('takes an undo point, and a failed one is null rather than an error', async () => {
        post.mockResolvedValueOnce({ id: 'v9' });
        expect(await snapshotBeforeRefine('a1')).toBe('v9');
        expect(post).toHaveBeenCalledWith('/versions/a1/pre-refine', undefined, { retry: false });
        post.mockRejectedValueOnce(new Error('403'));
        expect(await snapshotBeforeRefine('a1')).toBeNull();
        post.mockResolvedValueOnce({});
        await restoreAgentVersion('a1', 'v9');
        expect(post).toHaveBeenLastCalledWith('/versions/a1/v9/restore', undefined, { retry: false });
    });
});
