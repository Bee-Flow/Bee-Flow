import { afterEach, describe, expect, it, vi } from 'vitest';
import { jsonResponse, stubRecordingFetch, type RecordedCall } from '@/test/recordingFetch';
import { attachSkillToAgent, copySkill, listOwnAgents } from './skillStoreApi';

/** Answers per request, on the network seam (no module mocked). */
function serve(agent: Record<string, unknown>, agents: unknown[] = []) {
    return stubRecordingFetch(({ method, url }: RecordedCall) => {
        if (method === 'GET' && url.includes('/agents/a1')) return jsonResponse(agent);
        if (method === 'GET' && url.endsWith('/agents')) return jsonResponse(agents);
        if (method === 'PUT') return jsonResponse({ id: 'a1' });
        if (method === 'POST' && url.includes('/copy')) return jsonResponse({ id: 'copy' }, 201);
        return jsonResponse({}, 404);
    });
}

describe('skillStoreApi', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('attaches through the agent save: the draft config plus the skill, at the rev it was read', async () => {
        const calls = serve({ id: 'a1', can_edit: true, rev: 7, published_version: 2, config: { attachedSkillIds: ['x'], tone: 'brief' } });
        expect(await attachSkillToAgent('a1', 'sk1')).toEqual({ result: 'attached', published: true });
        expect(calls[0].url).toContain('/agents/a1?draft=1');
        const put = calls.find((c) => c.method === 'PUT');
        expect(put?.url).toContain('/agents/a1');
        expect(put?.body).toEqual({ config: { attachedSkillIds: ['x', 'sk1'], tone: 'brief' }, baseVersion: 7 });
    });

    it('writes nothing to an agent this account may not edit, or one that has the skill already', async () => {
        let calls = serve({ id: 'a1', can_edit: false, config: {} });
        expect((await attachSkillToAgent('a1', 'sk1')).result).toBe('not_editable');
        expect(calls.some((c) => c.method === 'PUT')).toBe(false);
        vi.unstubAllGlobals();
        calls = serve({ id: 'a1', can_edit: true, config: { attachedSkillIds: ['sk1'] } });
        expect((await attachSkillToAgent('a1', 'sk1')).result).toBe('already');
        expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    });

    it('lists only your own agents, and copies with an optional name', async () => {
        const calls = serve({}, [{ id: 'a', owner_id: 'u1' }, { id: 's', owner_id: 'system' }, { id: 'b', owner_id: 'u2' }]);
        expect((await listOwnAgents('u1')).map((a) => a.id)).toEqual(['a']);
        await copySkill('sk1', 'Mine');
        const post = calls.find((c) => c.method === 'POST');
        expect(post?.url).toContain('/api/skills/sk1/copy');
        expect(post?.body).toEqual({ name: 'Mine' });
    });
});
