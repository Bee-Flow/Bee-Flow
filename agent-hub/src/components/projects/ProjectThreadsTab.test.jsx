import { render, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

/**
 * CHARACTERISATION — the shared-conversations list as it behaves today (PRJ-0).
 *
 * Translation is stubbed to the identity translator on purpose: this file pins
 * WHICH key the tab reaches for and WHEN, not what today's dictionary happens
 * to say. The wording is the i18n track's business (PRJ-11); the branch that
 * picks the key is this screen's.
 */
vi.mock('../../hooks/useTranslation', () => ({
    default: () => ({ t: (k, fallback) => (typeof fallback === 'string' ? fallback : k), locale: 'en' }),
    useTranslation: () => ({ t: (k, fallback) => (typeof fallback === 'string' ? fallback : k), locale: 'en' }),
}));

const { default: ProjectThreadsTab } = await import('./ProjectThreadsTab');

const MINE = { id: 'c-mine', type: 'direct', ownerId: 'me', title: 'Pricing questions' };
const THEIRS = { id: 'c-theirs', type: 'direct', ownerId: 'anna', title: 'Supplier list', ownerName: 'Anna' };

const renderTab = (props = {}) => render(
    <ProjectThreadsTab
        threads={[MINE, THEIRS]}
        loading={false}
        role="owner"
        currentUserId="me"
        {...props}
    />,
);

describe('while the list is still loading', () => {
    it('spins rather than claiming nothing is shared', () => {
        const { container, queryByText } = renderTab({ loading: true, threads: [] });
        expect(container.querySelector('.animate-spin')).toBeTruthy();
        expect(queryByText('projects.no_shared_threads')).toBeNull();
    });
});

describe('when nothing is shared yet', () => {
    it('says so and explains that only the owner can share', () => {
        const { getByText } = renderTab({ threads: [] });
        expect(getByText('projects.no_shared_threads')).toBeTruthy();
        expect(getByText('projects.share_owner_only')).toBeTruthy();
    });

    it('treats a missing list the same as an empty one', () => {
        const { getByText } = renderTab({ threads: undefined });
        expect(getByText('projects.no_shared_threads')).toBeTruthy();
    });

    it('shows the same empty state to a viewer', () => {
        const { getByText } = renderTab({ threads: [], role: 'viewer' });
        expect(getByText('projects.no_shared_threads')).toBeTruthy();
    });
});

describe('the hint above the list', () => {
    it('tells an editor that everyone reads and editors reply', () => {
        const { getByText } = renderTab({ role: 'editor' });
        expect(getByText('Everyone in this project can read these. Editors can reply.')).toBeTruthy();
    });

    it('tells a viewer the project is read-only for them', () => {
        const { getByText } = renderTab({ role: 'viewer' });
        expect(getByText('projects.viewer_readonly')).toBeTruthy();
    });
});

describe('the rows', () => {
    it('lists one row per shared conversation, titles and all', () => {
        const { getByText } = renderTab();
        expect(getByText('Pricing questions')).toBeTruthy();
        expect(getByText('Supplier list')).toBeTruthy();
    });

    it('falls back to the untitled-chat label for a conversation with no title', () => {
        const { getByText } = renderTab({ threads: [{ ...MINE, title: null }] });
        expect(getByText('sidebar.untitled_chat')).toBeTruthy();
    });

    it('opens the conversation when its row is clicked', () => {
        const onOpenThread = vi.fn();
        const { getByText } = renderTab({ onOpenThread });
        fireEvent.click(getByText('Supplier list'));
        expect(onOpenThread).toHaveBeenCalledWith(THEIRS);
    });
});

describe('whose conversation it is', () => {
    it('names the colleague who shared a conversation that is not yours', () => {
        const { getByText } = renderTab();
        expect(getByText(/Anna/)).toBeTruthy();
    });

    it('falls back to a generic "shared" badge when the server sent no owner name', () => {
        const { getByText } = renderTab({ threads: [{ ...THEIRS, ownerName: undefined }] });
        expect(getByText(/shared/)).toBeTruthy();
    });

    it('adds no owner badge to your own conversation', () => {
        const { container } = renderTab({ threads: [MINE] });
        expect(container.textContent).not.toContain('shared');
    });

    // wrat: ownership is decided on ownerId alone, so a page rendered before
    // the user is known (currentUserId undefined) marks EVERY conversation as
    // someone else's and hides every unshare button. Hoort in stage PRJ-5 te
    // veranderen.
    it('treats every conversation as a colleague\'s while the current user is unknown', () => {
        const { container, queryByTitle } = renderTab({ currentUserId: undefined });
        expect(container.textContent).toContain('Anna');
        expect(queryByTitle('projects.unshare_thread')).toBeNull();
    });
});

describe('unsharing', () => {
    it('offers unshare on your own conversation only', () => {
        const { getAllByTitle } = renderTab();
        expect(getAllByTitle('projects.unshare_thread')).toHaveLength(1);
    });

    it('hands the whole thread back to the caller', () => {
        const onUnshare = vi.fn();
        const { getByTitle } = renderTab({ onUnshare });
        fireEvent.click(getByTitle('projects.unshare_thread'));
        expect(onUnshare).toHaveBeenCalledWith(MINE);
    });

    // wrat: unshare is gated on ownership but NOT on role, so a viewer who owns
    // a shared conversation still sees the button here. That happens to match
    // the server (only the owner can re-encrypt), but the screen never says so.
    // Hoort in stage PRJ-5 te veranderen.
    it('keeps offering unshare to a viewer who owns the conversation', () => {
        const { getByTitle } = renderTab({ role: 'viewer' });
        expect(getByTitle('projects.unshare_thread')).toBeTruthy();
    });
});

describe('a run in flight', () => {
    it('marks only the conversation that is being answered', () => {
        const { getAllByText } = renderTab({ activeRuns: { 'c-theirs': true } });
        expect(getAllByText('answering…')).toHaveLength(1);
    });

    it('marks nothing when no run is active', () => {
        const { queryByText } = renderTab({ activeRuns: {} });
        expect(queryByText('answering…')).toBeNull();
    });

    it('defaults to no run markers when the prop is left off entirely', () => {
        const { queryByText } = render(
            <ProjectThreadsTab threads={[MINE]} loading={false} role="owner" currentUserId="me" />,
        );
        expect(queryByText('answering…')).toBeNull();
    });
});
