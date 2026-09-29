/**
 * The bubble both builders share. What is pinned here is the one rule that is
 * easy to get wrong: a playbook's BRIEF arrives as a user message and has to
 * read as the document it is, while a message a person typed keeps its line
 * breaks (markdown would swallow a single newline — there is no remark-breaks).
 */
import { render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import MessageBubble, { readsAsMarkdown } from './MessageBubble';

vi.mock('../../../../hooks/useTranslation', () => ({
    useTranslation: () => ({ t: (_k, d) => d }),
}));

const BRIEF = [
    '## Build an automation',
    'I start it by hand: manual trigger, no schedule, no file event.',
    '',
    '1. `nextcloud_list_files` on folder "/Invoices".',
    '2. `nextcloud_read_file` for each item of step 1.',
].join('\n');

describe('readsAsMarkdown', () => {
    it('sees a document, not a sentence', () => {
        expect(readsAsMarkdown(BRIEF)).toBe(true);
        expect(readsAsMarkdown('- one\n- two')).toBe(true);
        expect(readsAsMarkdown('```js\nx\n```')).toBe(true);
        expect(readsAsMarkdown('Add a screen for the totals, please')).toBe(false);
        expect(readsAsMarkdown('do this\nthen that')).toBe(false);
        expect(readsAsMarkdown('10. minutes is fine')).toBe(true);   // ambiguous, and a list is the safer read
        expect(readsAsMarkdown(undefined)).toBe(false);
    });
});

describe('MessageBubble', () => {
    it('renders a brief as markdown: the heading is a heading and the steps are a list', () => {
        const { container } = render(<MessageBubble msg={{ role: 'user', content: BRIEF }} />);
        expect(container.querySelector('h2')).toBeTruthy();
        expect(container.querySelectorAll('ol li').length).toBe(2);
        expect(container.querySelector('code')).toBeTruthy();
        // A rendered brief must not ALSO preserve whitespace — that double-spaces it.
        expect(container.querySelector('.whitespace-pre-wrap')).toBeNull();
    });

    it('leaves a typed message alone, line breaks and all', () => {
        const { container } = render(<MessageBubble msg={{ role: 'user', content: 'do this\nthen that' }} />);
        expect(container.querySelector('.whitespace-pre-wrap')).toBeTruthy();
        expect(container.querySelector('h1, h2, ol, ul')).toBeNull();
        expect(screen.getByText(/do this/)).toBeTruthy();
    });

    it('still renders the assistant as markdown', () => {
        const { container } = render(<MessageBubble msg={{ role: 'assistant', content: '## Done\n- a screen' }} activity={null} />);
        expect(container.querySelector('h2')).toBeTruthy();
        expect(container.querySelectorAll('ul li').length).toBe(1);
    });

    it('hands the test run in flight to the activity list only while the message streams', () => {
        const toolCalls = [{ name: 'builder_summarise', arguments: {}, result: { summary: 's' } }];
        const liveRun = { label: 'Read file content', done: 1, total: 4 };
        const { container: streaming } = render(
            <MessageBubble msg={{ role: 'assistant', content: '', toolCalls, isStreaming: true }} liveRun={liveRun} />,
        );
        expect(streaming.textContent).toContain('Testing the routine…');
        // The turn is over: the run under it is the canvas's story now.
        const { container: settled } = render(
            <MessageBubble msg={{ role: 'assistant', content: '', toolCalls, isStreaming: false }} liveRun={liveRun} />,
        );
        expect(settled.textContent).not.toContain('Testing the routine…');
    });
});
