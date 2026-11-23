// An opened run: the review it asked for and how it was handled, what it used (a refused call stands out with its
// reason in plain words), the skills, and the way into its conversation.
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import CoworkRunDetails from './CoworkRunDetails';
import type { CoworkRun } from '@/api/cowork.types';
import type { TranslateFn } from '@/hooks/useTranslation';

/** The English fallback with its {params} filled in, as the real hook answers without a dictionary. */
const t: TranslateFn = (_key, fallback, params) => {
    const text = typeof fallback === 'string' ? fallback : '';
    const values = (typeof fallback === 'object' ? fallback : params) || {};
    return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in values ? String((values as Record<string, unknown>)[k]) : m));
};

const run = (over: Partial<CoworkRun> = {}): CoworkRun => ({
    id: 'r1', status: 'success', startedAt: '2026-11-03T09:00:00.000Z', conversationId: 'conv-1',
    activity: {
        tools: [
            { name: 'outlook_read', app: 'outlook', ok: 2, failed: 0, refused: 0, reasons: [] },
            { name: 'outlook_create_draft', app: 'outlook', ok: 0, failed: 0, refused: 2, reasons: ['privacy_shield'] },
        ],
        skills: [{ id: 's1', name: 'Tone of voice', how: 'static' }, { id: 's2', name: 'Offer letter', how: 'activated' }],
        toolCalls: 4,
    },
    ...over,
});

afterEach(() => { vi.restoreAllMocks(); });

describe('CoworkRunDetails', () => {
    it('a call the Privacy Shield refused stands out, first, with the reason in plain words', () => {
        render(<CoworkRunDetails run={run()} agentId="a1" title="Mail desk" t={t} />);
        const tools = screen.getAllByTestId('cowork-run-tool');
        expect(tools[0]).toHaveAttribute('data-refused', 'true');
        expect(within(tools[0]).getByText('outlook_create_draft')).toBeInTheDocument();
        expect(within(tools[0]).getByText(/2× refused/)).toBeInTheDocument();
        expect(within(tools[0]).getByText(/Stopped by the Privacy Shield/)).toBeInTheDocument();
        expect(within(tools[1]).getByText(/2× done/)).toBeInTheDocument();
        expect(tools[1]).not.toHaveAttribute('data-refused');
    });

    it('says what the run cost in AI and in how many model calls; a run without a model call says nothing about it', () => {
        const { unmount } = render(<CoworkRunDetails run={run({ cost: { byCurrency: { EUR: 0.0421 }, calls: 3 } })} agentId="a1" title="Supplier radar" t={t} />);
        expect(screen.getByTestId('cowork-run-cost-line').textContent).toBe('AI: €0.04, 3 model calls');
        unmount();
        render(<CoworkRunDetails run={run({ cost: null })} agentId="a1" title="Supplier radar" t={t} />);
        expect(screen.queryByTestId('cowork-run-cost-line')).toBeNull();
    });

    it('names the skills that took part and how', () => {
        render(<CoworkRunDetails run={run()} agentId="a1" title="Mail desk" t={t} />);
        expect(screen.getByText('Skills: Tone of voice (always on), Offer letter (loaded when needed)')).toBeInTheDocument();
    });

    it('a run from before activity was kept says nothing about it', () => {
        render(<CoworkRunDetails run={run({ activity: null })} agentId="a1" title="Mail desk" t={t} />);
        expect(screen.queryByTestId('cowork-run-activity')).toBeNull();
    });

    it('the review it asked for and who handled it stay in the history', () => {
        render(<CoworkRunDetails
            run={run({ status: 'needs_review', review: { reason: 'No price agreed.', question: 'Which price?', summary: null, resolution: 'done_myself', resolvedBy: 'u1', resolvedAt: '2026-11-03T10:00:00.000Z' } })}
            agentId="a1" title="Mail desk" t={t}
        />);
        const review = screen.getByTestId('cowork-run-review');
        expect(within(review).getByText('No price agreed.')).toBeInTheDocument();
        expect(within(review).getByText(/You handled it yourself on/)).toBeInTheDocument();
    });

    it('opens the run\'s conversation in the agent\'s chat; without an agent there is nothing to open', async () => {
        const seen: CustomEvent[] = [];
        const listener = (e: Event) => { seen.push(e as CustomEvent); };
        window.addEventListener('openDirectChatWithContext', listener);
        try {
            const { unmount } = render(<CoworkRunDetails run={run()} agentId="a1" title="Mail desk" t={t} />);
            await userEvent.setup().click(screen.getByTestId('cowork-run-open-conversation'));
            expect(seen[0].detail).toMatchObject({ agentId: 'a1', conversationId: 'conv-1', surface: 'cowork' });
            unmount();
            render(<CoworkRunDetails run={run()} agentId={null} title="Mail desk" t={t} />);
            expect(screen.queryByTestId('cowork-run-open-conversation')).toBeNull();
        } finally {
            window.removeEventListener('openDirectChatWithContext', listener);
        }
    });
});
