import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The overlay's job is to tell three empty-looking answers apart:
 *   "nothing matched", "some sources could not be searched", and
 *   "the search did not run at all".
 * Everything below is about that distinction — a list that came out of a
 * failure must never read as a result.
 */

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));

vi.mock('../../hooks/useTranslation', () => {
    const useTranslation = () => ({
        t: (key, fallback, vars) => {
            const base = fallback || key;
            return vars ? Object.entries(vars).reduce((s, [k, v]) => s.replace(`{${k}}`, v), base) : base;
        },
        locale: 'en',
    });
    return { default: useTranslation, useTranslation };
});
vi.mock('../../utils/helpers', () => ({ API_BASE: '', authFetch: fetchMock }));

import StudioSearchOverlay from './StudioSearchOverlay.jsx';

const answer = (body) => { fetchMock.mockResolvedValue({ ok: true, json: async () => body }); };

const renderOverlay = (props = {}) => render(
    <StudioSearchOverlay isOpen onClose={vi.fn()} onNavigate={vi.fn()} {...props} />
);

const type = (value) => fireEvent.change(screen.getByTestId('studio-search-input'), { target: { value } });

describe('StudioSearchOverlay', () => {
    beforeEach(() => { cleanup(); fetchMock.mockReset(); });

    it('asks nothing until the query is long enough', async () => {
        renderOverlay();
        expect(screen.getByTestId('studio-search-min-chars')).toBeTruthy();
        type('a');
        await new Promise((r) => setTimeout(r, 350));
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('groups hits by kind and opens one at its own Studio address', async () => {
        answer({
            query: 'inv', tooShort: false, errors: [],
            results: {
                automations: [{ id: 'a1', name: 'Invoice reminder' }],
                meetingNotes: [{ id: 'm1', name: 'Invoice call' }],
            },
        });
        const onNavigate = vi.fn();
        const onClose = vi.fn();
        renderOverlay({ onNavigate, onClose });
        type('inv');
        await waitFor(() => expect(screen.getByTestId('studio-search-hit-automations-a1')).toBeTruthy());
        expect(fetchMock.mock.calls[0][0]).toBe('/api/studio/search?q=inv');

        fireEvent.click(screen.getByTestId('studio-search-hit-automations-a1'));
        // The server's kind key is 'automations'; the SECTION behind it is
        // 'aiTasks' and its URL segment is 'automations' again. The mapping
        // has to go through the registry or a rename breaks the link.
        expect(onNavigate).toHaveBeenCalledWith('studio/automations/a1');
        expect(onClose).toHaveBeenCalled();
    });

    it('uses the section\'s own segment, not its key, where the two differ', async () => {
        answer({ query: 'inv', tooShort: false, errors: [], results: { meetingNotes: [{ id: 'm1', name: 'Invoice call' }] } });
        const onNavigate = vi.fn();
        renderOverlay({ onNavigate });
        type('inv');
        await waitFor(() => expect(screen.getByTestId('studio-search-hit-meetingNotes-m1')).toBeTruthy());
        fireEvent.click(screen.getByTestId('studio-search-hit-meetingNotes-m1'));
        expect(onNavigate).toHaveBeenCalledWith('studio/meeting-notes/m1');
    });

    it('offers a way into the whole section beside the hits', async () => {
        answer({ query: 'inv', tooShort: false, errors: [], results: { skills: [{ id: 's1', name: 'Invoice parsing' }] } });
        const onNavigate = vi.fn();
        renderOverlay({ onNavigate });
        type('inv');
        await waitFor(() => expect(screen.getByTestId('studio-search-all-skills')).toBeTruthy());
        fireEvent.click(screen.getByTestId('studio-search-all-skills'));
        expect(onNavigate).toHaveBeenCalledWith('studio/skills');
    });

    it('SAYS SO when only some kinds could be searched — and still shows the ones that answered', async () => {
        answer({
            query: 'inv', tooShort: false, errors: ['agents', 'knowledge'],
            results: { skills: [{ id: 's1', name: 'Invoice parsing' }] },
        });
        renderOverlay();
        type('inv');
        await waitFor(() => expect(screen.getByTestId('studio-search-partial')).toBeTruthy());
        // The rows that DID come back are real, so they stay — a short list is
        // only trustworthy when it says it is short.
        expect(screen.getByTestId('studio-search-hit-skills-s1')).toBeTruthy();
        expect(screen.queryByTestId('studio-search-empty')).toBeNull();
    });

    it('a partial answer with no hits at all is a warning, NOT "no matches"', async () => {
        // The dangerous shape: everything the user could have matched lives in
        // the kinds that failed. "No matches for X" here would be a claim the
        // screen cannot support.
        answer({ query: 'inv', tooShort: false, errors: ['agents', 'skills'], results: {} });
        renderOverlay();
        type('inv');
        await waitFor(() => expect(screen.getByTestId('studio-search-partial')).toBeTruthy());
        expect(screen.queryByTestId('studio-search-empty')).toBeNull();
    });

    it('a failed request is not an empty result', async () => {
        fetchMock.mockResolvedValue({ ok: false, status: 500 });
        renderOverlay();
        type('inv');
        await waitFor(() => expect(screen.getByTestId('studio-search-failed')).toBeTruthy());
        expect(screen.queryByTestId('studio-search-empty')).toBeNull();
        expect(screen.queryByTestId('studio-search-partial')).toBeNull();
    });

    it('a thrown request is not an empty result either, and drops the stale rows', async () => {
        answer({ query: 'inv', tooShort: false, errors: [], results: { skills: [{ id: 's1', name: 'Invoice parsing' }] } });
        renderOverlay();
        type('inv');
        await waitFor(() => expect(screen.getByTestId('studio-search-hit-skills-s1')).toBeTruthy());

        fetchMock.mockRejectedValue(new Error('offline'));
        type('invo');
        await waitFor(() => expect(screen.getByTestId('studio-search-failed')).toBeTruthy());
        // Rows from the previous query must not sit under the new word.
        expect(screen.queryByTestId('studio-search-hit-skills-s1')).toBeNull();
        expect(screen.queryByTestId('studio-search-empty')).toBeNull();
    });

    it('says "no matches" only when every kind answered and none matched', async () => {
        answer({ query: 'zzz', tooShort: false, errors: [], results: { skills: [], agents: [] } });
        renderOverlay();
        type('zzz');
        await waitFor(() => expect(screen.getByTestId('studio-search-empty')).toBeTruthy());
        expect(screen.getByTestId('studio-search-empty').textContent).toContain('zzz');
    });

    it('closes on Escape', async () => {
        answer({ query: 'inv', tooShort: false, errors: [], results: {} });
        const onClose = vi.fn();
        renderOverlay({ onClose });
        fireEvent.keyDown(screen.getByTestId('studio-search-input'), { key: 'Escape' });
        expect(onClose).toHaveBeenCalled();
    });

    it('renders nothing at all when closed', () => {
        renderOverlay({ isOpen: false });
        expect(screen.queryByTestId('studio-search-overlay')).toBeNull();
    });
});
