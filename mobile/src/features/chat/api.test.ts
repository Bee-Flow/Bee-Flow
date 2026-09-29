/**
 * The chat payloads, read through the allow-list.
 *
 * A conversation is the payload the app can least afford to be wrong about:
 * every message it renders comes from here. The cases are the ways the
 * server's answer goes wrong without an error — a renamed field, a message
 * with a role this build does not know, a citation under the server's key
 * rather than the app's, a label row without an id.
 */

import { createLabel, getConversation, getSessionSkills, listConversations, listLabels } from './api';
import { api } from '../../api/client';

jest.mock('../../api/client', () => ({
    api: { get: jest.fn(), post: jest.fn(), put: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));

const get = api.get as jest.Mock;
const post = api.post as jest.Mock;

beforeEach(() => {
    get.mockReset();
    post.mockReset();
});

describe('listConversations', () => {
    it('keeps the sidebar fields and drops rows without an id', async () => {
        get.mockResolvedValueOnce([
            { id: 'c1', title: 'Budget', pinned: true, labels_json: '["l1"]', created_at: 'a', updated_at: 'b', extra: 1 },
            { id: 'c2', title: null, project_id: 'p1', created_at: 'a', updated_at: 'b' },
            { title: 'orphan' },
        ]);
        const rows = await listConversations();
        expect(rows).toEqual([
            {
                id: 'c1',
                title: 'Budget',
                model_tier: null,
                project_id: null,
                shared_scope: null,
                pinned: true,
                labels_json: '["l1"]',
                created_at: 'a',
                updated_at: 'b',
            },
            expect.objectContaining({ id: 'c2', title: null, project_id: 'p1', pinned: undefined }),
        ]);
    });

    it('reads a non-array answer as no conversations', async () => {
        get.mockResolvedValueOnce({ conversations: [] });
        expect(await listConversations()).toEqual([]);
    });
});

describe('getConversation', () => {
    it('reads the messages with their tools, images and citations', async () => {
        get.mockResolvedValueOnce({
            id: 'c1',
            title: 'Budget',
            created_at: 'a',
            updated_at: 'b',
            workspace_content: '# Notes',
            messages: [
                { id: 'm1', role: 'user', content: 'hi', attachments: [{ name: 'a.pdf', size: '12' }] },
                {
                    id: 'm2',
                    role: 'assistant',
                    content: 'hello',
                    thinking: 'hmm',
                    tools: [{ id: 't1', name: 'search', status: 'weird', detail: 'x' }],
                    images: [{ data: 'AAA' }],
                    sources: [{ id: 's1', title: 'Doc', content: 'passage' }],
                },
            ],
        });
        const conversation = await getConversation('c1');
        expect(conversation?.workspace_content).toBe('# Notes');
        expect(conversation?.messages[0]).toEqual({
            id: 'm1',
            role: 'user',
            content: 'hi',
            attachments: [{ id: undefined, name: 'a.pdf', mimeType: undefined, size: 12, uri: undefined, dataUrl: undefined }],
            createdAt: undefined,
            thinking: undefined,
            tools: undefined,
            sources: undefined,
            images: undefined,
            error: undefined,
        });
        expect(conversation?.messages[1]).toMatchObject({
            thinking: 'hmm',
            tools: [{ id: 't1', name: 'search', status: 'done', detail: 'x' }],
            images: [{ data: 'AAA', mimeType: 'image/png' }],
            sources: [expect.objectContaining({ id: 's1', title: 'Doc', snippet: 'passage' })],
        });
    });

    it('defaults a role this build does not know, and a message that is not an object', async () => {
        get.mockResolvedValueOnce({ id: 'c1', created_at: 'a', updated_at: 'b', messages: [{ id: 'm1', role: 'critic', content: 'x' }, null] });
        const conversation = await getConversation('c1');
        expect(conversation?.messages.map((m) => m.role)).toEqual(['assistant', 'assistant']);
        expect(conversation?.messages[1]).toMatchObject({ id: '', content: '' });
    });

    it('answers null for an empty body and no messages for a missing list', async () => {
        get.mockResolvedValueOnce(null);
        expect(await getConversation('c1')).toBeNull();
        get.mockResolvedValueOnce({ id: 'c1', created_at: 'a', updated_at: 'b' });
        expect((await getConversation('c1'))?.messages).toEqual([]);
    });
});

describe('labels', () => {
    it('reads the label rows and the created label', async () => {
        get.mockResolvedValueOnce([{ id: 'l1', name: 'Invoices', color: '#f00' }, { id: 'l2' }, { name: 'no id' }]);
        expect(await listLabels()).toEqual([
            { id: 'l1', name: 'Invoices', color: '#f00' },
            { id: 'l2', name: 'Label', color: null },
        ]);
        post.mockResolvedValueOnce({ id: 'l3', name: 'New', color: null, owner: 'u1' });
        expect(await createLabel('New')).toEqual({ id: 'l3', name: 'New', color: null });
        post.mockResolvedValueOnce(null);
        expect(await createLabel('New')).toBeNull();
    });
});

describe('getSessionSkills', () => {
    it('reads the skills and the activated ids', async () => {
        get.mockResolvedValueOnce({
            skills: [{ id: 'sk1', name: 'Plan', description: 'd' }, { id: 'sk2' }],
            activatedSkillIds: ['sk1', 4],
            modelTier: 'standard',
        });
        expect(await getSessionSkills('c1')).toEqual({
            skills: [
                { id: 'sk1', name: 'Plan', description: 'd', instructions: undefined, workflow: undefined },
                { id: 'sk2', name: 'Skill', description: undefined, instructions: undefined, workflow: undefined },
            ],
            activatedSkillIds: ['sk1'],
            modelTier: 'standard',
        });
    });
});
