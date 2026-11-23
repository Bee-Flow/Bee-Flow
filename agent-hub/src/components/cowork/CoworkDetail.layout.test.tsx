// The calm layout of an item: the header with its small menu and a "Needs you" badge only while something waits,
// the strip that holds what waits, the brief, and three tabs of which only the chosen one reads its data.
// The network is the seam (a recording fetch), no module is mocked.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithClient } from '@/test/render';
import { jsonResponse, stubRecordingFetch, type RecordedCall } from '@/test/recordingFetch';
import CoworkDetail from './CoworkDetail';
import type { CoworkItem, CoworkRun } from '@/api/cowork.types';

const ITEM = { id: 'w1', title: 'Weekly digest', prompt: 'Summarise the week', isActive: true, lastStatus: 'success', repeatInterval: 'weekly', runCount: 1 } as CoworkItem;
const STATS = { total: 1, success: 1, failed: 0, avgDurationMs: 1000, runCount: 1, createdAt: new Date(2026, 6, 8).toISOString() };
const waiting: CoworkRun = {
    id: 'r1', status: 'needs_review', startedAt: new Date().toISOString(),
    review: { reason: 'The discount is not in the price list.', question: 'Which discount applies?', summary: 'I read the mail.', resolution: null, resolvedBy: null, resolvedAt: null },
} as CoworkRun;

let calls: RecordedCall[];
function serve(runs: CoworkRun[] = []) {
    calls = stubRecordingFetch(({ url }) => {
        if (url.includes('/runs')) return jsonResponse({ runs, total: runs.length });
        if (url.endsWith('/stats')) return jsonResponse(STATS);
        if (url.endsWith('/shares')) return jsonResponse({ shares: [] });
        if (url.endsWith('/colleagues')) return jsonResponse({ colleagues: [] });
        if (url.endsWith('/audit')) return jsonResponse({ entries: [] });
        if (url.endsWith('/start')) return jsonResponse({ kind: 'schedule', after: null, datatableId: null, inFolder: null, hasAddress: false });
        return jsonResponse({ automationId: null, draft: null, approved: null, widens: [], upToDate: true });
    });
}

function renderDetail(over: Partial<CoworkItem> = {}) {
    const handlers = { onRunNow: vi.fn(), onToggle: vi.fn(), onDelete: vi.fn(), onSave: vi.fn(), onEdit: vi.fn(), onCancelEdit: vi.fn() };
    renderWithClient(<CoworkDetail item={{ ...ITEM, ...over }} agents={[]} {...handlers} busy={false} reloadKey={0} editing={false} saveError={null} />);
    return handlers;
}

/** The settings panels' reads: none of them may happen before the Settings tab is shown. */
const settingsReads = () => calls.filter((c) => /\/(shares|colleagues|audit|start)$/.test(c.url));

beforeEach(() => { window.sessionStorage.clear(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('CoworkDetail — the layout', () => {
    it('opens on the Runs tab: the figures as one line above the history', async () => {
        serve();
        renderDetail();
        const panel = screen.getByRole('tabpanel');
        expect(screen.getByRole('tab', { name: 'Runs' })).toHaveAttribute('aria-selected', 'true');
        expect(within(panel).getByTestId('cowork-stats')).toBeInTheDocument();
        expect(await within(panel).findByTestId('cowork-history')).toBeInTheDocument();
        expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Runs', 'Plan', 'Settings']);
    });

    it('reads the settings panels only once their tab is shown', async () => {
        serve();
        renderDetail();
        await screen.findByTestId('cowork-history');
        expect(settingsReads()).toHaveLength(0);
        expect(screen.queryByTestId('cowork-share')).toBeNull();

        await userEvent.setup().click(screen.getByRole('tab', { name: 'Settings' }));
        expect(screen.getByTestId('cowork-settings')).toBeInTheDocument();
        await waitFor(() => expect(settingsReads().length).toBeGreaterThanOrEqual(4));
    });

    it('shows no badge and no strip while nothing waits', async () => {
        serve();
        renderDetail();
        await screen.findByTestId('cowork-history');
        expect(screen.queryByTestId('cowork-needs-badge')).toBeNull();
        expect(screen.queryByTestId('cowork-needs-strip')).toBeNull();
    });

    it('a run that waits shows "Needs you (1)" in the header, and the badge takes the reader to the strip', async () => {
        serve([waiting]);
        renderDetail();
        const badge = await screen.findByTestId('cowork-needs-badge');
        expect(badge).toHaveTextContent('Needs you (1)');
        const strip = screen.getByTestId('cowork-needs-strip');
        expect(within(strip).getByTestId('cowork-review-queue')).toBeInTheDocument();
        await userEvent.setup().click(badge);
        expect(strip).toHaveFocus();
        // One read of the runs serves the badge, the strip and the history.
        expect(calls.filter((c) => c.url.includes('/runs'))).toHaveLength(1);
    });

    it('keeps Edit and Delete in a small menu next to Run now and Pause', async () => {
        serve();
        const handlers = renderDetail();
        const user = userEvent.setup();
        const menu = screen.getByTestId('cowork-menu');
        expect(menu).not.toHaveAttribute('open');
        await user.click(screen.getByLabelText('More actions'));
        expect(menu).toHaveAttribute('open');
        await user.click(screen.getByTestId('cowork-edit'));
        expect(handlers.onEdit).toHaveBeenCalledTimes(1);
        expect(menu).not.toHaveAttribute('open');

        await user.click(screen.getByLabelText('More actions'));
        await user.keyboard('{Escape}');
        expect(menu).not.toHaveAttribute('open');
    });

    it('an item that starts on a new mail is offered a plan like any other (it drafts its replies)', async () => {
        serve();
        renderDetail({ triggerKind: 'app_event', trigger: { provider: 'gmail', event: 'mail.new', filter: {} } } as Partial<CoworkItem>);
        await userEvent.setup().click(screen.getByRole('tab', { name: 'Plan' }));
        // Its licence decides, as for any item: nothing says that a mail start rules a plan out.
        await screen.findByRole('tabpanel');
        expect(screen.queryByText(/starts on a new mail runs without a plan/)).toBeNull();
    });
});
