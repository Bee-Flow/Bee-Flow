import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withQueryClient } from '../../../test/queryWrapper';
import SinceLastVisit from './SinceLastVisit';
import { EDITOR_ID, makeFakeApi, makeMembers, OWNER_ID, reply, VIEWER_ID } from './workspaceTestApi';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('../../../utils/helpers', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    API_BASE: '',
    authFetch: fetchMock,
}));

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

const group = (id: string, over: Record<string, unknown> = {}) => ({
    item: { type: 'document', id, title: `Doc ${id}`, available: true },
    lastChangedAt: ago(5),
    changeCount: 2,
    contributors: [{ userId: EDITOR_ID, kind: 'user' }],
    stats: { wordsAdded: 12, wordsRemoved: 3, blocksChanged: 2 },
    latestVersionId: `v-${id}`,
    seenVersionId: null,
    kinds: ['edited'],
    aiAssisted: false,
    minor: false,
    unread: true,
    ...over,
});

const VISIT = { prevVisitAt: ago(600), visitStartedAt: ago(1) };

function renderSince(routes: Record<string, unknown> = {}) {
    const api = makeFakeApi({
        'POST /api/projects/p1/visit': VISIT,
        'GET /api/projects/p1/changes': { groups: [], since: 'visit', ...VISIT },
        'GET /api/projects/p1/chats': { chats: [], role: 'viewer' },
        'GET /api/projects/p1/members': makeMembers(),
        'POST /api/projects/p1/seen': { ok: true, seenAt: ago(0) },
        ...routes,
    });
    fetchMock.mockImplementation(api.fetchImpl);
    const handlers = { onOpenItem: vi.fn(), onOpenChat: vi.fn() };
    const view = render(withQueryClient(<SinceLastVisit projectId="p1" role="viewer" currentUserId={VIEWER_ID} {...handlers} />));
    return { api, user: userEvent.setup(), ...handlers, view };
}

beforeEach(() => { fetchMock.mockReset(); });

describe('SinceLastVisit', () => {
    it('posts the visit first, then asks what changed since it', async () => {
        const { api } = renderSince({ 'GET /api/projects/p1/changes': { groups: [group('d1')], since: 'visit', ...VISIT } });
        await screen.findByTestId('since-document-d1');
        const order = api.calls.filter((c) => c.path.endsWith('/visit') || c.path.endsWith('/changes')).map((c) => `${c.method} ${c.path}`);
        expect(order).toEqual(['POST /api/projects/p1/visit', 'GET /api/projects/p1/changes']);
        expect(api.callsTo('GET', '/api/projects/p1/changes')[0].query.get('since')).toBe('visit');
    });

    it('says nothing on a first visit', async () => {
        const { api, view } = renderSince({
            'POST /api/projects/p1/visit': { prevVisitAt: null, visitStartedAt: ago(0) },
            'GET /api/projects/p1/changes': { groups: [], since: 'visit', prevVisitAt: null, visitStartedAt: ago(0) },
        });
        await waitFor(() => expect(api.callsTo('GET', '/api/projects/p1/changes')).toHaveLength(1));
        await waitFor(() => expect(screen.queryByText('Loading…')).toBeNull());
        expect(view.container).toBeEmptyDOMElement();
    });

    it('shows who changed what, with the AI and the counts, and opens the item', async () => {
        const { user, onOpenItem } = renderSince({
            'GET /api/projects/p1/changes': {
                groups: [
                    group('d1', { contributors: [{ userId: EDITOR_ID, kind: 'user' }, { userId: EDITOR_ID, kind: 'ai' }], aiAssisted: true }),
                    group('n1', { item: { type: 'notebook', id: 'n1', title: 'Interview notes', available: true }, contributors: [{ userId: OWNER_ID, kind: 'user' }], kinds: ['added'], unread: false }),
                ],
                since: 'visit', ...VISIT,
            },
        });
        const row = await screen.findByTestId('since-document-d1');
        expect(row).toHaveTextContent('Doc d1');
        expect(row).toHaveTextContent('Eddie Editor, with AI');
        expect(row).toHaveTextContent('+12 words, −3 words');
        expect(within(row).getByTestId('since-unread')).toBeInTheDocument();
        const nb = screen.getByTestId('since-notebook-n1');
        expect(nb).toHaveTextContent('Olivia Owner');
        expect(nb).toHaveTextContent('New in the project');
        expect(within(nb).queryByTestId('since-unread')).toBeNull();
        await user.click(within(nb).getByTestId('since-open'));
        expect(onOpenItem).toHaveBeenCalledWith('notebook', 'n1');
    });

    it('folds small edits, lists team chats with unread messages, and marks everything seen', async () => {
        const { user, api, onOpenChat } = renderSince({
            'GET /api/projects/p1/changes': {
                groups: [group('d1'), group('d2', { minor: true }), group('d3', { minor: true })],
                since: 'visit', ...VISIT,
            },
            'GET /api/projects/p1/chats': { chats: [
                { id: 'c1', title: 'Standup', unread: 3, archived: false },
                { id: 'c2', title: 'Old', unread: 0, archived: false },
            ], role: 'viewer' },
        });
        await screen.findByTestId('since-document-d1');
        expect(screen.queryByTestId('since-document-d2')).toBeNull();
        await user.click(screen.getByTestId('since-minor'));
        expect(screen.getByTestId('since-document-d2')).toBeInTheDocument();
        expect(await screen.findByTestId('since-chat-c1')).toHaveTextContent('3 new messages');
        expect(screen.queryByTestId('since-chat-c2')).toBeNull();
        await user.click(screen.getByTestId('since-chat-c1'));
        expect(onOpenChat).toHaveBeenCalledWith('c1');
        await user.click(screen.getByTestId('since-mark-all'));
        await waitFor(() => expect(api.callsTo('POST', '/api/projects/p1/seen')).toHaveLength(1));
        await waitFor(() => expect(api.callsTo('GET', '/api/projects/p1/changes').length).toBeGreaterThan(1));
    });

});

describe('SinceLastVisit — show changes', () => {
    it('opens the item’s history on the version the reader last saw, compared with now, and marks it seen', async () => {
        const { user, api } = renderSince({
            'GET /api/projects/p1/changes': { groups: [group('d1', { seenVersionId: 'v-old' })], since: 'visit', ...VISIT },
            'POST /api/projects/p1/items/document/d1/seen': { ok: true },
            'GET /api/studio-documents/d1/versions': { versions: [], nextCursor: null },
            'GET /api/studio-documents/d1/versions/v-old': { version: { id: 'v-old', source: 'checkpoint', createdAt: ago(900), contributors: [], content: { html: '<p>We launch in May.</p>', markdown: null } } },
            'GET /api/studio-documents/d1/versions/current': { version: { id: 'current', source: 'checkpoint', createdAt: ago(1), contributors: [], content: { html: '<p>We launch in June.</p>', markdown: null } } },
        });
        await user.click(within(await screen.findByTestId('since-document-d1')).getByTestId('since-show-changes'));
        expect(await screen.findByTestId('version-history-panel')).toBeInTheDocument();
        const compare = await screen.findByTestId('compare-inline');
        await waitFor(() => expect([...compare.querySelectorAll('ins')].map((n) => n.textContent).join(' ')).toMatch(/June/));
        await waitFor(() => expect(api.callsTo('POST', '/api/projects/p1/items/document/d1/seen')).toHaveLength(1));
        expect(api.callsTo('POST', '/api/projects/p1/items/document/d1/seen')[0].body).toEqual({ versionId: 'v-d1' });
    });

    it('when the version the reader saw is no longer kept, compares from the state of the moment they saw it', async () => {
        const version = (id: string, minAgo: number, html: string) => ({ version: { id, source: 'autosave', createdAt: ago(minAgo), contributors: [], content: { html, markdown: null } } });
        const { user, api } = renderSince({
            'GET /api/projects/p1/changes': { groups: [group('d1', { seenVersionId: 'v-pruned', seenAt: ago(900) })], since: 'visit', ...VISIT },
            'POST /api/projects/p1/items/document/d1/seen': { ok: true },
            'GET /api/studio-documents/d1/versions': { versions: [version('v-late', 5, '').version, version('v-then', 950, '').version, version('v-early', 2000, '').version], nextCursor: null },
            'GET /api/studio-documents/d1/versions/v-pruned': reply(404, { error: 'Not found' }),
            'GET /api/studio-documents/d1/versions/v-then': version('v-then', 950, '<p>We launch in May.</p>'),
            'GET /api/studio-documents/d1/versions/current': version('current', 1, '<p>We launch in June.</p>'),
        });
        await user.click(within(await screen.findByTestId('since-document-d1')).getByTestId('since-show-changes'));
        expect(await screen.findByTestId('version-gone')).toHaveTextContent('closest earlier one');
        const compare = await screen.findByTestId('compare-inline');
        await waitFor(() => expect([...compare.querySelectorAll('ins')].map((n) => n.textContent).join(' ')).toMatch(/June/));
        expect(api.callsTo('GET', '/api/studio-documents/d1/versions/v-early')).toHaveLength(0);
    });

    it('offers no comparison for a meeting, which keeps no versions', async () => {
        renderSince({
            'GET /api/projects/p1/changes': { groups: [group('m1', { item: { type: 'meeting', id: 'm1', title: 'Kick-off', available: true } })], since: 'visit', ...VISIT },
        });
        const row = await screen.findByTestId('since-meeting-m1');
        expect(within(row).queryByTestId('since-show-changes')).toBeNull();
    });
});

describe('SinceLastVisit — edges', () => {
    it('says when nothing is new', async () => {
        renderSince();
        expect(await screen.findByTestId('since-nothing')).toHaveTextContent('Nothing new');
        expect(screen.queryByTestId('since-mark-all')).toBeNull();
    });

    it('names an item that left the project without its title, and offers no way in', async () => {
        renderSince({
            'GET /api/projects/p1/changes': {
                groups: [group('d9', { item: { type: 'document', id: 'd9', title: null, available: false }, kinds: ['removed'] })],
                since: 'visit', ...VISIT,
            },
        });
        const row = await screen.findByTestId('since-document-d9');
        expect(row).toHaveTextContent('A document that is no longer here');
        expect(row).toHaveTextContent('Moved out of the project');
        expect(within(row).queryByTestId('since-open')).toBeNull();
        expect(within(row).queryByTestId('since-show-changes')).toBeNull();
    });

    it('says the list could not load, and tries again on request', async () => {
        let fail = true;
        const { user } = renderSince({
            'GET /api/projects/p1/changes': () => (fail ? reply(403, { error: 'Forbidden' }) : { groups: [group('d1')], since: 'visit', ...VISIT }),
        });
        expect(await screen.findByTestId('since-failed')).toBeInTheDocument();
        fail = false;
        await user.click(screen.getByRole('button', { name: 'Try again' }));
        expect(await screen.findByTestId('since-document-d1')).toBeInTheDocument();
    });

    it('still lists the changes when the visit could not be recorded', async () => {
        renderSince({
            'POST /api/projects/p1/visit': reply(429, { error: 'Too many' }),
            'GET /api/projects/p1/changes': { groups: [group('d1')], since: 'visit', ...VISIT },
        });
        expect(await screen.findByTestId('since-document-d1')).toBeInTheDocument();
    });
});
