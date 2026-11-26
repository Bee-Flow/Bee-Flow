// The Cowork page (./CoworkPage.tsx): the home in one column, and a task, Cowork preferences, Teamwork, Templates and
// Admin rules each as a full page in its place (./coworkSheetPanels.ts), never as a layer over it. A page says so in
// the address, takes the focus to its heading, and gives it back to what opened it; the address decides on Back.
// The network is the seam (a recording fetch); no module is mocked.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderWithClient } from '@/test/render';
import { jsonResponse, stubRecordingFetch, type RecordedCall } from '@/test/recordingFetch';
import { EntitlementsProvider } from '../licensing/EntitlementsContext';
import CoworkPage from './CoworkPage';
import { softClasses } from './crisp.testkit';
import type { CoworkItem } from '@/api/cowork.types';

const ITEM: CoworkItem = {
    id: 'w1', title: 'Weekly digest', prompt: 'Summarise the week', isActive: true, repeatInterval: 'weekly', nextRunAt: new Date(Date.now() + 86_400_000).toISOString(),
    lastStatus: 'success', lastRunAt: new Date().toISOString(), runCount: 3,
};
const NO_PLAN = { automationId: null, draft: null, approved: null, widens: [], upToDate: true };
const TEMPLATE = { id: 't1', title: 'Monday summary', brief: 'Every Monday, summarise last week’s meetings', repeatInterval: 'weekly', hasPlan: false, createdAt: null, mine: false };

let calls: RecordedCall[];
function serve(items: CoworkItem[] = [ITEM]) {
    calls = stubRecordingFetch(({ url, method }) => {
        const path = new URL(url, 'http://x').pathname;
        if (path.endsWith('/my-entitlements')) return jsonResponse({ tier: 'full', effective: { core: ['automations'] } });
        if (path === '/api/cowork' && method === 'GET') return jsonResponse({ schedules: items, maxSchedules: 10 });
        // A new task that waits for its steps (server usecases/coworkSetup.mts): the home then sets them up and tests them.
        if (path === '/api/cowork' && method === 'POST') return jsonResponse({ id: 'new', title: 'Meeting overview', prompt: 'Summarise', runCount: 0, setup: { steps: 'wanted', cause: null, since: null, sendsTo: null, askFirst: null, canUndo: false } });
        if (path === '/api/cowork/new' && method === 'GET') return jsonResponse({ id: 'new', title: 'Meeting overview', prompt: 'Summarise', runCount: 0, setup: { steps: 'wanted', cause: null, since: null, sendsTo: null, askFirst: null, canUndo: false } });
        if (path === '/api/cowork/w1' && method === 'GET') return jsonResponse(items.find((i) => i.id === 'w1') ?? {}, items.some((i) => i.id === 'w1') ? 200 : 404);
        if (path === '/api/cowork/compose') return jsonResponse({ title: 'Meeting overview', prompt: 'Summarise', repeatInterval: 'daily', timeOfDay: '09:00' });
        if (path === '/api/cowork/home') return jsonResponse({ how: {}, today: [], cost: null });
        if (path === '/api/cowork/templates') return jsonResponse({ templates: [TEMPLATE] });
        if (path.endsWith('/runs')) return jsonResponse({ runs: [], total: 0 });
        if (path.endsWith('/needs-you')) return jsonResponse({ needs: [] });
        if (path.endsWith('/desk')) return jsonResponse({ desk: null });
        if (path.endsWith('/proposals')) return jsonResponse({ proposals: [] });
        if (path.endsWith('/goal')) return jsonResponse({ goal: null });
        if (path.endsWith('/plan')) return jsonResponse(NO_PLAN);
        return jsonResponse({});
    });
}
afterEach(() => { vi.unstubAllGlobals(); });

const path = (c: RecordedCall) => new URL(c.url, 'http://x').pathname;
const ADMIN = { id: 'u1', organizationId: 'o1', orgRole: 'org_admin' };
const MEMBER = { id: 'u1', organizationId: 'o1', orgRole: 'member' };

/** Nothing lies over the page: no dialog, no scrim, no sheet. */
function expectNoOverlay() {
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.querySelector('[aria-modal="true"]')).toBeNull();
    expect(screen.queryByTestId('cowork-sheet')).toBeNull();
    // A page is a child of the Cowork column itself, not a portal next to it.
    expect(screen.getByTestId('cowork-page')).toContainElement(screen.getByTestId('cowork-page-frame'));
}

// Each page is its own chunk (./coworkSheetPanels.ts). Loading them here keeps the first load of a chunk, which is slow
// on a busy runner, out of the one second a test waits for a page to appear.
beforeAll(async () => {
    await Promise.all([
        import('./task/CoworkTaskView'), import('./task/CoworkTaskShared'), import('./panels/CoworkSettingsPanel'),
        import('./panels/CoworkTeamworkPanel'), import('./panels/CoworkTemplatesPanel'), import('./panels/CoworkOrgPanel'),
    ]);
}, 60_000);

describe('CoworkPage', () => {
    it('opens a task from its row as a page in place of the home, says so in the address, and "Tasks" goes back to the row', async () => {
        serve();
        const onNavigate = vi.fn();
        renderWithClient(<CoworkPage onNavigate={onNavigate} />);
        const user = userEvent.setup();
        const row = await screen.findByRole('button', { name: /Weekly digest/ });
        await user.click(row);
        const heading = await screen.findByRole('heading', { name: 'Weekly digest' });
        expectNoOverlay();
        expect(screen.getByTestId('cowork-home')).not.toBeVisible();
        expect(onNavigate).toHaveBeenLastCalledWith('cowork/w1');
        await waitFor(() => expect(heading).toHaveFocus());
        await user.click(screen.getByRole('button', { name: 'Tasks' }));
        expect(screen.queryByTestId('cowork-page-frame')).toBeNull();
        expect(screen.getByTestId('cowork-home')).toBeVisible();
        expect(onNavigate).toHaveBeenLastCalledWith('cowork');
        expect(row).toHaveFocus();
    });

    it('the address decides: a link opens the task as a page, and the browser’s Back returns to the home', async () => {
        serve();
        const { rerender } = renderWithClient(<CoworkPage initialCoworkId="w1" />);
        expect(await screen.findByRole('heading', { name: 'Weekly digest' })).toBeInTheDocument();
        expect(screen.getByTestId('cowork-page-frame')).toHaveAccessibleName('Weekly digest');
        expectNoOverlay();
        // Back: the address is /app/cowork again.
        rerender(<CoworkPage initialCoworkId={null} />);
        expect(screen.queryByTestId('cowork-page-frame')).toBeNull();
        expect(screen.getByTestId('cowork-home')).toBeVisible();
        // Forward: the task again.
        rerender(<CoworkPage initialCoworkId="w1" />);
        expect(await screen.findByRole('heading', { name: 'Weekly digest' })).toBeInTheDocument();
    });

    it('Back after opening a row gives the focus back to that row', async () => {
        serve();
        const { rerender } = renderWithClient(<CoworkPage />);
        const row = await screen.findByRole('button', { name: /Weekly digest/ });
        await userEvent.setup().click(row);
        // The router follows the click, then the reader presses Back.
        rerender(<CoworkPage initialCoworkId="w1" />);
        expect(await screen.findByRole('heading', { name: 'Weekly digest' })).toBeInTheDocument();
        rerender(<CoworkPage initialCoworkId={null} />);
        expect(screen.queryByTestId('cowork-page-frame')).toBeNull();
        expect(row).toHaveFocus();
    });

    it('the header has a gear for Cowork preferences and no menu; it opens the page with the focus on its heading', async () => {
        serve();
        const onNavigate = vi.fn();
        const user = userEvent.setup();
        renderWithClient(<CoworkPage user={MEMBER} onNavigate={onNavigate} />);
        expect(screen.queryByRole('button', { name: 'Your menu' })).toBeNull();
        expect(screen.queryByRole('menu')).toBeNull();
        const gear = screen.getByRole('button', { name: 'Cowork preferences' });
        await user.click(gear);
        const heading = await screen.findByRole('heading', { level: 1, name: 'Cowork preferences' });
        await waitFor(() => expect(heading).toHaveFocus());
        expect(onNavigate).toHaveBeenLastCalledWith('cowork/preferences');
        expectNoOverlay();
        await user.click(screen.getByRole('button', { name: 'Tasks' }));
        expect(gear).toHaveFocus();
    });

    it('offers Admin rules to an administrator of the organisation only', async () => {
        serve();
        const user = userEvent.setup();
        const { unmount } = renderWithClient(<CoworkPage user={MEMBER} />);
        expect(screen.queryByRole('button', { name: 'Admin rules' })).toBeNull();
        unmount();
        const onNavigate = vi.fn();
        renderWithClient(<CoworkPage user={ADMIN} onNavigate={onNavigate} />);
        await user.click(screen.getByRole('button', { name: 'Admin rules' }));
        expect(await screen.findByTestId('cowork-org-panel')).toBeInTheDocument();
        expect(onNavigate).toHaveBeenLastCalledWith('cowork/admin-rules');
    });

    it('"Start from a template" opens Templates as a page; "Use" puts the sentence in the composer, back on the home', async () => {
        serve();
        const user = userEvent.setup();
        renderWithClient(<CoworkPage />);
        await user.click(screen.getByText('Start from a template'));
        await user.click(screen.getByRole('button', { name: 'All templates' }));
        expect(await screen.findByRole('heading', { level: 1, name: 'Start from a template' })).toBeInTheDocument();
        expectNoOverlay();
        await user.click(await screen.findByRole('button', { name: 'Use “Monday summary”' }));
        expect(screen.queryByTestId('cowork-page-frame')).toBeNull();
        expect(screen.getByTestId('cowork-brief-input')).toHaveValue('Every Monday, summarise last week’s meetings');
    });

    it('Teamwork is always on the home, also for someone on no desk, and opens its page', async () => {
        serve();
        const onNavigate = vi.fn();
        renderWithClient(<CoworkPage onNavigate={onNavigate} />);
        const entry = await screen.findByTestId('cowork-teamwork');
        expect(entry).toHaveTextContent('Let your tasks work together with colleagues’ tasks');
        await userEvent.setup().click(entry);
        expect(await screen.findByTestId('cowork-teamwork-panel')).toBeInTheDocument();
        expect(onNavigate).toHaveBeenLastCalledWith('cowork/teamwork');
    });

    it('keeps what was being written on the home while a page is open', async () => {
        serve();
        const user = userEvent.setup();
        renderWithClient(<CoworkPage />);
        await user.type(screen.getByTestId('cowork-brief-input'), 'Every day at 9');
        await user.click(screen.getByRole('button', { name: 'Cowork preferences' }));
        await screen.findByTestId('cowork-settings-panel');
        await user.click(screen.getByRole('button', { name: 'Tasks' }));
        expect(screen.getByTestId('cowork-brief-input')).toHaveValue('Every day at 9');
    });

    it('a new task is started, then Cowork sets up and tests its steps', async () => {
        serve([]);
        const user = userEvent.setup();
        renderWithClient(<EntitlementsProvider><CoworkPage /></EntitlementsProvider>);
        expect(await screen.findByText('No tasks yet. Write one sentence above to start.')).toBeInTheDocument();
        await user.type(screen.getByTestId('cowork-brief-input'), 'Every day at 9, summarise my meetings');
        await user.click(screen.getByTestId('cowork-continue'));
        expect(screen.queryByText('Review your task')).toBeNull();
        await waitFor(() => expect(calls.some((c) => c.method === 'POST' && path(c) === '/api/cowork/new/plan/make')).toBe(true));
    });
});

describe('the Cowork page is crisp', () => {
    it('nothing that holds text carries a transform, a filter or a backdrop filter at rest: the home, and a page', async () => {
        serve();
        const user = userEvent.setup();
        renderWithClient(<CoworkPage user={ADMIN} />);
        await screen.findByRole('button', { name: /Weekly digest/ });
        expect(softClasses(screen.getByTestId('cowork-page'))).toEqual([]);
        for (const [opener, shows] of [['Cowork preferences', 'cowork-settings-panel'], ['Admin rules', 'cowork-org-panel'], ['All templates', 'cowork-templates-panel']] as const) {
            if (opener === 'All templates') await user.click(screen.getByText('Start from a template'));
            await user.click(screen.getByRole('button', { name: opener }));
            await screen.findByTestId(shows);
            expect(softClasses(screen.getByTestId('cowork-page'))).toEqual([]);
            await user.click(screen.getByRole('button', { name: 'Tasks' }));
        }
        await user.click(screen.getByTestId('cowork-teamwork'));
        await within(screen.getByTestId('cowork-page-frame')).findByTestId('cowork-teamwork-panel');
        expect(softClasses(screen.getByTestId('cowork-page'))).toEqual([]);
    });

    it('the check sees a soft class, and lets the ones that are not at rest through', () => {
        const box = document.createElement('div');
        box.innerHTML = '<p class="translate-y-0 hover:scale-105">a</p><p class="backdrop-blur-sm">b</p><span class="animate-spin"></span><p class="after:translate-x-1 motion-safe:animate-spin">c</p><p class="cowork-enter">d</p>';
        expect(softClasses(box)).toEqual(['p.translate-y-0', 'p.backdrop-blur-sm', 'p.motion-safe:animate-spin']);
    });
});
