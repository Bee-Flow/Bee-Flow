// Activity: the call log. The ledger row (GET /api/usage/recent) carries
// `timestamp` and `agent_type`; the page read `created_at` and `type`, so the
// Time and Type columns were "—" on every row. Identifiers ("direct-chat",
// "chat_title") are named, not printed.
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ActivityPage } from './ActivityPage';
import type { UsageRecord } from './shared';

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

const ROWS: UsageRecord[] = [
    { id: 1, timestamp: minutesAgo(5), agent_name: 'direct-chat', agent_type: 'chat', source: 'direct_chat', model: 'model-a', total_tokens: 1200, estimated_cost: 0.01 },
    { id: 2, timestamp: minutesAgo(10), agent_name: '', agent_type: 'chat', source: 'chat_title', model: 'model-b', total_tokens: 10, estimated_cost: 0 },
    { id: 3, timestamp: minutesAgo(20), agent_name: 'Quote request', agent_type: 'automation', source: 'automation', model: 'model-a', total_tokens: 800, estimated_cost: 0.002 },
];

describe('ActivityPage', () => {
    it('shows when each call was made, from the ledger\'s timestamp', () => {
        render(<ActivityPage recent={ROWS} />);
        const rows = screen.getAllByRole('row').filter(r => within(r).queryByText('model-a') || within(r).queryByText('model-b'));
        expect(rows).toHaveLength(3);
        for (const row of rows) expect(row.textContent).toMatch(/min/);
    });

    it('names calls and types in words, never by their identifiers', () => {
        render(<ActivityPage recent={ROWS} />);
        expect(screen.getAllByText('Direct chat').length).toBeGreaterThan(0);
        expect(screen.queryByText('direct-chat')).toBeNull();
        expect(screen.getAllByText('Direct chat: naming the conversation').length).toBeGreaterThan(0);
        expect(screen.queryByText(/chat_title/)).toBeNull();
        expect(screen.getAllByText('Automation').length).toBeGreaterThan(0);
        expect(screen.getAllByText('Chat').length).toBeGreaterThan(0);
    });
});
