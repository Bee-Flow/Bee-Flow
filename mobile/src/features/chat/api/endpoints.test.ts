/**
 * The chat payloads, read through the allow-list.
 *
 * A conversation is the payload the app can least afford to be wrong about:
 * every message it renders comes from here. The cases are the ways the
 * server's answer goes wrong without an error — a renamed field, a message
 * with a role this build does not know, a citation under the server's key
 * rather than the app's, a label row without an id.
 */

import { api } from '@/core/api/client';

import { createLabel, getConversation, getSessionSkills, listConversations, listLabels } from './endpoints';

jest.mock('@/core/api/client', () => ({
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
        // Every part the reader knows is there, empty where the turn had none;
        // the question carries no parts of an answer.
        expect(conversation?.messages[0]).toMatchObject({
            id: 'm1',
            role: 'user',
            content: 'hi',
            attachments: [{ id: undefined, name: 'a.pdf', mimeType: undefined, size: 12, uri: undefined, dataUrl: undefined }],
            parentId: null,
        });
        const question = conversation?.messages[0] as unknown as Record<string, unknown>;
        for (const part of ['thinking', 'tools', 'sources', 'images', 'drafts', 'files', 'error']) expect(question[part]).toBeUndefined();
        expect(conversation?.messages[1]).toMatchObject({
            thinking: 'hmm',
            tools: [{ id: 't1', name: 'search', status: 'done', detail: 'x' }],
            images: [{ data: 'AAA', mimeType: 'image/png' }],
            sources: [expect.objectContaining({ id: 's1', title: 'Doc', snippet: 'passage' })],
        });
    });

    it('reads an assistant turn under the names the server persists it with', async () => {
        // Shaped exactly as routes/ai/directChat/finalizeTurn.js saves it (and
        // conversationMessages.rowToMessage spreads it back out): tool steps
        // as `toolHistory`, reasoning as an ARRAY of parts, images by URL.
        // Every one of these used to vanish on reopening the chat.
        get.mockResolvedValueOnce({
            id: 'c1',
            created_at: 'a',
            updated_at: 'b',
            messages: [
                {
                    id: 'm2',
                    role: 'assistant',
                    content: 'Here is the chart.',
                    timestamp: '2026-09-24T09:00:00.000Z',
                    modelId: 'claude-opus-5',
                    thinking: [
                        { id: 'th1', text: 'First, the numbers.', startedAt: 1, endedAt: 2 },
                        { id: 'th2', text: '', startedAt: 2, endedAt: 3, redacted: true, redactedData: 'xx' },
                        { id: 'th3', text: 'Then the chart.', startedAt: 3, endedAt: 4, phase: 'final' },
                    ],
                    toolHistory: [
                        { name: 'web_search', args: { query: 'q' }, status: 'done', resultPreview: '{"ok":1}' },
                        { name: 'generate_image', status: 'error' },
                    ],
                    images: [
                        { url: '/api/storage/proxy/u1/images/a.png', mimeType: 'image/png', storageKey: 'u1/images/a.png' },
                        { data: 'AAA', mimeType: 'image/jpeg' },
                        { mimeType: 'image/png', storageKey: null },
                    ],
                },
            ],
        });
        const message = (await getConversation('c1'))?.messages[0];
        expect(message).toMatchObject({
            content: 'Here is the chart.',
            createdAt: '2026-09-24T09:00:00.000Z',
            thinking: 'First, the numbers.\n\nThen the chart.',
            tools: [
                { id: 'tool-0', name: 'web_search', status: 'done', detail: undefined },
                { id: 'tool-1', name: 'generate_image', status: 'error', detail: undefined },
            ],
            images: [
                { url: '/api/storage/proxy/u1/images/a.png', mimeType: 'image/png' },
                { data: 'AAA', mimeType: 'image/jpeg' },
            ],
        });
        // The third image had nothing to draw — no broken tile.
        expect(message?.images).toHaveLength(2);
    });

    it('reads the citations an agent turn persists as `kbSources`', async () => {
        // core/agentRuntime/finalizeTurn.js: `assistantMsg.kbSources = _kbSources`.
        get.mockResolvedValueOnce({
            id: 'c1',
            created_at: 'a',
            updated_at: 'b',
            messages: [
                { id: 'm1', role: 'assistant', content: 'x', kbSources: [{ chunkId: 7, title: 'Policy', content: 'passage' }] },
            ],
        });
        const message = (await getConversation('c1'))?.messages[0];
        expect(message?.sources).toEqual([expect.objectContaining({ id: '7', title: 'Policy', snippet: 'passage' })]);
    });

    it('flattens block content to its text instead of an empty bubble', async () => {
        // BFSF-307: a user turn with an image was persisted as provider blocks.
        get.mockResolvedValueOnce({
            id: 'c1',
            created_at: 'a',
            updated_at: 'b',
            messages: [
                {
                    id: 'm1',
                    role: 'user',
                    content: [
                        { type: 'text', text: 'What is on this photo?' },
                        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
                        { type: 'text', text: 'Be brief.' },
                    ],
                },
                { id: 'm2', role: 'assistant', content: { type: 'text', text: 'A bee.' } },
                { id: 'm3', role: 'assistant', content: { type: 'mystery' } },
            ],
        });
        const messages = (await getConversation('c1'))?.messages ?? [];
        expect(messages.map((m) => m.content)).toEqual(['What is on this photo?\n\nBe brief.', 'A bee.', '']);
    });

    it('keeps the interrupted mark the server saves on a turn that died mid-way', async () => {
        // routes/ai/directChat/interruptedTurn.js
        get.mockResolvedValueOnce({
            id: 'c1',
            created_at: 'a',
            updated_at: 'b',
            messages: [{ id: 'm1', role: 'assistant', content: '[interrupted]', interrupted: true }],
        });
        expect((await getConversation('c1'))?.messages[0]?.interrupted).toBe(true);
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
