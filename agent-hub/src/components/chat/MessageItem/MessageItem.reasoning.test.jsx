import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';

import { ThinkingPanel } from './ThinkingPanel';

/**
 * The reasoning panel used to be gated on platform super-admin
 * (`user.isAdmin || permissions.includes('all')`, BFSF-253), broadcast from
 * AgentHub through `window.__beeflowShowReasoning`. An Organisation Admin
 * failed that check, so the model's reasoning was generated, streamed and
 * persisted — and then thrown away at the last step.
 *
 * It is now a `showReasoning` prop on MessageItem, defaulting to true, with the
 * public embed page the only opt-out. These tests pin the panel's own
 * behaviour, which is what decides whether anything renders at all.
 */

afterEach(() => { vi.restoreAllMocks(); });

const PART = (over = {}) => ({
    id: 'p0',
    text: 'The invoice total did not add up, so I re-checked the line items.',
    startedAt: 1000,
    endedAt: 4000,
    ...over,
});

describe('ThinkingPanel', () => {
    it('renders the reasoning it was given', () => {
        render(<ThinkingPanel msg={{ role: 'assistant', thinking: [PART()] }} />);
        expect(screen.getByText(/invoice total did not add up/)).toBeInTheDocument();
    });

    it('reads the legacy flat-string shape too', () => {
        render(<ThinkingPanel msg={{ role: 'assistant', thinking: 'plain string reasoning' }} />);
        expect(screen.getByText('plain string reasoning')).toBeInTheDocument();
    });

    it('prefers the live streaming parts over the persisted ones', () => {
        render(<ThinkingPanel msg={{
            role: 'assistant',
            thinkingParts: [PART({ text: 'live' })],
            thinking: [PART({ text: 'persisted' })],
        }} />);
        expect(screen.getByText('live')).toBeInTheDocument();
        expect(screen.queryByText('persisted')).not.toBeInTheDocument();
    });

    it('REGRESSION: a signed block with EMPTY text still renders nothing', () => {
        // display:'omitted' returns signed blocks whose `thinking` is ''. There
        // is genuinely nothing to show, so the panel must stay away rather than
        // render an empty box — the fix for that lives server-side, in asking
        // for display:'summarized'.
        const { container } = render(<ThinkingPanel msg={{ role: 'assistant', thinking: [PART({ text: '' })] }} />);
        expect(container).toBeEmptyDOMElement();
    });

    it('renders nothing when the turn carried no reasoning at all', () => {
        const { container } = render(<ThinkingPanel msg={{ role: 'assistant', content: 'hi' }} />);
        expect(container).toBeEmptyDOMElement();
    });

    it('shows a redacted block even though it has no readable text', () => {
        const { container } = render(<ThinkingPanel msg={{
            role: 'assistant',
            thinking: [PART({ text: '', redacted: true })],
        }} />);
        expect(container).not.toBeEmptyDOMElement();
    });

    it('reports how long the model thought for', () => {
        render(<ThinkingPanel msg={{
            role: 'assistant',
            thinking: [PART()],
            thinkingStartedAt: 1000,
            thinkingEndedAt: 4500,
        }} />);
        expect(screen.getByText(/Thought for 3\.5s/)).toBeInTheDocument();
    });
});
