import { QueryClient } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { testQueryClient, withQueryClient } from '../../test/queryWrapper';
import { makeFakeApi, reply } from '../projects/workspace/workspaceTestApi';
import VersionHistoryPanel, { type VersionHistoryPanelProps } from './VersionHistoryPanel';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('../../utils/helpers', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    API_BASE: '',
    authFetch: fetchMock,
}));

const BASE = '/api/notebooks/n1';
const today = (h: number) => { const d = new Date(); d.setHours(h, 0, 0, 0); return d.toISOString(); };
const yesterday = () => { const d = new Date(); d.setDate(d.getDate() - 1); d.setHours(12, 0, 0, 0); return d.toISOString(); };

const V3 = { id: 'v3', seq: 3, source: 'named', name: 'Sent to the board', createdAt: today(10), createdBy: 'anna', contributors: [{ userId: 'anna', kind: 'user' }, { userId: 'anna', kind: 'ai', agentId: 'ag' }], stats: { wordsAdded: 12, wordsRemoved: 1, blocksChanged: 1 }, pinned: false };
const V2 = { id: 'v2', seq: 2, source: 'checkpoint', name: null, createdAt: today(9), createdBy: null, contributors: [{ userId: 'bob', kind: 'user' }], stats: { wordsAdded: 40, wordsRemoved: 0, blocksChanged: 3 }, pinned: false };
/** All inserted (or deleted) text in a comparison, however the diff tokenises it. */
const marked = (el: HTMLElement, tag: 'ins' | 'del') => [...el.querySelectorAll(tag)].map((n) => n.textContent).join(' ');

const V1 = { id: 'v1', seq: 1, source: 'created', name: null, createdAt: yesterday(), createdBy: 'bob', contributors: [{ userId: 'bob', kind: 'user' }], stats: null, pinned: false };

const content = (markdown: string) => ({ html: '', markdown });
const DOCS: Record<string, string> = {
    v1: '# Plan\n\nFirst draft.',
    v2: '# Plan\n\nWe launch in May.\n\nBudget is tight.\n\nRisks are listed.\n\nOwners are named.',
    v3: '# Plan\n\nWe launch in June.\n\nBudget is tight.\n\nRisks are listed.\n\nOwners are named.',
    current: '# Plan\n\nWe launch in June with partners.\n\nBudget is tight.\n\nRisks are listed.\n\nOwners are named.',
};
const META: Record<string, object> = { v1: V1, v2: V2, v3: V3, current: { ...V3, id: 'current', name: null } };

function serve(routes: Record<string, unknown> = {}) {
    const api = makeFakeApi({
        [`GET ${BASE}/versions`]: { versions: [V3, V2, V1], nextCursor: null },
        ...Object.fromEntries(Object.keys(DOCS).map((ref) => [`GET ${BASE}/versions/${ref}`, { version: { ...META[ref], content: content(DOCS[ref]) } }])),
        [`POST ${BASE}/versions/v2/restore`]: { version: { ...V2, id: 'v4', source: 'restore' }, current: { id: 'n1', version: 7 } },
        [`POST ${BASE}/versions`]: (call: { body: any }) => ({ version: { ...V3, id: 'v5', name: call.body.name } }),
        [`PUT ${BASE}/versions/v2/name`]: (call: { body: any }) => ({ version: { ...V2, name: call.body.name } }),
        ...routes,
    });
    fetchMock.mockImplementation(api.fetchImpl);
    return api;
}

function renderPanel(over: Partial<VersionHistoryPanelProps> = {}, client: QueryClient = testQueryClient()) {
    const props: VersionHistoryPanelProps = {
        baseUrl: BASE, canEdit: true, onClose: vi.fn(), onRestored: vi.fn(),
        people: { anna: { name: 'Anna' }, bob: { name: 'Bob' } }, currentUserId: 'me', expectedVersion: 6,
        ...over,
    };
    const view = render(withQueryClient(<VersionHistoryPanel {...props} />, client));
    const rerender = (next: Partial<VersionHistoryPanelProps>) => view.rerender(withQueryClient(<VersionHistoryPanel {...props} {...next} />, client));
    return { props, user: userEvent.setup(), rerender };
}

beforeEach(() => { fetchMock.mockReset(); });

describe('VersionHistoryPanel — the list', () => {
    it('names every contributor the server named, and only somebody nobody named is a former member', async () => {
        // A document's GET /:id names only its owner and last editor; the
        // versions answer names everybody on its page, for the reader's org.
        serve({
            [`GET ${BASE}/versions`]: {
                versions: [V3, V2, { ...V1, createdBy: 'gone', contributors: [{ userId: 'gone', kind: 'user' }] }], nextCursor: null,
                people: { bob: { name: 'Bob from the server' }, carla: { name: 'Carla' }, empty: {} },
            },
        });
        renderPanel({ people: { anna: { name: 'Anna' } }, canEdit: false });
        expect(await screen.findByTestId('version-row-v2')).toHaveTextContent('Bob from the server');
        expect(screen.getByTestId('version-row-v3')).toHaveTextContent('Anna, with AI');
        expect(screen.getByTestId('version-row-v1')).toHaveTextContent('Former member');
    });

    it('the host’s and the members’ names come before the server’s, and a later page adds its own', async () => {
        const page2 = { ...V1, id: 'v0', seq: 0, createdBy: 'dan', contributors: [{ userId: 'dan', kind: 'user' }] };
        serve({
            [`GET ${BASE}/versions`]: (call: { query: URLSearchParams }) => (call.query.get('cursor')
                ? { versions: [page2], nextCursor: null, people: { dan: { name: 'Dan' } } }
                : { versions: [V3, V2, V1], nextCursor: 'c2', people: { anna: { name: 'Anna (server)' }, bob: { name: 'Bob' } } }),
        });
        const { user } = renderPanel({ people: { anna: { name: 'Anna' } }, canEdit: false });
        expect(await screen.findByTestId('version-row-v3')).toHaveTextContent('Anna, with AI');
        await user.click(await screen.findByRole('button', { name: 'Show older versions' }));
        expect(await screen.findByTestId('version-row-v0')).toHaveTextContent('Dan');
        expect(screen.getByTestId('version-row-v2')).toHaveTextContent('Bob');
    });

    it('shows the versions per day with names, who, the AI and how much changed', async () => {
        serve();
        renderPanel({ canEdit: false });
        const named = await screen.findByTestId('version-row-v3');
        expect(named).toHaveTextContent('Sent to the board');
        expect(named).toHaveTextContent('Anna, with AI');
        expect(named).toHaveTextContent('AI');
        expect(named).toHaveTextContent('+12 words, −1 words');
        expect(screen.getByTestId('version-row-v2')).toHaveTextContent('Edits saved');
        expect(screen.getByTestId('version-row-v1')).toHaveTextContent('Created');
        const list = screen.getByTestId('version-list');
        expect(within(list).getByText('Today')).toBeInTheDocument();
        expect(within(list).getByText('Yesterday')).toBeInTheDocument();
        // A viewer reads; naming and restoring are for editors.
        expect(screen.queryByTestId('version-name-current')).toBeNull();
    });

    it('explains an empty history, and says a failed one failed', async () => {
        serve({ [`GET ${BASE}/versions`]: { versions: [], nextCursor: null } });
        renderPanel();
        expect(await screen.findByTestId('versions-empty')).toHaveTextContent('No versions yet');
    });

    it('offers to try again when the history could not load', async () => {
        let fail = true;
        serve({ [`GET ${BASE}/versions`]: () => (fail ? reply(403, { error: 'Forbidden' }) : { versions: [V2], nextCursor: null }) });
        const { user } = renderPanel();
        expect(await screen.findByTestId('versions-failed')).toHaveTextContent('only editors can change it');
        fail = false;
        await user.click(screen.getByRole('button', { name: 'Try again' }));
        expect(await screen.findByTestId('version-row-v2')).toBeInTheDocument();
    });

    it('closes with its button and with Escape', async () => {
        serve();
        const { props, user } = renderPanel();
        await screen.findByTestId('version-row-v3');
        await user.keyboard('{Escape}');
        expect(props.onClose).toHaveBeenCalledTimes(1);
        await user.click(screen.getByTestId('version-history-close'));
        expect(props.onClose).toHaveBeenCalledTimes(2);
    });
});

describe('VersionHistoryPanel — compare', () => {
    it('compares a version with the one before it, inline or side by side, folded to the changes', async () => {
        serve();
        const { user } = renderPanel();
        await user.click(await screen.findByTestId('version-row-v3'));
        const compare = await screen.findByTestId('compare-inline');
        await waitFor(() => expect(marked(compare, 'ins')).toMatch(/June/));
        expect(marked(compare, 'del')).toMatch(/May/);
        // Unchanged blocks far from the change fold into a gap.
        expect(screen.getByTestId('compare-gap')).toHaveTextContent('unchanged');
        await user.click(screen.getByRole('radio', { name: 'Side by side' }));
        expect(await screen.findByTestId('compare-side')).toBeInTheDocument();
        await user.click(screen.getByTestId('compare-only-changes'));
        expect(screen.queryByTestId('compare-gap')).toBeNull();
    });

    it('compares with the current content when asked', async () => {
        const api = serve();
        const { user } = renderPanel();
        await user.click(await screen.findByTestId('version-row-v3'));
        await user.selectOptions(await screen.findByTestId('version-compare-with'), 'current');
        await waitFor(() => expect(api.callsTo('GET', `${BASE}/versions/current`)).toHaveLength(1));
        const compare = await screen.findByTestId('compare-inline');
        await waitFor(() => expect(marked(compare, 'ins')).toMatch(/partners/));
    });

    it('opens straight on "what changed since the version I saw"', async () => {
        serve();
        renderPanel({ initialCompare: { from: 'v2', to: 'current' } });
        const compare = await screen.findByTestId('compare-inline');
        await waitFor(() => expect(marked(compare, 'ins')).toMatch(/June/));
        expect(screen.getByTestId('version-compare-with')).toHaveValue('current');
    });
});

describe('VersionHistoryPanel — a version that is no longer kept', () => {
    const halfPastNine = new Date(Date.parse(V2.createdAt) + 30 * 60_000).toISOString();

    it('compares from the newest listed version of that moment instead, and says so', async () => {
        serve({ [`GET ${BASE}/versions/pruned`]: reply(404, { error: 'Not found' }) });
        renderPanel({ initialCompare: { from: 'pruned', to: 'current', at: halfPastNine } });
        expect(await screen.findByTestId('version-gone')).toHaveTextContent('compares from the closest earlier one');
        expect(screen.getByTestId('version-detail-title')).toHaveTextContent('Edits saved');
        expect(screen.getByTestId('version-compare-with')).toHaveValue('current');
        const compare = await screen.findByTestId('compare-inline');
        await waitFor(() => expect(marked(compare, 'ins')).toMatch(/June/));
        expect(screen.queryByTestId('compare-load-failed')).toBeNull();
    });

    it('without a moment to go by, shows the list to pick from, asking the server once', async () => {
        const api = serve({ [`GET ${BASE}/versions/pruned`]: reply(404, { error: 'Not found' }) });
        const retrying = new QueryClient({ defaultOptions: { queries: { retry: 2, retryDelay: 1 } } });
        renderPanel({ initialCompare: { from: 'pruned', to: 'current' } }, retrying);
        expect(await screen.findByTestId('version-gone')).toHaveTextContent('Pick a version to compare with');
        expect(screen.getByTestId('version-row-v2')).toBeInTheDocument();
        expect(screen.queryByTestId('compare-load-failed')).toBeNull();
        expect(api.callsTo('GET', `${BASE}/versions/pruned`)).toHaveLength(1);
    });
});

describe('VersionHistoryPanel — per-version and per-item state', () => {
    it('an open rename form never carries over to another version', async () => {
        const api = serve();
        const { user } = renderPanel();
        await user.click(await screen.findByTestId('version-row-v2'));
        await user.click(screen.getByTestId('version-rename'));
        await user.type(screen.getByLabelText('Version name'), 'Meant for v2');
        await user.click(screen.getByTestId('version-row-v3'));
        await waitFor(() => expect(screen.getByTestId('version-detail-title')).toHaveTextContent('Sent to the board'));
        expect(screen.queryByTestId('version-rename-form')).toBeNull();
        expect(api.calls.filter((c) => c.method === 'PUT')).toHaveLength(0);
    });

    it('another item is another history: it opens on its own version, nothing of the first carries over', async () => {
        const OTHER = '/api/notebooks/n2';
        const W1 = { ...V1, id: 'w1', source: 'autosave', createdAt: today(8) };
        serve({
            [`GET ${OTHER}/versions`]: { versions: [W1], nextCursor: null },
            [`GET ${OTHER}/versions/w1`]: { version: { ...W1, content: content('# Other\n\nOld text.') } },
            [`GET ${OTHER}/versions/current`]: { version: { ...W1, id: 'current', content: content('# Other\n\nNew text.') } },
        });
        const { rerender } = renderPanel({ initialCompare: { from: 'v2', to: 'current' } });
        await screen.findByTestId('compare-inline');
        rerender({ baseUrl: OTHER, initialCompare: { from: 'w1', to: 'current' } });
        await waitFor(() => expect(screen.getByTestId('version-detail-title')).toHaveTextContent('Autosaved'));
        const compare = await screen.findByTestId('compare-inline');
        await waitFor(() => expect(marked(compare, 'ins')).toMatch(/New/));
    });
});

describe('VersionHistoryPanel — naming and restoring', () => {
    it('restores only after a confirmation that says what happens, and hands the new state over', async () => {
        const api = serve();
        const { props, user } = renderPanel();
        await user.click(await screen.findByTestId('version-row-v2'));
        await user.click(screen.getByTestId('version-restore'));
        const dialog = await screen.findByRole('dialog');
        expect(dialog).toHaveTextContent('The current content is kept as a version first');
        expect(api.callsTo('POST', `${BASE}/versions/v2/restore`)).toHaveLength(0);
        await user.click(within(dialog).getByRole('button', { name: 'Restore' }));
        await waitFor(() => expect(props.onRestored).toHaveBeenCalledWith({ id: 'n1', version: 7 }));
        expect(api.callsTo('POST', `${BASE}/versions/v2/restore`)[0].body).toEqual({ expectedVersion: 6 });
        expect(await screen.findByTestId('version-notice')).toHaveTextContent('Restored');
    });

    it('says so when somebody changed the item in the meantime', async () => {
        serve({ [`POST ${BASE}/versions/v2/restore`]: reply(409, { error: 'Conflict', code: 'VERSION_CONFLICT' }) });
        const { props, user } = renderPanel();
        await user.click(await screen.findByTestId('version-row-v2'));
        await user.click(screen.getByTestId('version-restore'));
        await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Restore' }));
        expect(await screen.findByTestId('version-restore-error')).toHaveTextContent('changed while you were looking');
        expect(props.onRestored).not.toHaveBeenCalled();
    });

    it('names the current content, and renames a stored version', async () => {
        const api = serve();
        const { user } = renderPanel();
        await user.click(await screen.findByTestId('version-name-current'));
        await user.type(screen.getByLabelText('Version name'), 'Final draft{Enter}');
        await waitFor(() => expect(api.callsTo('POST', `${BASE}/versions`)).toHaveLength(1));
        expect(api.callsTo('POST', `${BASE}/versions`)[0].body).toEqual({ name: 'Final draft' });
        expect(await screen.findByTestId('version-notice')).toHaveTextContent('Version named.');

        await user.click(await screen.findByTestId('version-row-v2'));
        await user.click(screen.getByTestId('version-rename'));
        await user.type(screen.getByLabelText('Version name'), 'Board copy');
        await user.click(screen.getByTestId('version-rename-form-save'));
        await waitFor(() => expect(api.callsTo('PUT', `${BASE}/versions/v2/name`)).toHaveLength(1));
        expect(api.callsTo('PUT', `${BASE}/versions/v2/name`)[0].body).toEqual({ name: 'Board copy' });
    });

    it('refuses an empty new name without asking the server', async () => {
        const api = serve();
        const { user } = renderPanel();
        await user.click(await screen.findByTestId('version-name-current'));
        expect(screen.getByTestId('version-name-form-save')).toBeDisabled();
        await user.type(screen.getByLabelText('Version name'), '   {Enter}');
        expect(api.callsTo('POST', `${BASE}/versions`)).toHaveLength(0);
    });
});
