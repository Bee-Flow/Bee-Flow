// An item opens on its Overview (./CoworkOverview.tsx): one sentence, what waits, the goal, the last runs in plain
// lines. "Advanced" (./CoworkAdvanced.tsx) holds the brief and the Runs, Plan and Settings tabs: closed by default,
// remembered per viewer, and opened on the right tab by a link (./coworkView.ts). The network is the seam (a recording
// fetch), no module is mocked.
import { useState } from 'react';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithClient } from '@/test/render';
import { jsonResponse, stubRecordingFetch, type RecordedCall } from '@/test/recordingFetch';
import CoworkDetail from './CoworkDetail';
import CoworkNeedsYou from './CoworkNeedsYou';
import type { CoworkItem, CoworkRun } from '@/api/cowork.types';

const ITEM = {
    id: 'w1', title: 'Answer supplier mails', prompt: 'Read the new supplier mails and draft an answer to each.', isActive: true,
    lastStatus: 'success', repeatInterval: 'weekdays', timeOfDay: '16:30', runCount: 2, lastRunAt: new Date().toISOString(),
} as CoworkItem;
const RUNS: CoworkRun[] = [
    { id: 'r2', status: 'success', startedAt: new Date().toISOString(), result: '4 supplier mails read, 4 answers drafted.', producedOutput: true, activity: { tools: [{ name: 'outlook_search', app: 'outlook', ok: 1, failed: 0, refused: 0, reasons: [] }], skills: [], toolCalls: 1 } },
    { id: 'r1', status: 'error', startedAt: new Date(Date.now() - 86_400_000).toISOString(), error: 'Outlook did not answer in time (504).' },
];
const NO_PLAN = { automationId: null, draft: null, approved: null, widens: [], upToDate: true };
const ADVANCED = 'bee-flow.cowork.advanced';

let calls: RecordedCall[];
function serve() {
    calls = stubRecordingFetch(({ url }) => {
        if (url.includes('/runs')) return jsonResponse({ runs: RUNS, total: RUNS.length });
        if (url.endsWith('/stats')) return jsonResponse({ total: 2, success: 1, failed: 1, avgDurationMs: 1000, runCount: 2, createdAt: null });
        if (url.endsWith('/needs-you')) return jsonResponse({ needs: [{ kind: 'plan', itemId: 'w1', title: ITEM.title, runId: null, since: null, reason: null, plan: 'first' }] });
        if (url.endsWith('/daily-mail')) return jsonResponse({ enabled: false, timeZone: 'UTC', available: false });
        if (url.endsWith('/desk')) return jsonResponse({ desk: null });
        if (url.endsWith('/proposals')) return jsonResponse({ proposals: [] });
        if (url.endsWith('/goal')) return jsonResponse({ goal: null });
        return jsonResponse(NO_PLAN);
    });
}

const handlers = () => ({ onRunNow: vi.fn(), onToggle: vi.fn(), onDelete: vi.fn(), onSave: vi.fn(), onEdit: vi.fn(), onCancelEdit: vi.fn() });
const detail = (item: CoworkItem = ITEM) => <CoworkDetail item={item} agents={[]} {...handlers()} busy={false} reloadKey={0} editing={false} saveError={null} />;

beforeEach(() => { window.localStorage.clear(); window.sessionStorage.clear(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('CoworkOverview', () => {
    it('opens on the Overview: one plain sentence and the last runs as plain lines, without the tabs', async () => {
        serve();
        renderWithClient(detail());
        expect(screen.getByTestId('cowork-overview-sentence')).toHaveTextContent('Every weekday 16:30, the AI works on: “Read the new supplier mails and draft an answer to each”.');
        const lines = await screen.findAllByTestId('cowork-overview-run');
        expect(lines.map((l) => l.textContent)).toEqual([
            expect.stringMatching(/Finished.*4 supplier mails read, 4 answers drafted\./),
            expect.stringMatching(/Outlook did not answer in time \(504\)\./),
        ]);
        expect(screen.getByTestId('cowork-overview').textContent).not.toMatch(/outlook_search|\{/);
        expect(screen.queryByRole('tab')).toBeNull();
        expect(calls.some((c) => c.url.endsWith('/stats'))).toBe(false);
    });

    it('Advanced is closed by default; opened, it shows the tabs unchanged, and it is remembered for this viewer', async () => {
        serve();
        const user = userEvent.setup();
        const first = renderWithClient(detail());
        const toggle = screen.getByTestId('cowork-advanced-toggle');
        expect(toggle).toHaveAttribute('aria-expanded', 'false');
        await user.click(toggle);
        expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Runs', 'Plan', 'Settings']);
        expect(screen.getByTestId('cowork-brief')).toBeInTheDocument();
        expect(window.localStorage.getItem(ADVANCED)).toBe('1');
        first.unmount();

        renderWithClient(detail());
        expect(screen.getByTestId('cowork-advanced-toggle')).toHaveAttribute('aria-expanded', 'true');
        await user.click(screen.getByTestId('cowork-advanced-toggle'));
        expect(screen.queryByRole('tab')).toBeNull();
        expect(window.localStorage.getItem(ADVANCED)).toBe('0');
    });

    it('a run line opens that run under Advanced → Runs', async () => {
        serve();
        const user = userEvent.setup();
        renderWithClient(detail());
        await user.click((await screen.findAllByTestId('cowork-overview-run'))[1]);
        expect(screen.getByRole('tab', { name: 'Runs' })).toHaveAttribute('aria-selected', 'true');
        const rows = await screen.findAllByTestId('cowork-run');
        expect(within(rows[1]).getAllByRole('button')[0]).toHaveAttribute('aria-expanded', 'true');
        expect(within(rows[0]).getAllByRole('button')[0]).toHaveAttribute('aria-expanded', 'false');
    });

    it('"See the plan" on the Cowork home opens the item on Advanced → Plan', async () => {
        serve();
        function Home() {
            const [open, setOpen] = useState<string | null>(null);
            return <><CoworkNeedsYou onOpen={setOpen} />{open && detail()}</>;
        }
        const user = userEvent.setup();
        renderWithClient(<Home />);
        await user.click(await screen.findByRole('button', { name: 'See the plan' }));
        expect(await screen.findByRole('tab', { name: 'Plan' })).toHaveAttribute('aria-selected', 'true');
        expect(screen.getByTestId('cowork-advanced-toggle')).toHaveAttribute('aria-expanded', 'true');
        // A link is not the viewer's own choice: it is not remembered as such.
        expect(window.localStorage.getItem(ADVANCED)).toBeNull();
    });

    it('More → Advanced opens it from the header', async () => {
        serve();
        const user = userEvent.setup();
        renderWithClient(detail());
        await user.click(screen.getByLabelText('More actions'));
        await user.click(screen.getByTestId('cowork-menu-advanced'));
        await waitFor(() => expect(screen.getAllByRole('tab')).toHaveLength(3));
        expect(window.localStorage.getItem(ADVANCED)).toBe('1');
    });

    it('a colleague\'s invitation waits in "Needs you" and is accepted there with one click, its start included', async () => {
        let accepted = false;
        calls = stubRecordingFetch(({ method, url }) => {
            if (method === 'POST' && url.endsWith('/members/w1/accept')) {
                accepted = true;
                return jsonResponse({ desk: { id: 'd1', name: 'Invoices', isOwner: false, ownerName: 'Ann' }, members: [], roles: [], colleagues: [], plannedStart: { afterTitle: 'Supplier radar', applied: true, reason: null } });
            }
            if (url.endsWith('/w1/desk')) return jsonResponse({ desk: { id: 'd1', name: 'Invoices', accepted, deskRole: null, invitedBy: 'Ann', plannedAfter: { id: 'radar', title: 'Supplier radar', ownerName: 'Ann' } } });
            if (url.includes('/runs')) return jsonResponse({ runs: [], total: 0 });
            return jsonResponse(NO_PLAN);
        });
        const user = userEvent.setup();
        renderWithClient(detail());
        const strip = await screen.findByTestId('cowork-needs-invitation');
        expect(screen.getByTestId('cowork-needs-badge')).toHaveTextContent('Needs you (1)');
        await user.click(within(strip).getByRole('button', { name: 'Accept, and start "Answer supplier mails" after Ann\'s "Supplier radar"' }));
        expect(await screen.findByTestId('cowork-desk-planned')).toHaveTextContent('Accepted. It starts after "Supplier radar" now.');
        await waitFor(() => expect(screen.queryByTestId('cowork-needs-invitation')).toBeNull());
        expect(calls.filter((c) => c.method === 'POST' && c.url.endsWith('/accept'))).toHaveLength(1);
    });

    it('a paused item says so first', () => {
        serve();
        renderWithClient(detail({ ...ITEM, isActive: false }));
        expect(screen.getByTestId('cowork-overview-sentence').textContent).toMatch(/^Paused: nothing runs until you resume it\./);
    });
});

describe('CoworkOverview, a plan run that failed at a step', () => {
    it('says it about the plan\'s own steps, not with the runner\'s message', async () => {
        const raw = 'datetime: input "{{steps.dt_ac3ed7.output.iso}}" did not resolve to a parseable date';
        const failed: CoworkRun = { id: 'r9', status: 'error', startedAt: new Date().toISOString(), error: raw, planId: 'p1', failure: { stepId: 'dt_week', errorClass: 'datetime_unresolved_input', sourceStepId: 'dt_now' } };
        const step = (id: string, title: string) => ({ id, type: 'datetime', kind: 'fixed' as const, title, effect: 'reads' as const, app: null, tool: null, readsOutsideText: false, depth: 0 });
        const permissions = { v: 1, grants: [], sends: 'owner', ai: true, outsideText: false };
        const plan = {
            automationId: 'a1', approved: { version: 1, fingerprint: 'f', approvedAt: null, permissions }, widens: [], upToDate: true, tried: null,
            draft: { view: { trigger: 'schedule', steps: [step('dt_now', 'Now'), step('dt_week', 'A week ago')], makeUp: { fixed: 2, ai: 0, ask: 0, deliver: 0 } }, permissions, findings: [], fingerprint: 'f' },
        };
        stubRecordingFetch(({ url }) => {
            if (url.includes('/runs')) return jsonResponse({ runs: [failed], total: 1 });
            if (url.endsWith('/proposals')) return jsonResponse({ proposals: [] });
            if (url.endsWith('/needs-you')) return jsonResponse({ needs: [] });
            if (url.endsWith('/goal')) return jsonResponse({ goal: null });
            if (url.endsWith('/desk')) return jsonResponse({ desk: null });
            if (url.endsWith('/plan')) return jsonResponse(plan);
            return jsonResponse({});
        });
        renderWithClient(detail());
        await waitFor(() => expect(screen.getByTestId('cowork-overview-run-outcome')).toHaveTextContent("'A week ago' could not read the date from 'Now'."));
        expect(screen.getByTestId('cowork-overview').textContent).not.toContain('parseable');
    });
});
