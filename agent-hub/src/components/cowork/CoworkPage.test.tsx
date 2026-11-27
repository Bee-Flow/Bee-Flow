// The Cowork page (./CoworkPage.tsx): the home in one column, and a task, Cowork preferences, Teamwork, Templates and
// Admin rules each as a full page in its place (./coworkSheetPanels.ts), never as a layer over it. A page says so in
// the address, takes the focus to its heading, and gives it back to what opened it; the address decides on Back.
// The network is the seam (a recording fetch); no module is mocked.
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, beforeAll, describe, expect, it, vi } from 'vitest';
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
function serve(items: CoworkItem[] = [ITEM], homeIntent?: (body: unknown) => Response, taskReply?: () => Response, shared = false) {
    calls = stubRecordingFetch(({ url, method, body }) => {
        const path = new URL(url, 'http://x').pathname;
        if (path === '/api/cowork/home/intent' && homeIntent) return homeIntent(body);
        if (shared && path === '/api/cowork/shared') return jsonResponse({items: [{...ITEM, id:'s1', title:'Planning', ownerName:'Noor', role:'viewer'}]});
        if (shared && path === '/api/cowork/shared/s1') return jsonResponse({item: {...ITEM, id:'s1', title:'Planning'}, runs: [], role:'viewer'});
        if (shared && path === '/api/cowork/s1/conversation') return jsonResponse({action:'answer', answer:'Noor shared the current planning.'});
        if (path === '/api/cowork/w1/conversation') return taskReply?.() ?? jsonResponse({ action: 'answer', answer: 'Your digest is ready.', instruction: '' });
        if (path.endsWith('/my-entitlements')) return jsonResponse({ tier: 'full', effective: { core: ['automations'] } });
        if (path === '/api/cowork' && method === 'GET') return jsonResponse({ schedules: items, maxSchedules: 10 });
        // A new task that waits for its steps (server usecases/coworkSetup.mts): the home then sets them up and tests them.
        if (path === '/api/cowork' && method === 'POST') return jsonResponse({ id: 'new', title: 'Meeting overview', prompt: 'Summarise', runCount: 0, setup: { steps: 'wanted', cause: null, since: null, sendsTo: null, askFirst: null, canUndo: false } });
        if (path === '/api/cowork/new/plan/make' && method === 'POST') {
            return new Response('event: done\ndata: {"summary":"ok","state":{"automationId":"auto-1"}}\n\n', {headers: {'content-type': 'text/event-stream'}});
        }
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

async function openDashboard() {
    await userEvent.setup().click(screen.getByRole('button', {name: 'Advanced'}));
}

beforeEach(() => { localStorage.setItem('cowork.2.view.u1', 'orb'); });

describe('CoworkPage', () => {
    it('introduces a new account with sample steps, then remembers its chat-only choice', async () => {
        const user = userEvent.setup();
        const viewer = {id: 'tour-test'};
        localStorage.removeItem('cowork.2.view.tour-test');
        serve();
        vi.useFakeTimers();
        const first = renderWithClient(<CoworkPage user={viewer} />);
        try {
            expect(screen.queryByRole('button', {name: 'Chat only'})).toBeNull();
            const advance = () => { act(() => vi.advanceTimersByTime(30000)); };
            const until = (appears: () => HTMLElement | null) => {
                for (let scene = 0; scene < 35 && !appears(); scene++) advance();
                expect(appears()).toBeInTheDocument();
            };
            until(() => screen.queryByRole('button', {name: /Find a meeting in Meeting Notes/}));
            until(() => document.querySelector('li[aria-current="step"]')?.textContent?.includes('Retrieve the selected Meeting Notes record') ? screen.queryByRole('button', {name: /Retrieve the selected Meeting Notes record/}) : null);
            until(() => screen.queryByRole('button', {name: /Calculate last week/}));
            expect(screen.getByRole('button', {name: /Calculate last week/}).closest('li')).toHaveAttribute('aria-current', 'step');
            expect(screen.getByRole('button', {name: /Read the Meeting Notes source table/})).toBeInTheDocument();
            expect(screen.getByRole('button', {name: /Show the digest in Cowork/})).toBeInTheDocument();
            until(() => screen.queryByText('Weekly digest', {exact:true}));
            until(() => screen.queryByText('Waiting for Noor to accept'));
            until(() => screen.queryByText('Accepted · Starts after the weekly digest'));
            until(() => screen.queryByText('Pilot questions · Noor, with Alex as stand-in'));
            until(() => screen.queryByRole('button', {name: 'Chat only'}));
        } finally { vi.useRealTimers(); }
        await user.click(screen.getByRole('button', {name: 'Chat only'}));
        first.unmount();
        renderWithClient(<CoworkPage user={viewer}/>);
        expect(await screen.findByRole('textbox', {name: /Ask Bee/})).toBeInTheDocument();
        expect(document.querySelector('.cowork-orb')).toBeNull();
    });
    it('opens with Bee and a focused input ready for a keyboard request', async () => {
        serve();
        renderWithClient(<CoworkPage />);
        expect(await screen.findByTestId('cowork-brief-input')).toHaveFocus();
        expect(screen.queryByText('Your tasks')).toBeNull();
        expect(screen.queryByText('Start from a template')).toBeNull();
        expect(screen.queryByText('Task instructions')).toBeNull();
        const user = userEvent.setup();
        await user.type(screen.getByRole('textbox'), 'toon mijn taken{Enter}');
        expect(await screen.findByRole('button', {name: /Weekly digest/})).toBeVisible();
        expect(screen.queryByText('Your tasks')).toBeNull();
    });
    it.each(['hi', 'Hoi, Bee!'])('greets someone who says %s and accepts their next request', async greeting => {
        serve();
        renderWithClient(<CoworkPage />);
        const user = userEvent.setup();
        const input = screen.getByRole('textbox');
        await user.type(input, greeting + '{Enter}');
        expect(screen.getByText('Hi! How can I help?')).toBeVisible();
        expect(calls.some(call => call.method === 'POST')).toBe(false);
        await user.type(input, 'show my tasks{Enter}');
        expect(await screen.findByRole('button', {name: /Weekly digest/})).toBeVisible();
    });
    it('carries a question about a named task into its conversation once', async () => {
        serve();
        renderWithClient(<CoworkPage />);
        const user = userEvent.setup();
        const question = 'Why did Weekly digest stop?';
        await user.type(screen.getByTestId('cowork-brief-input'), question);
        await user.keyboard('{Enter}');
        expect(await screen.findByText('Your digest is ready.')).toBeVisible();
        const turns = calls.filter(call => call.url.endsWith('/w1/conversation'));
        expect(turns).toHaveLength(1);
        expect(turns[0].body).toMatchObject({ message: question });
        expect(calls.some(call => call.method === 'POST' && call.url.endsWith('/api/cowork'))).toBe(false);
    });

    it('asks once which task to share, carrying the instruction into the selected task', async () => {
        serve([ITEM, {...ITEM, id: 'w2', title: 'Morning mail'}], () => jsonResponse({action: 'task', indices: []}));
        renderWithClient(<CoworkPage />);
        const user = userEvent.setup();
        await user.type(screen.getByRole('textbox'), 'Kan Noor meekijken bij een taak?{Enter}');
        const pick = await screen.findByRole('button', {name: /Weekly digest/});
        expect(screen.getByRole('button', {name: /Morning mail/})).toBeVisible();
        expect(calls.filter(call => call.method !== 'GET').map(path)).toEqual(['/api/cowork/home/intent']);
        await user.click(pick);
        expect(await screen.findByText('Your digest is ready.')).toBeVisible();
        expect(calls.filter(call => path(call).endsWith('/conversation')).map(call => call.body)).toEqual([
            expect.objectContaining({message: 'Kan Noor meekijken bij een taak?'}),
        ]);
    });

    it('streams a home clarification before the choices arrive', async () => {
        const stream = new TransformStream();
        const writer = stream.writable.getWriter();
        serve([], () => new Response(stream.readable, {headers: {'content-type': 'text/event-stream'}}));
        renderWithClient(<CoworkPage />);
        await userEvent.setup().type(screen.getByRole('textbox'), 'What can we do together?{Enter}');
        const send = (frame: string) => writer.write(new TextEncoder().encode(frame + '\n\n'));
        await send('event: answer\ndata: "Shall we"');
        expect(await screen.findByText('Shall we')).toBeVisible();
        await send('event: reply\ndata: {"action":"answer","answer":"Shall we pick a task?","responses":["List tasks","Start a new task"]}');
        await writer.close();
        expect(await screen.findByRole('button', {name: 'List tasks'})).toBeVisible();
    });

    it('keeps a clarification in context and treats a suggested answer as a conversation turn', async () => {
        const intent = vi.fn()
            .mockReturnValueOnce(jsonResponse({action: 'answer', answer: 'Welke informatie zoek je?', responses: ['Mijn resultaten', 'Mijn uitnodigingen']}))
            .mockReturnValueOnce(jsonResponse({action: 'attention', indices: []}));
        serve([], intent);
        renderWithClient(<CoworkPage />);
        const user = userEvent.setup();
        await user.type(screen.getByRole('textbox'), 'Kun je me helpen met iets?{Enter}');
        await user.click(await screen.findByRole('button', {name: 'Mijn uitnodigingen'}));
        expect(await screen.findByText('Nothing needs you right now.')).toBeVisible();
        expect(intent.mock.calls[1][0]).toMatchObject({message: 'Mijn uitnodigingen', previous: expect.stringContaining('Welke informatie zoek je?')});
        expect(calls.filter(call => call.method !== 'GET').every(call => path(call) === '/api/cowork/home/intent')).toBe(true);
    });

    it('shows cross-task approvals from an opened task without another prompt or a dashboard visit', async () => {
        serve([ITEM], undefined, () => jsonResponse({action: 'attention', answer: 'Here are your requests.'}));
        renderWithClient(<CoworkPage initialCoworkId="w1" />);
        const user = userEvent.setup();
        const task = await screen.findByTestId('cowork-task-view');
        await user.type(within(task).getByRole('textbox', {name: 'Ask Bee…'}), 'Which invitations need my approval?{Enter}');
        expect(await screen.findByText('Nothing needs you right now.')).toBeVisible();
        expect(screen.getByTestId('cowork-brief-input')).toBeVisible();
        expect(calls.filter(call => call.method === 'POST').map(path)).toEqual(['/api/cowork/w1/conversation']);
    });

    it('retains a question sent during loading and the follow-up being typed when the task opens', async () => {
        serve();
        const fetch = globalThis.fetch;
        let release!: () => void;
        const waiting = new Promise<void>(resolve => { release = resolve; });
        vi.stubGlobal('fetch', async (...args: Parameters<typeof fetch>) => {
            if (new URL(String(args[0]), 'http://x').pathname === '/api/cowork/w1') await waiting;
            return fetch(...args);
        });
        renderWithClient(<CoworkPage initialCoworkId="w1" />);
        await screen.findByText('Opening the task…');
        const user = userEvent.setup();
        const input = screen.getByRole('textbox', {name: 'Ask Bee…'});
        await user.type(input, 'How did this run go?{Enter}');
        await user.type(input, 'And the follow-up');
        expect(calls.some(c => c.method === 'POST')).toBe(false);
        release();
        expect(await screen.findByText('Your digest is ready.')).toBeVisible();
        const ready = screen.getByRole('textbox', {name: 'Ask Bee…'});
        expect(ready).toHaveValue('And the follow-up');
        expect(ready).toHaveFocus();
        expect(calls.filter(c => c.method === 'POST').map(path)).toEqual(['/api/cowork/w1/conversation']);
    });

    it('carries a question from home straight into the named shared task as its reader', async () => {
        serve([ITEM], () => jsonResponse({action: 'task', indices: [1]}), undefined, true);
        renderWithClient(<CoworkPage />);
        await userEvent.setup().type(screen.getByRole('textbox'), 'Wat zegt de planning van Noor?{Enter}');
        expect(await screen.findByText('Noor shared the current planning.')).toBeVisible();
        const turns = calls.filter(call => path(call).endsWith('/conversation'));
        expect(turns).toHaveLength(1);
        expect(path(turns[0])).toBe('/api/cowork/s1/conversation');
        expect(turns[0].body).toMatchObject({message:'Wat zegt de planning van Noor?',view:'shared'});
    });

    it('opens a named task without starting a second model turn', async () => {
        serve([ITEM], () => jsonResponse({action: 'open', indices: [0]}));
        renderWithClient(<CoworkPage />);
        await userEvent.setup().type(screen.getByRole('textbox'), 'Breng me naar mijn weekoverzicht{Enter}');
        expect(await screen.findByRole('heading', {name: 'Weekly digest'})).toBeVisible();
        expect(calls.some(call => path(call).endsWith('/conversation'))).toBe(false);
    });

    it('opens only the requested preference, with Bee ready for the next question', async () => {
        serve([ITEM], () => jsonResponse({action: 'preferences', section: 'mail'}));
        renderWithClient(<CoworkPage />);
        const user = userEvent.setup();
        await user.type(screen.getByRole('textbox'), 'Pas mijn dagelijkse mail aan{Enter}');
        expect(await screen.findByRole('heading', {name: 'E-mail'})).toBeVisible();
        expect(screen.queryByText('Suggestions')).toBeNull();
        expect(screen.getByTestId('cowork-brief-input')).toBeVisible();
    });

    it('keeps organisation rules private when requested from Bee by a member', async () => {
        serve([], () => jsonResponse({action: 'org', section: 'budget'}));
        renderWithClient(<CoworkPage user={MEMBER} />);
        await userEvent.setup().type(screen.getByRole('textbox'), 'Ik wil het organisatiebudget instellen{Enter}');
        expect(await screen.findByText(/Only administrators of your organisation/)).toBeVisible();
        expect(screen.queryByTestId('cowork-org-panel')).toBeNull();
    });

    it('opens a task from its row as a page in place of the home, says so in the address, and "Tasks" goes back to the row', async () => {
        serve();
        const onNavigate = vi.fn();
        renderWithClient(<CoworkPage onNavigate={onNavigate} />);
        await openDashboard();
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
        await openDashboard();
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
        await openDashboard();
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
        await openDashboard();
        expect(screen.queryByRole('button', { name: 'Admin rules' })).toBeNull();
        unmount();
        const onNavigate = vi.fn();
        renderWithClient(<CoworkPage user={ADMIN} onNavigate={onNavigate} />);
        await openDashboard();
        await user.click(screen.getByRole('button', { name: 'Admin rules' }));
        expect(await screen.findByTestId('cowork-org-panel')).toBeInTheDocument();
        expect(onNavigate).toHaveBeenLastCalledWith('cowork/admin-rules');
    });

    it('"Start from a template" opens Templates as a page; "Use" puts the sentence in the composer, back on the home', async () => {
        serve();
        const user = userEvent.setup();
        renderWithClient(<CoworkPage />);
        await openDashboard();
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
        await openDashboard();
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
        await openDashboard();
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
        await user.type(screen.getByTestId('cowork-brief-input'), 'Every day at 9, summarise my meetings');
        await user.keyboard('{Enter}');
        expect(screen.queryByText('Review your task')).toBeNull();
        await waitFor(() => expect(calls.some((c) => c.method === 'POST' && path(c) === '/api/cowork/new/plan/make')).toBe(true));
        expect(await screen.findByRole('heading', {name: 'Meeting overview'})).toBeVisible();
        expect(screen.queryByRole('button', {name: 'Open task'})).toBeNull();
    });
});

describe('the Cowork page is crisp', () => {
    it('nothing that holds text carries a transform, a filter or a backdrop filter at rest: the home, and a page', async () => {
        serve();
        const user = userEvent.setup();
        renderWithClient(<CoworkPage user={ADMIN} />);
        await openDashboard();
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
