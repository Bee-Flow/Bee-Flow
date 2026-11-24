// The Cowork page (./CoworkPage.tsx): the home in one column, and a sheet from the right for a task and for what the
// header's menu opens (./coworkSheetPanels.ts). A task opens from its row or a deep link, says so in the address, and
// closes back to the row. The network is the seam (a recording fetch); no module is mocked.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithClient } from '@/test/render';
import { jsonResponse, stubRecordingFetch, type RecordedCall } from '@/test/recordingFetch';
import CoworkPage from './CoworkPage';
import type { CoworkItem } from '@/api/cowork.types';

const ITEM: CoworkItem = {
    id: 'w1', title: 'Weekly digest', prompt: 'Summarise the week', isActive: true, repeatInterval: 'weekly', nextRunAt: new Date(Date.now() + 86_400_000).toISOString(),
    lastStatus: 'success', lastRunAt: new Date().toISOString(), runCount: 3,
};
const NO_PLAN = { automationId: null, draft: null, approved: null, widens: [], upToDate: true };

let calls: RecordedCall[];
function serve(items: CoworkItem[] = [ITEM]) {
    calls = stubRecordingFetch(({ url, method }) => {
        const path = new URL(url, 'http://x').pathname;
        if (path === '/api/cowork' && method === 'GET') return jsonResponse({ schedules: items, maxSchedules: 10 });
        if (path === '/api/cowork' && method === 'POST') return jsonResponse({ id: 'new', title: 'Meeting overview', prompt: 'Summarise', runCount: 0 });
        if (path === '/api/cowork/w1' && method === 'GET') return jsonResponse(items.find((i) => i.id === 'w1') ?? {}, items.some((i) => i.id === 'w1') ? 200 : 404);
        if (path === '/api/cowork/w1' && method === 'DELETE') return jsonResponse({ success: true });
        if (path === '/api/cowork/compose') return jsonResponse({ title: 'Meeting overview', prompt: 'Summarise', repeatInterval: 'daily', timeOfDay: '09:00' });
        if (path === '/api/cowork/home') return jsonResponse({ how: {}, today: [], cost: null });
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

describe('CoworkPage', () => {
    it('opens a task from its row in the sheet, says so in the address, and closes back to the row', async () => {
        serve();
        const onNavigate = vi.fn();
        renderWithClient(<CoworkPage onNavigate={onNavigate} />);
        const user = userEvent.setup();
        const row = await screen.findByRole('button', { name: /Weekly digest/ });
        await user.click(row);
        const sheet = await screen.findByRole('dialog', { name: 'Weekly digest' });
        expect(await within(sheet).findByTestId('cowork-task-view')).toBeInTheDocument();
        expect(onNavigate).toHaveBeenLastCalledWith('cowork/w1');
        await user.click(within(sheet).getByTestId('cowork-sheet-close'));
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(onNavigate).toHaveBeenLastCalledWith('cowork');
        expect(row).toHaveFocus();
    });

    it('a deep link opens the task in the sheet', async () => {
        serve();
        renderWithClient(<CoworkPage initialCoworkId="w1" />);
        expect(await screen.findByRole('dialog', { name: 'Weekly digest' })).toBeInTheDocument();
    });

    it('the menu offers Settings, Teamwork and Templates; Organisation only to an administrator', async () => {
        serve();
        const user = userEvent.setup();
        const { unmount } = renderWithClient(<CoworkPage user={{ id: 'u1', organizationId: 'o1', orgRole: 'member' }} />);
        await user.click(screen.getByRole('button', { name: 'Your menu' }));
        expect(within(screen.getByRole('menu')).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Settings', 'Teamwork', 'Templates']);
        unmount();
        renderWithClient(<CoworkPage user={{ id: 'u1', organizationId: 'o1', orgRole: 'org_admin' }} />);
        await user.click(screen.getByRole('button', { name: 'Your menu' }));
        expect(within(screen.getByRole('menu')).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Settings', 'Teamwork', 'Templates', 'OrganisationAdmin']);
        await user.keyboard('{Escape}');
        expect(screen.queryByRole('menu')).toBeNull();
        expect(screen.getByRole('button', { name: 'Your menu' })).toHaveFocus();
    });

    it('a menu entry opens its panel in the sheet', async () => {
        serve();
        const user = userEvent.setup();
        renderWithClient(<CoworkPage />);
        await user.click(screen.getByRole('button', { name: 'Your menu' }));
        await user.click(screen.getByRole('menuitem', { name: 'Templates' }));
        const sheet = await screen.findByRole('dialog', { name: 'Templates' });
        expect(await within(sheet).findByTestId('cowork-templates-panel')).toBeInTheDocument();
        await user.keyboard('{Escape}');
        await user.click(screen.getByRole('button', { name: 'Your menu' }));
        await user.click(screen.getByRole('menuitem', { name: 'Settings' }));
        expect(await screen.findByTestId('cowork-settings-panel')).toBeInTheDocument();
    });

    it('"Start from a template" under the composer opens Templates in the sheet', async () => {
        serve();
        const user = userEvent.setup();
        renderWithClient(<CoworkPage />);
        await user.click(screen.getByRole('button', { name: 'Start from a template' }));
        expect(await screen.findByRole('dialog', { name: 'Templates' })).toBeInTheDocument();
    });

    it('deleting a task from the sheet asks once in the page, deletes it and closes the sheet', async () => {
        serve();
        const user = userEvent.setup();
        renderWithClient(<CoworkPage initialCoworkId="w1" />);
        const sheet = await screen.findByRole('dialog', { name: 'Weekly digest' });
        await user.click(await within(sheet).findByRole('button', { name: 'More' }));
        await user.click(within(sheet).getByRole('button', { name: 'Delete this task' }));
        expect(within(sheet).getByTestId('cowork-task-delete-confirm')).toHaveTextContent("Delete 'Weekly digest'? It stops for good, with its runs. This cannot be undone.");
        expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
        await user.click(within(sheet).getByRole('button', { name: 'Delete task' }));
        await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && path(c) === '/api/cowork/w1')).toBe(true));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });

    it('a new task is started, then Cowork sets up and tests its steps', async () => {
        serve([]);
        const user = userEvent.setup();
        renderWithClient(<CoworkPage />);
        expect(await screen.findByText('No tasks yet. Write one sentence above to start.')).toBeInTheDocument();
        await user.type(screen.getByLabelText('Describe the task in one sentence'), 'Every day at 9, summarise my meetings');
        await user.click(screen.getByRole('button', { name: 'Continue' }));
        await user.click(await screen.findByRole('button', { name: 'Start' }));
        await waitFor(() => expect(calls.some((c) => c.method === 'POST' && path(c) === '/api/cowork/new/plan/make')).toBe(true));
    });
});
