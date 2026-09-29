import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import TestQuestionCard from './TestQuestionCard';
import { knowledgeApi } from './knowledgeApi';

/**
 * The test question.
 *
 * The question a person is really asking here is not "what is the answer" —
 * they usually know it. It is "did it find the right passage?", asked BEFORE
 * an agent starts answering customers out of this base. So what is pinned is
 * the order (citations before the answer), that "nothing found" reads as a
 * result rather than a failure, and that the relevance bar never prints a
 * number somebody could set a threshold on.
 */

vi.mock('./knowledgeApi', () => ({
    knowledgeApi: { ask: vi.fn() },
}));

/** Drive the SSE callback the way the route does: sources, then text, then done. */
function stream(frames) {
    knowledgeApi.ask.mockImplementation(async (id, q, { onEvent }) => {
        for (const [name, payload] of frames) onEvent(name, payload);
    });
}

const SOURCE = {
    title: 'Personeelshandboek', kind: 'kb_chunk', documentId: 'doc-1', chunkId: 3,
    page: 12, section: 'Verlof', content: 'Bij een huwelijk krijg je twee dagen vrij.', score: 0.9,
};

async function ask(text = 'Hoeveel verlof bij een huwelijk?') {
    fireEvent.change(screen.getByTestId('kb-ask-input'), { target: { value: text } });
    fireEvent.click(screen.getByTestId('kb-ask-submit'));
}

beforeEach(() => { vi.clearAllMocks(); });

describe('TestQuestionCard', () => {
    it('asks the knowledge base it is looking at', async () => {
        stream([['kb_sources', { sources: [SOURCE] }], ['text', { text: 'Twee dagen.' }], ['done', {}]]);
        render(<TestQuestionCard kbId="kb1" />);
        await ask();
        await waitFor(() => expect(knowledgeApi.ask).toHaveBeenCalledWith(
            'kb1', 'Hoeveel verlof bij een huwelijk?', expect.anything(),
        ));
    });

    it('shows the citations, then the answer', async () => {
        // The order is the point: an answer that lands first invites reading
        // it and believing it, which is what this screen exists to stop.
        const seen = [];
        knowledgeApi.ask.mockImplementation(async (id, q, { onEvent }) => {
            onEvent('kb_sources', { sources: [SOURCE] });
            seen.push(['sources-visible', !!screen.queryAllByTestId('citation-chip').length]);
            onEvent('text', { text: 'Twee dagen.' });
            onEvent('done', {});
        });
        render(<TestQuestionCard kbId="kb1" />);
        await ask();
        expect(await screen.findByTestId('kb-ask-answer')).toBeTruthy();
        expect(screen.getAllByTestId('citation-chip').length).toBe(1);
    });

    it('puts the page number on the chip, because that is what makes it checkable', async () => {
        stream([['kb_sources', { sources: [SOURCE] }], ['done', {}]]);
        render(<TestQuestionCard kbId="kb1" />);
        await ask();
        const chip = await screen.findByTestId('citation-chip');
        expect(chip.textContent).toMatch(/Personeelshandboek/);
        expect(chip.textContent).toMatch(/p\. 12/);
    });

    it('draws a chip without a page rather than no chip', async () => {
        // Every document ingested before the chunker stamped pages has none,
        // and those bytes are gone. This is the permanent normal state for a
        // large part of any install, not a loading state.
        stream([['kb_sources', { sources: [{ ...SOURCE, page: null }] }], ['done', {}]]);
        render(<TestQuestionCard kbId="kb1" />);
        await ask();
        const chip = await screen.findByTestId('citation-chip');
        expect(chip.textContent).toMatch(/Personeelshandboek/);
        expect(chip.textContent).not.toMatch(/p\./);
    });

    it('streams the answer in as it arrives', async () => {
        stream([['kb_sources', { sources: [SOURCE] }], ['text', { text: 'Twee ' }], ['text', { text: 'dagen.' }], ['done', {}]]);
        render(<TestQuestionCard kbId="kb1" />);
        await ask();
        expect((await screen.findByTestId('kb-ask-answer')).textContent).toBe('Twee dagen.');
    });

    it('reads "nothing found" as a RESULT, not an error', async () => {
        // Somebody tuning their sources has to be able to tell "the retrieval
        // is broken" from "this base genuinely has nothing about that". An
        // error banner conflates them.
        stream([['kb_sources', { sources: [] }], ['done', { empty: true }]]);
        render(<TestQuestionCard kbId="kb1" />);
        await ask();
        expect(await screen.findByTestId('kb-ask-empty')).toBeTruthy();
        expect(screen.queryByRole('alert')).toBeNull();
    });

    it('shows the passages that were retrieved, collapsed', async () => {
        stream([['kb_sources', { sources: [SOURCE, { ...SOURCE, title: 'Ander doc', score: 0.4 }] }], ['done', {}]]);
        render(<TestQuestionCard kbId="kb1" />);
        await ask();
        const details = await screen.findByTestId('kb-ask-passages');
        expect(details.open).toBe(false);
        expect(details.textContent).toMatch(/Passages found \(2\)/);
        fireEvent.click(details.querySelector('summary'));
        expect(screen.getAllByTestId('kb-ask-passage').length).toBe(2);
    });

    it('never prints a relevance number', async () => {
        // A retriever's score means something only against the other passages
        // in the same answer. "68%" invites reading it as confidence, and then
        // setting a threshold on it.
        stream([['kb_sources', { sources: [SOURCE, { ...SOURCE, score: 0.42 }] }], ['done', {}]]);
        render(<TestQuestionCard kbId="kb1" />);
        await ask();
        const details = await screen.findByTestId('kb-ask-passages');
        fireEvent.click(details.querySelector('summary'));
        expect(details.textContent).not.toMatch(/%/);
        expect(details.textContent).not.toMatch(/0\.9|0\.42/);
    });

    it('opens the full passage when a chip is clicked', async () => {
        stream([['kb_sources', { sources: [SOURCE] }], ['done', {}]]);
        render(<TestQuestionCard kbId="kb1" />);
        await ask();
        fireEvent.click(await screen.findByTestId('citation-chip'));
        const panel = await screen.findByTestId('kb-ask-citation');
        expect(panel.textContent).toMatch(/twee dagen vrij/);
        expect(panel.textContent).toMatch(/Verlof/);
    });

    it('an error mid-stream is shown, and does not look like an empty answer', async () => {
        stream([['kb_sources', { sources: [SOURCE] }], ['error', { error: 'model unavailable' }]]);
        render(<TestQuestionCard kbId="kb1" />);
        await ask();
        expect((await screen.findByRole('alert')).textContent).toMatch(/model unavailable/);
    });

    it('a refused request says why', async () => {
        knowledgeApi.ask.mockRejectedValue(Object.assign(new Error('Access denied'), { status: 403 }));
        render(<TestQuestionCard kbId="kb1" />);
        await ask();
        expect((await screen.findByRole('alert')).textContent).toMatch(/Access denied/);
    });

    it('asks nothing for an empty question', async () => {
        render(<TestQuestionCard kbId="kb1" />);
        fireEvent.change(screen.getByTestId('kb-ask-input'), { target: { value: '   ' } });
        expect(screen.getByTestId('kb-ask-submit').disabled).toBe(true);
        expect(knowledgeApi.ask).not.toHaveBeenCalled();
    });

    it('is inert with no knowledge base to ask', async () => {
        render(<TestQuestionCard kbId={null} />);
        expect(screen.getByTestId('kb-ask-input').disabled).toBe(true);
    });

    it('a new question replaces the previous answer rather than appending to it', async () => {
        stream([['kb_sources', { sources: [SOURCE] }], ['text', { text: 'First.' }], ['done', {}]]);
        render(<TestQuestionCard kbId="kb1" />);
        await ask('one');
        expect((await screen.findByTestId('kb-ask-answer')).textContent).toBe('First.');

        stream([['kb_sources', { sources: [SOURCE] }], ['text', { text: 'Second.' }], ['done', {}]]);
        await ask('two');
        await waitFor(() => expect(screen.getByTestId('kb-ask-answer').textContent).toBe('Second.'));
    });

    it('says what a table-row passage pulled in along its relations, and nothing when there is nothing', async () => {
        // "supplier → Van Dijk · Orders (312)": the join the hop made, so a
        // person testing their sources can see the row was found THROUGH the
        // table it points at, not by luck of phrasing.
        const linked = [
            { kind: 'row', column: 'supplier', table: 'Suppliers', title: 'Van Dijk' },
            { kind: 'rows', table: 'Orders', count: 312, shown: 3 },
        ];
        stream([['kb_sources', { sources: [{ ...SOURCE, linked }, { ...SOURCE, title: 'Ander doc', linked: null }] }], ['done', {}]]);
        const user = userEvent.setup();
        render(<TestQuestionCard kbId="kb1" />);
        await ask();
        const details = await screen.findByTestId('kb-ask-passages');
        await user.click(details.querySelector('summary'));
        const chips = screen.getAllByTestId('kb-ask-linked');
        expect(chips.length).toBe(1);
        expect(chips[0].textContent).toBe('Linked rows: supplier → Van Dijk · Orders (312)');
    });
});
