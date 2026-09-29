import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import React from 'react';
import BuilderThinkingBlock from './BuilderThinkingBlock';

const msg = (text, { streaming = true, ended = null } = {}) => ({
    isStreaming: streaming,
    thinkingStartedAt: 1000,
    ...(ended ? { thinkingEndedAt: ended } : {}),
    thinkingParts: [{ id: 'p1', text, startedAt: 1000, endedAt: streaming ? null : 2000 }],
});

const REASONING = 'Let\'s break it down:\n- Trigger: Schedule, `0 8 * * 1-5`.\n\nWait, the fetch might fail. I should wire an error branch.';

/**
 * A FINISHED turn, which is the state that renders open by default.
 *
 * The open/shut interaction itself is not reachable here: React 19's onToggle
 * on <details> is not driven by a synthetic toggle event under jsdom (verified
 * both via fireEvent.toggle and a hand-dispatched bubbling event), and jsdom
 * flips the `open` attribute on click without firing anything — so asserting
 * `details.open` after a click passes while proving nothing but jsdom's own
 * behaviour. These tests therefore drive the two states through props, which
 * is also how a real turn moves between them.
 */
const finished = (text) => msg(text, { streaming: false, ended: 5200 });

// A streaming turn carrying the narrated line: the server's small narrator
// model sends one phrase about the CURRENT thoughts as `thinkingSummary`. The
// owner's reason for preferring it over the heuristic is that the raw last
// line of the reasoning says little to most users.
const narrated = (text, summaryText, extra = {}) => ({
    ...msg(text),
    thinkingSummary: { text: summaryText, partId: 'p1', seq: 3, at: 1500, ...extra },
});

describe('BuilderThinkingBlock', () => {
    it('stays collapsed while streaming', () => {
        const { container } = render(<BuilderThinkingBlock msg={msg(REASONING)} />);
        expect(container.querySelector('details').open).toBe(false);
        // And the body is not merely hidden — it is not rendered at all, so a
        // long transcript costs nothing on every streamed token.
        expect(container.querySelectorAll('ul')).toHaveLength(0);
    });

    it('shows what it is thinking about right now, in one line', () => {
        render(<BuilderThinkingBlock msg={msg(REASONING)} />);
        expect(screen.getByText(/Wait, the fetch might fail/)).toBeTruthy();
    });

    it('renders the reasoning as markdown when it is open', () => {
        const { container } = render(<BuilderThinkingBlock msg={finished(REASONING)} />);
        expect(container.querySelectorAll('li').length).toBeGreaterThan(0);
        expect(container.querySelector('code').textContent).toBe('0 8 * * 1-5');
        expect(container.textContent).not.toContain('`');
    });

    it('re-renders the body as more text arrives while open', () => {
        // The memo is keyed on the text, so a growing transcript must reach the
        // screen rather than freeze on the first chunk.
        const { container, rerender } = render(<BuilderThinkingBlock msg={finished('Working on it now.')} />);
        expect(container.textContent).toContain('Working on it now.');
        rerender(<BuilderThinkingBlock msg={finished('Working on it now. And a bit more.')} />);
        expect(container.textContent).toContain('And a bit more.');
    });

    it('sizes the live line explicitly, below the label it qualifies', () => {
        // It shipped with no size class at all, so it inherited the chat
        // column's base and rendered larger than the "Thinking…" label beside
        // it. Anything in a <summary> must state its own size: the element
        // sets none, so "unstyled" means "as big as the page".
        const { container } = render(<BuilderThinkingBlock msg={msg('Now filtering for high priority tickets.')} />);
        const line = [...container.querySelectorAll('summary span')]
            .find(el => el.textContent.startsWith('Now filtering'));
        expect(line).toBeTruthy();
        expect(line.className).toMatch(/text-\[11px\]/);
    });

    it('the live line tracks the newest reasoning while shut', () => {
        const { container, rerender } = render(<BuilderThinkingBlock msg={msg('Fetching the tickets first.')} />);
        expect(container.textContent).toContain('Fetching the tickets first.');
        rerender(<BuilderThinkingBlock msg={msg('Fetching the tickets first.\nNow filtering for high priority.')} />);
        expect(container.textContent).toContain('Now filtering for high priority.');
    });

    it('reports elapsed time while it is still thinking', () => {
        render(<BuilderThinkingBlock msg={msg('Considering the options here.')} />);
        expect(screen.getByText(/Thinking…/)).toBeTruthy();
    });

    it('reports the duration once it has finished', () => {
        render(<BuilderThinkingBlock msg={msg('Done.', { streaming: false, ended: 5200 })} />);
        expect(screen.getByText(/Thought for 4\.2s/)).toBeTruthy();
    });

    it('renders nothing when there is no reasoning and nothing running', () => {
        const { container } = render(<BuilderThinkingBlock msg={{ isStreaming: false, thinkingParts: [] }} />);
        expect(container.firstChild).toBeNull();
    });

    it('prefers the narrated summary over the heuristic while streaming and shut', () => {
        const { container } = render(<BuilderThinkingBlock msg={narrated(REASONING, 'Wiring the error branch')} />);
        expect(container.querySelector('details').open).toBe(false);
        const line = [...container.querySelectorAll('summary span')]
            .find(el => el.textContent === 'Wiring the error branch');
        expect(line).toBeTruthy();
        // Same slot, same size as the heuristic line it replaces.
        expect(line.className).toMatch(/text-\[11px\]/);
        expect(line.getAttribute('title')).toBe('Wiring the error branch');
        // The raw reasoning does not appear beside it — that is the whole point.
        expect(container.textContent).not.toContain('Wait, the fetch might fail');
    });

    it('tracks newer phrases as they arrive', () => {
        const { container, rerender } = render(<BuilderThinkingBlock msg={narrated(REASONING, 'Choosing the schedule', { seq: 1 })} />);
        expect(container.textContent).toContain('Choosing the schedule');
        rerender(<BuilderThinkingBlock msg={narrated(REASONING, 'Wiring the error branch', { seq: 2 })} />);
        expect(container.textContent).toContain('Wiring the error branch');
        expect(container.textContent).not.toContain('Choosing the schedule');
    });

    it('falls back to the heuristic when the summary is absent or empty', () => {
        // No field at all — a turn with narration off.
        const { container, rerender } = render(<BuilderThinkingBlock msg={{ ...msg(REASONING), thinkingSummary: null }} />);
        expect(container.textContent).toContain('Wait, the fetch might fail');
        // An empty phrase — the narrator sanitised its answer down to nothing.
        rerender(<BuilderThinkingBlock msg={narrated(REASONING, '')} />);
        expect(container.textContent).toContain('Wait, the fetch might fail');
        // Whitespace is empty too.
        rerender(<BuilderThinkingBlock msg={narrated(REASONING, '   ')} />);
        expect(container.textContent).toContain('Wait, the fetch might fail');
        // A non-string is not a phrase.
        rerender(<BuilderThinkingBlock msg={narrated(REASONING, 42)} />);
        expect(container.textContent).toContain('Wait, the fetch might fail');
    });

    it('a finished turn shows the duration, not the summary', () => {
        // Once the stream ends the row reads "Thought for Xs" as before; the
        // narrated phrase was about a moment that has passed.
        const { container } = render(<BuilderThinkingBlock msg={{ ...finished(REASONING), thinkingSummary: { text: 'Checking the HTTP response shape', seq: 3 } }} />);
        expect(screen.getByText(/Thought for 4\.2s/)).toBeTruthy();
        expect(container.textContent).not.toContain('Checking the HTTP response shape');
    });
});
