import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { UsageRecord } from '../shared';
import { ConversationsTable } from './ConversationsTable';

// GET /api/usage/by-conversation answers the newest first, with the period's
// cost per conversation as `total_cost` (a pg SUM, so it may be a string).
const ROWS = [
    { conversation_id: 'c-new-cheap-0001', agent_name: 'Cheap helper', agent_id: 'a1', calls: 1, total_tokens: 10, total_cost: '0.01', models_used: 'openai/gpt-x', sources_used: 'direct_chat' },
    { conversation_id: 'c-old-pricey-002', agent_name: 'Pricey helper', agent_id: 'a2', calls: 4, total_tokens: 900, total_cost: 2.5, models_used: 'anthropic/claude-x, openai/gpt-x', sources_used: 'agent' },
] as unknown as UsageRecord[];

const NO_FILTERS = { user: null, agent: null, model: null, source: null };

function agentsInOrder(): string[] {
    const table = screen.getByRole('table', { name: 'Conversations' });
    return within(table).queryAllByText(/helper$/).map(n => n.textContent ?? '');
}

describe('ConversationsTable', () => {
    it('shows each conversation\'s cost and lists the most expensive first', () => {
        render(<ConversationsTable rows={ROWS} filters={NO_FILTERS} />);
        expect(agentsInOrder()).toEqual(['Pricey helper', 'Cheap helper']);
        expect(screen.getByText('€2.50')).toBeInTheDocument();
        expect(screen.getByText('€0.010')).toBeInTheDocument();
    });

    it('follows the report\'s agent, model and source filters', () => {
        const { rerender } = render(<ConversationsTable rows={ROWS} filters={{ ...NO_FILTERS, agent: 'a1' }} />);
        expect(agentsInOrder()).toEqual(['Cheap helper']);
        rerender(<ConversationsTable rows={ROWS} filters={{ ...NO_FILTERS, model: 'anthropic/claude-x' }} />);
        expect(agentsInOrder()).toEqual(['Pricey helper']);
        rerender(<ConversationsTable rows={ROWS} filters={{ ...NO_FILTERS, source: 'direct_chat' }} />);
        expect(agentsInOrder()).toEqual(['Cheap helper']);
    });

    it('says the conversations cannot be narrowed to one member instead of showing everyone\'s', () => {
        render(<ConversationsTable rows={ROWS} filters={{ ...NO_FILTERS, user: 'u1' }} />);
        expect(screen.queryByRole('table', { name: 'Conversations' })).toBeNull();
        expect(screen.getByText(/not split by member/)).toBeInTheDocument();
    });
});
