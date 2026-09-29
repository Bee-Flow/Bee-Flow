import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The list on Studio's Start screen. Four things are pinned here and little
 * else, because they are the ones that go quietly wrong:
 *
 *   1. "nothing needs attention" and "we could not check everything" are two
 *      sentences, and the second is never rendered as the first;
 *   2. a finding this build cannot draw is announced, not swallowed;
 *   3. the worst row is the top row, whichever source produced it;
 *   4. "show me" goes where the server said, and nowhere at all when it
 *      could not name a row.
 *
 * `runAttentionChecks` is stubbed (it is unit-tested next door against a
 * stubbed authFetch); the summariser it feeds is the real one.
 */

const { runMock } = vi.hoisted(() => ({ runMock: vi.fn() }));

vi.mock('./attentionChecks', async (importOriginal) => ({
    ...(await importOriginal()),
    runAttentionChecks: (...args) => runMock(...args),
}));

vi.mock('../../../../hooks/useTranslation', () => {
    const useTranslation = () => ({
        t: (key, fallback, params) => {
            let value = typeof fallback === 'string' ? fallback : key;
            const p = typeof fallback === 'string' ? params : fallback;
            if (p && typeof p === 'object') {
                for (const [k, v] of Object.entries(p)) value = value.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
            }
            return value;
        },
        locale: 'en',
    });
    return { default: useTranslation, useTranslation };
});

import AttentionList from './AttentionList.jsx';

/** A run as attentionChecks.runAttentionChecks resolves it. */
const run = (over = {}) => ({
    findings: [], unavailable: [], capped: [], complete: true, checked: ['studio'], skipped: [], truncated: 0, ...over,
});

const BLOCKED = {
    source: 'solutionBlocked', code: 'solution.blocked', severity: 'error', kind: 'solution',
    targetId: 'p1', message: '"Onboarding" cannot be published yet.', remediation: null, deepLink: null,
};
const EMPTY_KB = {
    source: 'kbEmptyInUse', code: 'knowledge_base.empty_in_use', severity: 'warning', kind: 'kb',
    targetId: 'k1', message: '"Handbook" is used for answers but holds no documents.',
    remediation: 'Add a document.', deepLink: '/app/studio/knowledge/k1',
};
const NO_KB = {
    source: 'agentNoKb', code: 'agent.no_knowledge_base', severity: 'info', kind: 'agent',
    targetId: 'a1', message: '"Helpdesk" is published but is not grounded on a knowledge base.',
    remediation: null, deepLink: '/app/studio/agents/a1',
};

const renderList = (props = {}) => render(
    <AttentionList user={{ id: 'u1', permissions: ['all'] }} hasFeature={() => true} onNavigate={vi.fn()} {...props} />,
);

describe('AttentionList', () => {
    beforeEach(() => {
        cleanup();
        runMock.mockReset();
        runMock.mockResolvedValue(run());
    });

    it('claims nothing until the first answer has landed', async () => {
        let resolve;
        runMock.mockReturnValue(new Promise((r) => { resolve = r; }));
        renderList();
        expect(screen.queryByTestId('studio-attention')).toBeNull();
        resolve(run());
        await screen.findByTestId('studio-attention');
    });

    it('says "nothing needs attention" ONLY when every check ran', async () => {
        renderList();
        expect((await screen.findByTestId('studio-attention-empty')).textContent).toMatch(/Nothing needs attention/);
        expect(screen.queryByTestId('studio-attention-empty-unchecked')).toBeNull();
        expect(screen.queryByTestId('studio-attention-partial')).toBeNull();
    });

    it('an empty list with a failed check gets its OWN words, not the clean ones', async () => {
        runMock.mockResolvedValue(run({ unavailable: ['studio:kbSourceError'], complete: false }));
        renderList();
        const line = await screen.findByTestId('studio-attention-empty-unchecked');
        // Two different states, two different sentences — never the same one.
        expect(line.textContent).not.toMatch(/Nothing needs attention/);
        expect(line.textContent).toMatch(/not the whole picture/);
        expect(screen.queryByTestId('studio-attention-empty')).toBeNull();
    });

    it('SAYS WHICH check could not run — a nameless warning cannot be acted on', async () => {
        runMock.mockResolvedValue(run({ unavailable: ['studio:appValidation'], complete: false }));
        renderList();
        const line = await screen.findByTestId('studio-attention-empty-unchecked');
        // The section's own name, from the registry — the same word the rail
        // uses, so a reader can tell whether it is the same one every day.
        expect(line.textContent).toMatch(/Not checked:/);
        expect(line.textContent).toMatch(/Apps/i);
    });

    it('a CAPPED check is a size, not a breakdown, and gets its own sentence', async () => {
        runMock.mockResolvedValue(run({ capped: ['solutionBlocked'], complete: false }));
        renderList();
        const line = await screen.findByTestId('studio-attention-empty-capped');
        // Nothing went wrong here — the organisation is simply larger than the
        // budget — so this must not read like a failure.
        expect(line.textContent).not.toMatch(/could not run/i);
        expect(line.textContent).toMatch(/not the whole organisation/i);
        expect(line.textContent).toMatch(/busiest part/i);
        expect(screen.queryByTestId('studio-attention-empty')).toBeNull();
    });

    it('a row that arrived WITHOUT a sentence still gets words, from its source', async () => {
        // The endpoint cannot send one today (finding.js refuses an empty
        // message), but this fallback is the reason six src_* lines exist —
        // and a row drawn with a glyph and a code and no words is a card
        // nobody can read that still counts in the header.
        runMock.mockResolvedValue(run({ findings: [{ ...EMPTY_KB, message: null }] }));
        renderList();
        const row = await screen.findByTestId('studio-attention-item-knowledge_base.empty_in_use');
        expect(row.textContent).toMatch(/Knowledge base is used but holds no documents/);
    });

    it('warns above the rows when the list itself may be short', async () => {
        runMock.mockResolvedValue(run({ findings: [BLOCKED], unavailable: ['studio:appValidation'], complete: false }));
        renderList();
        expect((await screen.findByTestId('studio-attention-partial')).textContent).toMatch(/may be incomplete/);
        expect(screen.queryByTestId('studio-attention-empty')).toBeNull();
    });

    it('orders by severity, not by source', async () => {
        // Handed over advice-first, which is the order the sources are declared in.
        runMock.mockResolvedValue(run({ findings: [NO_KB, EMPTY_KB, BLOCKED] }));
        const { container } = renderList();
        await screen.findByTestId('studio-attention');
        expect([...container.querySelectorAll('[data-severity]')].map((el) => el.getAttribute('data-severity')))
            .toEqual(['error', 'warning', 'info']);
        // The producer's own sentence, with the object's name in it.
        expect(screen.getByText(/"Onboarding" cannot be published yet/)).toBeTruthy();
        expect(screen.getByText(/Add a document/)).toBeTruthy();
    });

    it('counts what it cannot draw instead of shrinking the list quietly', async () => {
        const foreign = { ...BLOCKED, kind: 'notebook', code: 'notebook.stale', message: 'Something is wrong' };
        runMock.mockResolvedValue(run({ findings: [BLOCKED, foreign] }));
        renderList();
        expect((await screen.findByTestId('studio-attention-hidden')).textContent)
            .toMatch(/1 more thing needs attention that this version cannot show/);
        // The count above the list is the TRUE total, not the drawn one.
        expect(screen.getByTestId('studio-attention-count').textContent).toMatch(/2 things need attention/);
    });

    it('says how many the endpoint found beyond what it sent', async () => {
        runMock.mockResolvedValue(run({ findings: [BLOCKED], truncated: 3 }));
        renderList();
        expect((await screen.findByTestId('studio-attention-more')).textContent).toMatch(/3 more were found but are not shown here/);
        expect(screen.getByTestId('studio-attention-count').textContent).toMatch(/4 things need attention/);
    });

    it('opens where the server said, and falls back to the registry for a kind it has no link for', async () => {
        const onNavigate = vi.fn();
        runMock.mockResolvedValue(run({ findings: [EMPTY_KB, BLOCKED] }));
        renderList({ onNavigate });
        // deepLink from the server, converted to an in-app page.
        fireEvent.click(await screen.findByTestId('studio-attention-item-knowledge_base.empty_in_use'));
        expect(onNavigate).toHaveBeenCalledWith('studio/knowledge/k1');
        // A row that arrived WITHOUT a link (the endpoint sends one for all
        // six sources today) — built from the Studio registry instead of
        // dropping the button.
        fireEvent.click(screen.getByTestId('studio-attention-item-solution.blocked'));
        expect(onNavigate).toHaveBeenCalledWith('studio/solutions/p1');
    });

    it('offers no button when nothing named a row to open', async () => {
        const onNavigate = vi.fn();
        runMock.mockResolvedValue(run({ findings: [{ ...BLOCKED, targetId: null, deepLink: null }] }));
        renderList({ onNavigate });
        const row = await screen.findByTestId('studio-attention-item-solution.blocked');
        expect(row.getAttribute('role')).toBeNull();
        fireEvent.click(row);
        expect(onNavigate).not.toHaveBeenCalled();
    });

    it('refuses a link that does not go into this app', async () => {
        const onNavigate = vi.fn();
        runMock.mockResolvedValue(run({ findings: [{ ...BLOCKED, deepLink: 'https://example.com/x' }] }));
        renderList({ onNavigate });
        // Falls back to the registry path, never to the foreign URL.
        fireEvent.click(await screen.findByTestId('studio-attention-item-solution.blocked'));
        expect(onNavigate).toHaveBeenCalledWith('studio/solutions/p1');
    });

    it('says so when a source is somebody else\'s to see', async () => {
        runMock.mockResolvedValue(run({ skipped: ['agentNoKb'] }));
        renderList();
        expect((await screen.findByTestId('studio-attention-skipped')).textContent).toMatch(/only run for the people who can act/);
        // Skipping is not a failure: the clean sentence still stands.
        expect(screen.getByTestId('studio-attention-empty')).toBeTruthy();
    });

    it('asks the register with the caller\'s own context', async () => {
        const user = { id: 'u9', permissions: [] };
        const hasFeature = () => false;
        renderList({ user, hasFeature });
        await screen.findByTestId('studio-attention');
        await waitFor(() => expect(runMock).toHaveBeenCalledWith({ user, hasFeature }));
    });
});
