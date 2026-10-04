/**
 * De kaartvoet van een agent — de WOORDEN.
 *
 * Wat hier op het spel staat is niet de opmaak maar de zin. Drie dingen die
 * een screenshot niet vangt en een assertie wel:
 *
 *   • enkelvoud en meervoud komen uit een SLEUTELPAAR, met de ternary om de
 *     sleutel (nOf → `<key>` / `<key>_plural`). "1 conversations" is precies
 *     het soort fout dat een zorgvuldig product slordig laat lijken, en
 *     "conversation(s)" is geen oplossing maar een vertaler die niets kan;
 *   • een telling die niet gelezen kon worden krijgt WOORDEN. Er mag dan geen
 *     enkel cijfer op die regel staan — een nul zou een bewering zijn die
 *     niemand heeft gedaan;
 *   • de waarschuwing staat er alleen. Ze verdringt de tellingen, want zij is
 *     de enige van de drie vormen die om iets vraagt.
 *
 * Draaien: cd agent-hub && ./node_modules/.bin/vitest run src/components/agents/AgentStudio/AgentCardFooter.test.jsx
 */
import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, afterEach, vi } from 'vitest';

// Eigen factory in plaats van de gedeelde stub: die geeft de fallback terug
// ZONDER `{count}` in te vullen, en dan zou elke assertie hieronder over een
// letterlijke "{count} conversations" gaan. Dit is de provider-loze tak van de
// echte hook, inclusief interpolatie.
vi.mock('../../../hooks/useTranslation', () => ({
    default: () => ({
        t: (key, fallbackOrParams, paramsArg) => {
            const hasFallback = typeof fallbackOrParams === 'string';
            const params = hasFallback ? paramsArg : fallbackOrParams;
            let value = hasFallback ? fallbackOrParams : key;
            if (params && typeof params === 'object') {
                for (const [k, v] of Object.entries(params)) {
                    value = value.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
                }
            }
            return value;
        },
    }),
}));

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
        expect(el.getAttribute('style')).toContain('var(--warning)');
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
        // Die route rekent geen tellingen uit en draagt het veld dus niet. "The
        // conversation count could not be read" zou daar beweren dat er iets
        // misging.
        const { stats: _stats, ...rest } = agent();
        const { container } = render(<AgentCardFooter agent={rest} viewerId="u1" />);
        expect(screen.queryByTestId('agent-card-footer')).toBeNull();
        expect(container.textContent).toBe('');
    });
});

describe('"only you"', () => {
    it('says "Only you · 4 conversations" on your own unpublished agent', () => {
        // Geen "test conversations": dit product heeft een eersteklas
        // testbegrip met eigen tabellen (`agent_tests`) en een eigen teller op
        // het Test-tabblad van dezelfde agent. Twee getallen die niets met
        // elkaar te maken hebben mogen niet hetzelfde woord dragen.
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
        // `<button>` neemt alleen phrasing content; een `<p>` erin is ongeldige
        // HTML en zet blokinhoud in de a11y-boom van de knop.
        const { container } = render(<AgentCardFooter agent={agent()} viewerId="u1" />);
        expect(container.querySelector('p')).toBeNull();
        expect(footer().tagName).toBe('SPAN');
    });
});
