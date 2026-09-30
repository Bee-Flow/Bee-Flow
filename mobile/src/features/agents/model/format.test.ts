/** What an agent's raw columns mean to a reader. */

import {
    ALL,
    describeModel,
    FAVORITES,
    filterAgents,
    parseStarterPrompts,
    sortAndFilterConversations,
    toolLabel,
} from './format';
import type { Agent, AgentConversationSummary } from './types';

const agent = (id: string, name: string, extra: Partial<Agent> = {}): Agent => ({
    id,
    name,
    description: null,
    avatar: null,
    model: null,
    owner_id: 'u1',
    is_published: true,
    starter_prompts: null,
    config: {},
    organization_id: null,
    shared_groups: [],
    ...extra,
});

describe('parseStarterPrompts', () => {
    it('reads the JSON string the server sends, and a parsed array, dropping blanks', () => {
        expect(parseStarterPrompts('["Ask me", "  ", 3]')).toEqual(['Ask me']);
        expect(parseStarterPrompts(['a', ''])).toEqual(['a']);
    });

    it('costs a malformed blob its prompts, not its row', () => {
        expect(parseStarterPrompts('{bad')).toEqual([]);
        expect(parseStarterPrompts(null)).toEqual([]);
    });
});

describe('toolLabel', () => {
    it('names a tool from the catalogue, or de-slugs its id', () => {
        const catalogue = [{ id: 'web-search', name: 'Web Search', description: '', category: '' }];
        expect(toolLabel('web-search', catalogue)).toBe('Web Search');
        expect(toolLabel('http_request', catalogue)).toBe('Http Request');
    });
});

describe('describeModel', () => {
    it('reads a tier as a tier and nothing as the org default', () => {
        expect(describeModel(null)).toBe('Your organisation’s default');
        expect(describeModel('tier:custom:deep_research')).toBe('Chosen per message — deep research tier');
        expect(describeModel('claude-opus-5')).toBe('claude-opus-5');
    });
});

describe('filterAgents', () => {
    const agents = [
        agent('1', 'Legal helper', { description: 'contracts', category_id: 'c1' }),
        agent('2', 'Sales coach', { category_id: 'c2' }),
    ];

    it('searches name and description, and filters by category or favourites', () => {
        expect(filterAgents(agents, 'CONTRACT', ALL, new Set()).map((a) => a.id)).toEqual(['1']);
        expect(filterAgents(agents, '', 'c2', new Set()).map((a) => a.id)).toEqual(['2']);
        expect(filterAgents(agents, '', FAVORITES, new Set(['1'])).map((a) => a.id)).toEqual(['1']);
    });
});

describe('sortAndFilterConversations', () => {
    const row = (id: string, updated: string, pinned = false): AgentConversationSummary => ({
        id,
        agent_id: 'a',
        user_id: 'u',
        title: `Chat ${id}`,
        pinned,
        created_at: updated,
        updated_at: updated,
    });

    it('puts pinned first, then newest, and searches titles', () => {
        const rows = [row('old', '2026-01-01'), row('new', '2026-02-01'), row('pin', '2025-01-01', true)];
        expect(sortAndFilterConversations(rows, '').map((r) => r.id)).toEqual(['pin', 'new', 'old']);
        expect(sortAndFilterConversations(rows, 'chat n').map((r) => r.id)).toEqual(['new']);
    });
});
