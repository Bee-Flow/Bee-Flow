import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FeedbackItem } from './feedback/feedbackModel';
import { FeedbackPage } from './FeedbackPage';

vi.mock('../../../hooks/useTranslation', () => ({
    useTranslation: () => ({
        t: (key: string, fallback?: unknown, params?: Record<string, unknown>) => {
            let s = typeof fallback === 'string' ? fallback : key;
            for (const [k, v] of Object.entries(params || {})) s = s.replace(`{${k}}`, String(v));
            return s;
        },
    }),
}));
vi.mock('../../renderers/MarkdownRenderer', () => ({ default: ({ content }: { content: string }) => <div data-testid="md">{content}</div> }));

const feedback: FeedbackItem[] = [
    { id: 'f1', rating: 'up', user_id: 'alice', comment: 'Great answer', model: 'gpt-x', conversation_snapshot: JSON.stringify([
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello **there**' },
        { role: 'tool', content: '' },
    ]) },
    { id: 'f2', rating: 'down', user_id: 'bob', comment: 'Wrong' },
];

afterEach(cleanup);

describe('FeedbackPage', () => {
    it('filters by rating and searches', async () => {
        const user = userEvent.setup();
        render(<FeedbackPage feedback={feedback} summary={{ thumbs_up: 1, thumbs_down: 1, total: 2, with_comments: 2 }} />);
        expect(screen.getByText('50% approval')).toBeTruthy();
        expect(screen.getByText('alice')).toBeTruthy();
        expect(screen.getByText('bob')).toBeTruthy();
        await user.click(screen.getByRole('button', { name: '👎 Negative' }));
        expect(screen.queryByText('alice')).toBeNull();
        await user.click(screen.getByRole('button', { name: 'All' }));
        await user.type(screen.getByPlaceholderText('Search feedback...'), 'great');
        expect(screen.getByText('alice')).toBeTruthy();
        expect(screen.queryByText('bob')).toBeNull();
    });

    it('replays the shared conversation when an entry is expanded, skipping empty messages', async () => {
        const user = userEvent.setup();
        render(<FeedbackPage feedback={feedback} summary={null} />);
        expect(screen.getByText('3 msgs')).toBeTruthy(); // counts every message, even the empty tool one
        await user.click(screen.getByText('alice'));
        expect(screen.getByText('Conversation (3 messages)')).toBeTruthy();
        expect(screen.getByText('Hi')).toBeTruthy();
        expect(screen.getByTestId('md').textContent).toBe('Hello **there**');
        await user.click(screen.getByText('bob'));
        expect(screen.getByText('No conversation shared')).toBeTruthy();
    });
});
