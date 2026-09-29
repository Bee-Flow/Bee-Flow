/**
 * The agent payloads, read through the allow-list.
 *
 * Every endpoint hands the reader whatever `res.json()` produced. The cases
 * here are the ways a server answer goes wrong without an error: a field
 * renamed away, a type changed, a row with no id, an error page that parsed
 * as JSON. Each has to become a stated default, never `undefined` in a prop.
 */

import {
    getAgent,
    getAgentConversation,
    listAgentConversations,
    listAgents,
    listAgentTools,
    listFavorites,
} from './api';
import { api } from '../../api/client';

jest.mock('../../api/client', () => ({
    api: { get: jest.fn(), post: jest.fn(), put: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));

const get = api.get as jest.Mock;

const AGENT = {
    id: 'a1',
    name: 'Support',
    description: null,
    avatar: '🐝',
    model: 'tier:standard',
    owner_id: 'u1',
    is_published: true,
    starter_prompts: '["Hi"]',
    config: { knowledge_base_ids: ['kb1'], enableGuardrails: true },
    organization_id: 'org1',
    shared_groups: ['g1'],
    rev: 3,
    can_edit: false,
    tools: ['web-search'],
    tool_params: { 'web-search': { region: { value: 'nl', fixed: true } } },
};

beforeEach(() => {
    get.mockReset();
});

describe('listAgents', () => {
    it('merges own and published rows, published winning on a collision', async () => {
        get.mockResolvedValueOnce([{ ...AGENT, name: 'Published copy' }]) // /agents/published
            .mockResolvedValueOnce([AGENT, { ...AGENT, id: 'a2', name: 'Own draft' }]); // /agents

        const agents = await listAgents();

        expect(agents.map((a) => [a.id, a.name])).toEqual([
            ['a1', 'Published copy'],
            ['a2', 'Own draft'],
        ]);
    });

    it('drops the internal owners and the rows without an id', async () => {
        get.mockResolvedValueOnce([{ ...AGENT, id: 's', owner_id: 'system' }]).mockResolvedValueOnce([
            { ...AGENT, id: 'w', owner_id: 'swarm' },
            { name: 'no id' },
            AGENT,
        ]);

        expect((await listAgents()).map((a) => a.id)).toEqual(['a1']);
    });

    it('reads an error page that parsed as JSON as no agents', async () => {
        get.mockResolvedValueOnce({ error: 'gateway' }).mockResolvedValueOnce('<html>');
        expect(await listAgents()).toEqual([]);
    });
});

describe('getAgent', () => {
    it('keeps every field the screens read, typed', async () => {
        get.mockResolvedValueOnce(AGENT);
        const agent = await getAgent('a1');
        expect(agent).toMatchObject({
            id: 'a1',
            name: 'Support',
            starter_prompts: '["Hi"]',
            config: { knowledge_base_ids: ['kb1'] },
            shared_groups: ['g1'],
            rev: 3,
            can_edit: false,
            tools: ['web-search'],
        });
        expect(agent?.tool_params).toEqual(AGENT.tool_params);
    });

    it('degrades a renamed or mistyped field to a stated default', async () => {
        get.mockResolvedValueOnce({
            id: 'a1',
            title: 'renamed away',
            config: 'not an object',
            shared_groups: 'g1',
            starter_prompts: 42,
            rev: 'three',
            tools: [1, 'ok'],
        });
        const agent = await getAgent('a1');
        expect(agent).toMatchObject({
            name: 'Untitled agent',
            config: {},
            shared_groups: [],
            starter_prompts: null,
            owner_id: '',
            is_published: false,
            tools: ['ok'],
        });
        expect(agent?.rev).toBeUndefined();
        expect(agent?.can_edit).toBeUndefined();
    });

    it('keeps a starter_prompts array as an array of strings', async () => {
        get.mockResolvedValueOnce({ ...AGENT, starter_prompts: ['one', 2, 'two'] });
        expect((await getAgent('a1'))?.starter_prompts).toEqual(['one', 'two']);
    });

    it('answers null for an empty body', async () => {
        get.mockResolvedValueOnce(null);
        expect(await getAgent('a1')).toBeNull();
    });
});

describe('the smaller lists', () => {
    it('reads tool rows and nulls non-object params', async () => {
        get.mockResolvedValueOnce([
            { componentId: 'web-search', params: { region: 'nl' } },
            { componentId: 'mail', params: 'oops' },
        ]);
        expect(await listAgentTools('a1')).toEqual([
            { componentId: 'web-search', params: { region: 'nl' } },
            { componentId: 'mail', params: null },
        ]);
    });

    it('keeps only the string ids in the favourites', async () => {
        get.mockResolvedValueOnce(['a1', 7, null, 'a2']);
        expect(await listFavorites()).toEqual(['a1', 'a2']);
        get.mockResolvedValueOnce({ favorites: ['a1'] });
        expect(await listFavorites()).toEqual([]);
    });

    it('drops conversation rows without an id and defaults the rest', async () => {
        get.mockResolvedValueOnce([
            { id: 'c1', agent_id: 'a1', user_id: 'u1', title: null, pinned: 'yes' },
            { title: 'orphan' },
        ]);
        const rows = await listAgentConversations('a1');
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ id: 'c1', title: null, created_at: '', updated_at: '' });
        expect(rows[0]?.pinned).toBeUndefined();
    });
});

describe('getAgentConversation', () => {
    it('reads the messages, defaulting an unknown role and mapping the citations', async () => {
        get.mockResolvedValueOnce({
            id: 'c1',
            agent_id: 'a1',
            user_id: 'u1',
            messages: [
                { id: 'm1', role: 'user', content: 'hi' },
                {
                    id: 'm2',
                    role: 'robot',
                    content: 'hello',
                    sources: [{ title: 'Doc', content: 'passage', score: 0.9 }],
                    tools: [{ id: 't1', name: 'search', status: 'done' }],
                },
                'junk',
            ],
        });
        const conversation = await getAgentConversation('a1', 'c1');
        expect(conversation?.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant']);
        expect(conversation?.messages[1]?.sources?.[0]).toMatchObject({
            title: 'Doc',
            snippet: 'passage',
            score: 0.9,
        });
        expect(conversation?.messages[1]?.tools).toEqual([
            { id: 't1', name: 'search', status: 'done', detail: undefined },
        ]);
        expect(conversation?.messages[2]).toMatchObject({ id: '', content: '' });
    });
});
