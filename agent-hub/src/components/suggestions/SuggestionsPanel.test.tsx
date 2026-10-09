import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client';
import { SHORTCUTS } from '../../editor/react/shortcuts';
import { renderWithClient } from '../../test/render';
import type { Suggestion } from '../../api/queries/suggestions';
import SuggestionsPanel, { groupByBatch, type SuggestionsPanelProps } from './SuggestionsPanel';

const { get, post } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../../api/client', async (orig) => ({ ...(await orig<typeof import('../../api/client')>()), apiClient: { get, post } }));
vi.mock('../../hooks/useDocumentStream', () => ({ default: () => ({ subscribe: () => () => undefined }) }));
vi.mock('../../editor/suggest', () => ({
    hunkWords: () => ({ beforeText: 'a', afterText: 'b', words: [{ op: 'delete', text: 'old' }, { op: 'insert', text: 'new' }, { op: 'equal', text: ' tail' }] }),
}));

const anchor = (quote: string) => ({ quote, prefix: '', suffix: '', blockIndex: 0 });
const sug = (id: string, batchId: string, over: Record<string, unknown> = {}) => ({
    id, batchId, kind: 'text', status: 'open', anchor: anchor(`q${id}`), before: [], after: [], summary: `Summary ${id}`,
    authorKind: 'ai', agentId: null, createdAt: '2026-10-01T10:00:00.000Z', ...over,
});

let list: Array<ReturnType<typeof sug>>;

function setup(over: Partial<SuggestionsPanelProps> = {}) {
    const props: SuggestionsPanelProps = { documentId: 'd1', canEdit: true, focusedId: null, onFocus: vi.fn(), highlight: vi.fn(), scrollToAnchor: vi.fn(() => true), ...over };
    renderWithClient(<SuggestionsPanel {...props} />);
    return props;
}

beforeEach(() => {
    get.mockReset(); post.mockReset();
    list = [sug('s1', 'b1'), sug('s2', 'b1'), sug('s3', 'b2'), sug('s4', 'b2', { status: 'stale' }), sug('s5', 'b3', { status: 'accepted' })];
    get.mockImplementation(async () => ({ suggestions: list, open: list.filter(s => s.status === 'open').length }));
    post.mockResolvedValue({ accepted: ['s1'], rejected: [], stale: [], versionId: 'v2' });
});

describe('SuggestionsPanel', () => {
    it('groups open suggestions by batch, shows the word diff and the stale line', async () => {
        setup();
        expect(await screen.findAllByTestId('suggestion-batch')).toHaveLength(2);
        const first = screen.getAllByTestId('suggestion-card')[0];
        expect(within(first).getByTestId('suggestion-diff')).toHaveTextContent('oldnew tail');
        expect(screen.getByTestId('suggestions-handled')).toHaveTextContent('Handled (2)');
        expect(screen.getByTestId('suggestions-handled')).toHaveTextContent('No longer fits: Summary s4');
        expect(groupByBatch(list as unknown as Suggestion[]).map(g => g.length)).toEqual([2, 2, 1]);
    });

    it('accepts one, rejects one, and accepts a whole batch through the right endpoints', async () => {
        const user = userEvent.setup();
        setup();
        const cards = await screen.findAllByTestId('suggestion-card');
        await user.click(within(cards[0]).getByRole('button', { name: 'Accept this suggestion' }));
        expect(post).toHaveBeenLastCalledWith('/api/studio-documents/d1/suggestions/s1/accept', {}, { retry: false });
        await user.click(within(cards[1]).getByRole('button', { name: 'Reject this suggestion' }));
        expect(post).toHaveBeenLastCalledWith('/api/studio-documents/d1/suggestions/s2/reject', {}, { retry: false });
        const batches = screen.getAllByTestId('suggestion-batch');
        await user.click(within(batches[0]).getByRole('button', { name: 'Accept all' }));
        expect(post).toHaveBeenLastCalledWith('/api/studio-documents/d1/suggestions/batch/b1/accept', {}, { retry: false });
        await user.click(within(batches[1]).getByRole('button', { name: 'Reject all' }));
        expect(post).toHaveBeenLastCalledWith('/api/studio-documents/d1/suggestions/batch/b2/reject', {}, { retry: false });
    });

    it('tells the reader when nothing could be applied (409)', async () => {
        post.mockRejectedValueOnce(new ApiError('stale', { status: 409 }));
        const user = userEvent.setup();
        setup();
        await user.click(within((await screen.findAllByTestId('suggestion-card'))[0]).getByRole('button', { name: 'Accept this suggestion' }));
        expect(await screen.findByText(/Nothing could be applied/)).toBeInTheDocument();
    });

    it('offers no buttons to a viewer, only the list', async () => {
        setup({ canEdit: false });
        await screen.findAllByTestId('suggestion-card');
        expect(screen.queryByRole('button', { name: 'Accept all' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Accept this suggestion' })).toBeNull();
        expect(screen.getByTestId('suggestions-viewer-hint')).toBeInTheDocument();
    });

    it('paints the open suggestions and focuses a card (scrolling the page to it) on click', async () => {
        const user = userEvent.setup();
        const props = setup();
        await screen.findAllByTestId('suggestion-card');
        await waitFor(() => expect(props.highlight).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ id: 's1' })]), null));
        await user.click(screen.getByRole('button', { name: 'Summary s2' }));
        expect(props.onFocus).toHaveBeenCalledWith('s2');
        expect(props.scrollToAnchor).toHaveBeenCalledWith(anchor('qs2'));
    });

    it('a passage the page can no longer find is shown as not fitting', async () => {
        const user = userEvent.setup();
        setup({ scrollToAnchor: () => false });
        await user.click(await screen.findByRole('button', { name: 'Summary s1' }));
        expect(await screen.findAllByTestId('suggestion-stale')).toHaveLength(1);
        expect(screen.getByTestId('suggestion-stale')).toHaveTextContent('this suggestion no longer fits');
    });

    it('keyboard: j moves on, a accepts, r rejects', async () => {
        const user = userEvent.setup();
        const onFocus = vi.fn();
        setup({ onFocus, focusedId: 's1' });
        const accept = await screen.findAllByRole('button', { name: 'Accept this suggestion' });
        accept[0].focus();
        await user.keyboard('j');
        expect(onFocus).toHaveBeenLastCalledWith('s2');
        await user.keyboard('a');
        await waitFor(() => expect(post).toHaveBeenLastCalledWith('/api/studio-documents/d1/suggestions/s1/accept', {}, { retry: false }));
        await user.keyboard('r');
        await waitFor(() => expect(post).toHaveBeenLastCalledWith('/api/studio-documents/d1/suggestions/s1/reject', {}, { retry: false }));
    });

    it('its letter keys are plain, so no editor Mod shortcut matches them', () => {
        for (const key of ['j', 'k', 'a', 'r']) {
            for (const s of SHORTCUTS) {
                expect(s.match?.({ key, code: `Key${key.toUpperCase()}`, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false }) ?? false).toBe(false);
            }
        }
        act(() => undefined);
    });

    it('says so when there are none', async () => {
        list = [];
        setup();
        expect(await screen.findByTestId('suggestions-empty')).toBeInTheDocument();
    });
});
