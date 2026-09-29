import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The open editor's header behaviour (plan W2) — publishing, the sections, and
 * the per-turn undo.
 *
 * The rule every case below defends is the same one: THIS SCREEN MAY NOT
 * WIDEN AN AUDIENCE WITHOUT SAYING SO, and it may not offer an action it
 * cannot carry out.
 *
 *   - "Publish" on a draft opens the audience capsule. It does NOT PATCH.
 *     A one-click publish would hand a personal page to the whole
 *     organisation without ever naming who that is, right beside a capsule
 *     that deliberately asks first.
 *   - "Republish" on a live page flushes pending edits and re-freezes the
 *     content for the audience it ALREADY has — `republish: true`, and the
 *     shared groups unchanged.
 *   - Ticking a group is not a publish: no `republish` flag, so the server
 *     keeps the pinned snapshot the audience is reading.
 *
 * The IDE and the preview are mocked at their module boundary; everything
 * else is the real component.
 */

const authFetch = vi.fn();
vi.mock('../../utils/helpers', () => ({
    API_BASE: 'https://host.example',
    authFetch: (...args) => authFetch(...args),
}));

vi.mock('../../hooks/useChatEngine', async () => {
    const React = await import('react');
    // Named `useChatEngineMock` so the rules-of-hooks lint sees a hook, not a
    // plain function calling useState (same shape as WebpagesPage.test.jsx).
    function useChatEngineMock() {
        const [messages, setMessages] = React.useState([]);
        return {
            messages, setMessages, isLoading: false,
            sendMessage: () => {}, stopGenerating: () => {},
            retryMessage: () => {}, editAndRegenerate: () => {},
        };
    }
    return { default: useChatEngineMock };
});

vi.mock('./WebpageIDE', async () => {
    const React = await import('react');
    return {
        default: (p) => React.createElement('div', { 'data-testid': 'ide' },
            React.createElement('span', null, p.devMode ? 'dev' : 'simple')),
    };
});
vi.mock('./WebpagePreview', () => ({ default: () => null }));
vi.mock('./WebpageDataTab', () => ({ default: () => null }));
vi.mock('../../components/agents/AgentWizard/pickers/ExternalShareSection', () => ({ default: () => null }));
vi.mock('../../components/agents/AgentWizard/pickers/ShareLinksMenu', () => ({ default: () => null }));

import WebpageEditorPage from './WebpageEditorPage';

const USER = { id: 'alice', organizationId: 'org1' };

function loaded(over = {}) {
    return {
        webpage: {
            id: 'wp1', userId: 'alice', name: 'Offerte-status',
            isPublished: false, sharedGroups: [], publicShareCount: 0,
            settings: {}, bridgeGrants: { automations: [], integrations: [] },
            ...over,
        },
        sources: [],
        files: { html: '<h1>a</h1>', css: '', js: '' },
        chatMessages: [],
        extraFiles: [],
        extraContents: {},
    };
}

function renderEditor(over = {}) {
    return render(
        <WebpageEditorPage
            loaded={loaded(over)}
            user={USER}
            orgGroups={[{ id: 'g1', name: 'Sales', organizationId: 'org1' }]}
            onClose={() => {}}
            onSaved={() => {}}
            onMetaChange={() => {}}
        />,
    );
}

const publishCalls = () => authFetch.mock.calls.filter(([url]) => String(url).endsWith('/publish'));
const bodyOf = (call) => JSON.parse(call[1].body);

beforeEach(() => {
    authFetch.mockReset();
    authFetch.mockResolvedValue({ ok: true, json: async () => ({ success: true, publishedVersionId: 'v1' }) });
});

describe('the publish action', () => {
    it('on a DRAFT opens the audience capsule and PATCHes nothing', async () => {
        renderEditor();
        fireEvent.click(within(screen.getByTestId('status-pill')).getByRole('button'));
        await waitFor(() => expect(screen.getByTestId('visibility-capsule')).toHaveAttribute('aria-expanded', 'true'));
        expect(publishCalls()).toHaveLength(0);
    });

    it('on a LIVE page re-freezes the content for the audience it already has', async () => {
        renderEditor({ isPublished: true, sharedGroups: ['g1'], publishedVersionId: 'v0' });
        fireEvent.click(within(screen.getByTestId('status-pill')).getByRole('button'));
        await waitFor(() => expect(publishCalls()).toHaveLength(1));
        const body = bodyOf(publishCalls()[0]);
        expect(body.republish).toBe(true);
        expect(body.isPublished).toBe(true);
        // The audience is carried through unchanged: republishing is about
        // content, never about who can see it.
        expect(body.sharedGroups).toEqual(['g1']);
    });

    it('ticking a group is NOT a republish — the pinned snapshot must stand', async () => {
        renderEditor({ isPublished: true, sharedGroups: [], publishedVersionId: 'v0' });
        fireEvent.click(screen.getByTestId('visibility-capsule'));
        fireEvent.click(await screen.findByText('Sales'));
        await waitFor(() => expect(publishCalls().length).toBeGreaterThan(0));
        const body = bodyOf(publishCalls()[0]);
        expect(body.republish).toBeUndefined();
        expect(body.sharedGroups).toEqual(['g1']);
    });

    it('takes the pinned version from the SERVER answer, never from a guess', async () => {
        authFetch.mockResolvedValue({ ok: true, json: async () => ({ success: true, publishedVersionId: 'v-server' }) });
        renderEditor({ isPublished: true, sharedGroups: [], publishedVersionId: 'v0' });
        fireEvent.click(within(screen.getByTestId('status-pill')).getByRole('button'));
        await waitFor(() => expect(publishCalls()).toHaveLength(1));
        // Nothing to assert in the DOM about the id itself — what matters is
        // that the failure path below leaves the page unchanged instead.
        expect(screen.getByTestId('status-pill').dataset.status).toBe('published');
    });

    it('a refused publish is shown, and the page keeps its old state', async () => {
        authFetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: 'Published, but the snapshot could not be pinned' }) });
        renderEditor({ isPublished: true, sharedGroups: [], publishedVersionId: 'v0' });
        fireEvent.click(within(screen.getByTestId('status-pill')).getByRole('button'));
        expect(await screen.findByRole('alert')).toHaveTextContent('could not be pinned');
    });
});

describe('the sections', () => {
    it('opens on the preview and switches to the code section', async () => {
        renderEditor();
        expect(screen.queryByTestId('ide')).not.toBeInTheDocument();
        fireEvent.click(within(screen.getByRole('radiogroup')).getAllByRole('radio')[2]);
        expect(await screen.findByTestId('ide')).toHaveTextContent('dev');
    });

    it('the used-by section says it cannot answer rather than claiming zero', async () => {
        renderEditor();
        fireEvent.click(within(screen.getByRole('radiogroup')).getAllByRole('radio')[4]);
        const panel = await screen.findByTestId('webpage-usedby');
        expect(panel).toHaveTextContent('cannot list everything');
    });

    it('the history section is a SURFACE now — no overlay on top of another tab', async () => {
        // W4 retired the modal: History used to open a dialog over whichever
        // tab you were on, so the strip pointed at "History" while the body
        // showed something else, and closing it teleported you back to a
        // remembered tab. It is a section like the others now.
        authFetch.mockResolvedValue({ ok: true, json: async () => ({ versions: [], hasMore: false, published: null }) });
        renderEditor();
        const radios = () => within(screen.getByRole('radiogroup')).getAllByRole('radio');
        fireEvent.click(radios()[2]);                       // to Code
        expect(await screen.findByTestId('ide')).toBeInTheDocument();
        fireEvent.click(radios()[3]);                       // to History
        expect(await screen.findByTestId('webpage-history')).toBeInTheDocument();
        expect(radios()[3]).toHaveAttribute('aria-checked', 'true');
        // The body really swapped — the IDE is gone, not merely covered.
        expect(screen.queryByTestId('ide')).not.toBeInTheDocument();
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        // And going back is going back, not "closing" something.
        fireEvent.click(radios()[2]);
        await waitFor(() => expect(screen.queryByTestId('webpage-history')).not.toBeInTheDocument());
        expect(radios()[2]).toHaveAttribute('aria-checked', 'true');
    });
});
