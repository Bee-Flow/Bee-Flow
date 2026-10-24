/**
 * The card footer of an agent — the WORDS.
 *
 * What is at stake here is not the layout but the sentence. Three things that a screenshot does not catch and an assertion does:
 *
 *   • singular and plural come from a KEY PAIR, with the ternary around the key (nOf → `<key>` / `<key>_plural`). "1 conversations" is exactly the kind of error that a careful product lets slip, and "conversation(s)" is not a solution but a translator that cannot do anything;
 *   • a count that could not be read gets WORDS. There may be no single digit on that line — a zero would be a claim that nobody has made;
 *   • the warning stands alone. It displaces the counts, because it is the only one of the three forms that asks for something.
 *
 * Run: cd agent-hub && ./node_modules/.bin/vitest run src/components/agents/AgentStudio/AgentCardFooter.test.jsx
 */
import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, afterEach, vi } from 'vitest';

// The shared params mock fills in `{count}`, so the assertions below see real interpolation.
vi.mock('../../../hooks/useTranslation', () => import('@/test/useTranslationParamsMock'));

import AgentCardFooter from './AgentCardFooter';

afterEach(cleanup);

const agent = (over = {}) => ({
    id: 'a1',
    owner_id: 'u1',
    is_published: true,
    published_version: 0,
    stats: { conversationCount: 312, userCount: 7, othersConversationCount: 300 },
    grounding: { kb: true, tables: false, verdict: 'grounded' },
    ...over,
});

const footer = () => screen.getByTestId('agent-card-footer');

describe('the counted line', () => {
    it('says "312 conversations · also in 2 automations, 1 app"', () => {
        render(<AgentCardFooter agent={agent({
            usage: { counts: { automation: 2, app: 1 }, partial: [] },
        })} viewerId="u1" />);
        expect(footer().textContent).toBe('312 conversations · also in 2 automations, 1 app');
    });

    it('uses the SINGULAR key for one — not "1 conversations"', () => {
        render(<AgentCardFooter agent={agent({
            stats: { conversationCount: 1, userCount: 1 },
            usage: { counts: { automation: 1, app: 1 }, partial: [] },
        })} viewerId="u1" />);
        expect(footer().textContent).toBe('1 conversation · also in 1 automation, 1 app');
    });

    it('names the kinds nobody could check instead of counting them as none', () => {
        render(<AgentCardFooter agent={agent({
            usage: { counts: { automation: 2 }, partial: ['app', 'webpage'] },
        })} viewerId="u1" />);
        expect(footer().textContent)
            .toBe('312 conversations · also in 2 automations · could not check: Apps, Webpages');
    });

    it('says nothing about used-by when ?usage=1 was never asked', () => {
        render(<AgentCardFooter agent={agent()} viewerId="u1" />);
        expect(footer().textContent).toBe('312 conversations');
    });
});

describe('a count that could not be read', () => {
    it('gets words, and NOT a single digit on the line', () => {
        render(<AgentCardFooter agent={agent({ stats: null })} viewerId="u1" />);
        const text = footer().textContent;
        expect(text).toBe('The conversation count could not be read');
        expect(text).not.toMatch(/\d/);
    });

    it('keeps saying it beside a used-by half that DID answer', () => {
        render(<AgentCardFooter agent={agent({
            stats: null,
            usage: { counts: { app: 1 }, partial: [] },
        })} viewerId="u1" />);
        expect(footer().textContent).toBe('The conversation count could not be read · also in 1 app');
    });

    it('is not the same sentence as a genuine zero', () => {
        render(<AgentCardFooter agent={agent({ stats: { conversationCount: 0, userCount: 0 } })} viewerId="u1" />);
        expect(footer().textContent).toBe('0 conversations');
    });
});

describe('the warning', () => {
    it('replaces the line entirely and carries the warning colour', () => {
        render(<AgentCardFooter agent={agent({
            stats: { conversationCount: 312, userCount: 7 },
            usage: { counts: { automation: 2 }, partial: [] },
            grounding: { kb: false, tables: false, verdict: 'ungrounded' },
        })} viewerId="u1" />);
        const el = footer();
        expect(el.dataset.variant).toBe('ungrounded');
        expect(el.textContent).toBe('Answers from memory — connect a knowledge base');
        expect(el.textContent).not.toMatch(/312|automation/);
        expect(el.className).toContain('text-[var(--warning)]');
    });

    it('does not appear when the server could not establish the verdict', () => {
        render(<AgentCardFooter agent={agent({
            grounding: { kb: null, tables: false, verdict: null },
        })} viewerId="u1" />);
        expect(footer().textContent).toBe('312 conversations');
    });
});

describe('nothing to say is nothing said', () => {
    it('renders no footer at all for a row that carries no counts (/agents/system)', () => {
        // That route calculates no counts and does not carry the field. "The conversation count could not be read" would claim there that something went wrong.
        const { stats: _stats, ...rest } = agent();
        const { container } = render(<AgentCardFooter agent={rest} viewerId="u1" />);
        expect(screen.queryByTestId('agent-card-footer')).toBeNull();
        expect(container.textContent).toBe('');
    });
});

describe('"only you"', () => {
    it('says "Only you · 4 conversations" on your own unpublished agent', () => {
        // Not "test conversations": this product has a first-class notion of testing, with its own tables (`agent_tests`) and its own counter on the Test tab of the same agent. Two numbers that have nothing to do with each other may not carry the same word.
        render(<AgentCardFooter agent={agent({
            is_published: false,
            stats: { conversationCount: 4, userCount: 1, othersConversationCount: 0 },
        })} viewerId="u1" />);
        expect(footer().textContent).toBe('Only you · 4 conversations');
    });

    it('uses the singular key for one conversation', () => {
        render(<AgentCardFooter agent={agent({
            is_published: false,
            stats: { conversationCount: 1, userCount: 1, othersConversationCount: 0 },
        })} viewerId="u1" />);
        expect(footer().textContent).toBe('Only you · 1 conversation');
    });

    it('drops the claim when the conversations are somebody ELSE\'s', () => {
        render(<AgentCardFooter agent={agent({
            is_published: false,
            stats: { conversationCount: 40, userCount: 1, othersConversationCount: 40 },
        })} viewerId="u1" />);
        expect(footer().textContent).toBe('40 conversations');
    });

    it('drops to the neutral line on a colleague\'s draft — the counts are not yours', () => {
        render(<AgentCardFooter agent={agent({
            is_published: false,
            stats: { conversationCount: 4, userCount: 1, othersConversationCount: 0 },
        })} viewerId="u2" />);
        expect(footer().textContent).toBe('4 conversations');
    });

    it('renders only phrasing content — it lives inside the card BUTTON', () => {
        // `<button>` only takes phrasing content; a `<p>` inside it is invalid HTML and puts block content into the button's accessibility tree.
        const { container } = render(<AgentCardFooter agent={agent()} viewerId="u1" />);
        expect(container.querySelector('p')).toBeNull();
        expect(footer().tagName).toBe('SPAN');
    });
});
