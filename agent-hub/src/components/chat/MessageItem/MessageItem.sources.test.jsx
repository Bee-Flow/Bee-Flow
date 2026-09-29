import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';

import HowIGotThisAnswer from './HowIGotThisAnswer';
import MessageItem from './index';
import { embedSourcesAllowed } from './messageItemHelpers';

/**
 * The knowledge base does not leave the building on an embed.
 *
 * ── WHAT WAS LEAKING ────────────────────────────────────────────────
 * `/chat/:id` renders `EmbedChat` before any auth branch, on a customer's own
 * website, to visitors with no account here. It passed `showReasoning={false}`
 * and nothing else — and the "How I got this answer" panel is gated on
 * `simpleMode`, which is read from a global that only the signed-in app ever
 * sets. So on the embed it was false, the panel rendered, and with it every
 * internal document title, its headings, its page numbers, the relevance of
 * each passage and the FULL retrieved text of each one.
 *
 * The count pill goes with the panel: "7 sources" tells a stranger how much of
 * a private library sits behind the answer.
 *
 * The gate is fail-closed at every step. `showSources` defaults to false in
 * this component even though its caller defaults it to true, and the embed
 * only opens it on a literal `true` from the agent's own settings — which no
 * server sends yet, so today the answer is always no.
 */

/** One citation, as complete as the panel ever gets one. */
const SOURCE = {
    title: 'Personeelshandboek',
    section: '4.2 Bijzonder verlof',
    page: 12,
    content: 'Bij een huwelijk krijg je twee dagen vrij.',
    score: 0.91,
};

/**
 * The answer's own text deliberately shares no words with the passage below
 * it: the ANSWER may say whatever it likes on a customer's website — that is
 * what the widget is for. What must not appear is the retrieved passage.
 */
const msg = (over = {}) => ({
    role: 'assistant',
    content: 'Dat regelt het handboek.',
    kbSources: [SOURCE],
    ...over,
});

/** Everything a visitor must not be able to read off the page. */
function expectNoLeak() {
    expect(screen.queryByText(/Personeelshandboek/)).toBeNull();
    expect(screen.queryByText(/Bijzonder verlof/)).toBeNull();
    expect(screen.queryByText(/twee dagen vrij/)).toBeNull();
    expect(screen.queryByText(/source/i)).toBeNull();
}

describe('the sources panel on a public embed', () => {
    it('shows nothing when the gate is shut', () => {
        render(<HowIGotThisAnswer msg={msg()} idx={0} allMessages={[]} showSources={false} />);
        expectNoLeak();
    });

    it('shows nothing when nobody passed the gate at all', () => {
        // A future caller that forgets the prop must print nothing rather than
        // everything. The expensive mistake is only ever in one direction.
        render(<HowIGotThisAnswer msg={msg()} idx={0} allMessages={[]} />);
        expectNoLeak();
    });

    it('shows nothing for a HALF-FILLED citation either', () => {
        // A citation with no title still carries the passage, and the panel
        // groups it under "Unknown Source" and prints the text in full. A gate
        // that only checked for a title would leak exactly this one.
        render(<HowIGotThisAnswer
            msg={msg({ kbSources: [{ content: 'Bij een huwelijk krijg je twee dagen vrij.' }] })}
            idx={0} allMessages={[]} showSources={false}
        />);
        expectNoLeak();
    });

    it('shows nothing for a citation that is only a score', () => {
        render(<HowIGotThisAnswer
            msg={msg({ kbSources: [{ score: 0.4 }, {}] })}
            idx={0} allMessages={[]} showSources={false}
        />);
        expect(screen.queryByText(/source/i)).toBeNull();
    });

    it('still shows the rest of the disclosure — only the sources are held back', () => {
        // The panel also carries tool timings and the model tier, and those are
        // not what this gate is about.
        render(<HowIGotThisAnswer
            msg={msg({ toolHistory: [{ name: 'kb_search', startTime: 1000, endTime: 1400 }] })}
            idx={0} allMessages={[]} showSources={false}
        />);
        expect(screen.getByText(/How I got this answer/)).toBeInTheDocument();
        expect(screen.getByText(/1 tool/)).toBeInTheDocument();
        expectNoLeak();
    });
});

describe('the sources panel inside the product', () => {
    it('shows the passage, its heading and its page', () => {
        render(<HowIGotThisAnswer msg={msg()} idx={0} allMessages={[]} showSources />);
        expect(screen.getByText('Personeelshandboek')).toBeInTheDocument();
        expect(screen.getByText('4.2 Bijzonder verlof')).toBeInTheDocument();
        expect(screen.getByText(/twee dagen vrij/)).toBeInTheDocument();
        expect(screen.getByText('p. 12')).toBeInTheDocument();
    });

    it('counts them in the summary line, by document', () => {
        // BFSF-352: the pill used to count passages, so "10 sources" sat above
        // a handful of notes. Two passages of one document are one document.
        const other = { ...SOURCE, title: 'Reiskostenregeling', section: 'Kilometers' };
        render(<HowIGotThisAnswer msg={msg({ kbSources: [SOURCE, SOURCE, other] })} idx={0} allMessages={[]} showSources />);
        expect(screen.getByText('2 documents')).toBeInTheDocument();
    });

    it('BFSF-352: two meetings that share a title are two documents in the panel', () => {
        const meeting = (occurredAt, content) => ({ title: 'Weekly sync', occurredAt, content, score: 0.5 });
        render(<HowIGotThisAnswer
            msg={msg({ kbSources: [meeting('2026-08-01T09:00:00Z', 'first'), meeting('2026-08-08T09:00:00Z', 'second')] })}
            idx={0} allMessages={[]} showSources
        />);
        expect(screen.getAllByText('Weekly sync')).toHaveLength(2);
        expect(screen.getAllByTestId('kb-doc-when')).toHaveLength(2);
    });
});

describe('embedSourcesAllowed', () => {
    it('opens only on a literal true', () => {
        expect(embedSourcesAllowed({ showSources: true })).toBe(true);
    });

    it('treats every other answer as no', () => {
        // A missing field (every server today), a failed fetch, a string from
        // a hand-written config, a 1 stored years ago: all of it is doubt.
        for (const config of [
            undefined, null, {}, { showSources: false }, { showSources: 'true' }, { showSources: 1 },
            { showSources: 'false' }, { showSources: {} }, { showSources: null }, 'true', 1, true,
        ]) {
            expect(embedSourcesAllowed(config), JSON.stringify(config)).toBe(false);
        }
    });
});

describe('MessageItem, which owns the gate', () => {
    /** A turn whose ONLY extra is its sources — no reasoning, no tools. */
    const sourcesOnly = msg({ modelId: null });

    it('does not open an empty disclosure when the sources are held back', () => {
        // The outer check asks "is there anything worth showing"; if sources
        // still counted there, an embed would render the panel, the caret and
        // the heading with nothing at all inside them.
        render(<MessageItem idx={0} msg={sourcesOnly} showSources={false} />);
        expect(screen.queryByText(/How I got this answer/)).toBeNull();
        expectNoLeak();
    });

    it('opens it as it always has inside the product', () => {
        // No prop: the signed-in app never passes one, and nothing there moves.
        render(<MessageItem idx={0} msg={sourcesOnly} />);
        expect(screen.getByText(/How I got this answer/)).toBeInTheDocument();
        // The chip under the answer carries the title in its own element too
        // (only the title truncates there, BFSF-352), hence getAll.
        expect(screen.getAllByText('Personeelshandboek').length).toBeGreaterThan(0);
        expect(screen.getByText('1 document')).toBeInTheDocument();
    });
});

describe('BIJT — de chiprij is dezelfde poort onderworpen', () => {
    it('toont geen kennisbankgegevens als de poort dicht is, ook met chips aan', () => {
        // Er bestond één regel boven de gepoorte weg een tweede, ONGEPOORTE
        // weg naar exact dezelfde gegevens: documenttitel, paginanummer en via
        // chipTitle ook de kop van de passage. De invariant van dit bestand —
        // fail-closed op elke stap — gold daarmee niet meer voor MessageItem
        // als geheel.
        render(<MessageItem idx={0} msg={msg({ modelId: null })} showSources={false} showAnswerChips />);
        expectNoLeak();
    });

    it('en toont ze wél als de poort openstaat', () => {
        render(<MessageItem idx={0} msg={msg({ modelId: null })} showAnswerChips />);
        expect(screen.getAllByText(/Personeelshandboek/).length).toBeGreaterThan(0);
    });

    it('BIJT — en staat er niet terwijl het antwoord nog geschreven wordt', () => {
        // Citaten landen midden in de beurt, dus de rij "waar dit antwoord
        // vandaan komt" stond er al vóór het antwoord bestond — groeiend, met
        // de tekst eronder die meesprong.
        const { container } = render(
            <MessageItem idx={0} msg={msg({ modelId: null, isStreaming: true })} showAnswerChips />,
        );
        expect(container.querySelector('[data-testid="answer-chips"]')).toBeNull();
    });
});
