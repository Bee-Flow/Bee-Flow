import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ThinkingPanel } from './ThinkingPanel';
import type { ChatMessage } from './messageTypes';

/** A finished thinking run that took `ms`. */
const thought = (ms: number): ChatMessage => ({
    id: 'a1',
    role: 'assistant',
    content: '',
    thinkingStartedAt: 1000,
    thinkingEndedAt: 1000 + ms,
    thinkingParts: [{ id: 'p1', text: 'Weighing the options.', startedAt: 1000, endedAt: 1000 + ms }],
} as ChatMessage);

describe('ThinkingPanel duration', () => {
    it('carries a rounded-up second into the minute instead of showing "1m 60s"', () => {
        const { rerender } = render(<ThinkingPanel msg={thought(119_600)} />);
        expect(screen.getByText('Thought for 2m 0s')).toBeTruthy();
        rerender(<ThinkingPanel msg={thought(59_600)} />);
        expect(screen.getByText('Thought for 1m 0s')).toBeTruthy();
    });

    it('keeps tenths under ten seconds and whole seconds above', () => {
        const { rerender } = render(<ThinkingPanel msg={thought(4_240)} />);
        expect(screen.getByText('Thought for 4.2s')).toBeTruthy();
        rerender(<ThinkingPanel msg={thought(75_000)} />);
        expect(screen.getByText('Thought for 1m 15s')).toBeTruthy();
    });
});
