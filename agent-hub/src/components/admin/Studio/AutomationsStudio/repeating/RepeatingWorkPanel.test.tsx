import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { repeatingApi } from '../../../../../api/queries/automation/repeating';
import type { ScanEventHandler, ScanResult, ScanSources } from '../../../../../api/queries/automation/repeating';
import { withQueryClient } from '@/test/queryWrapper';
import RepeatingWorkPanel from './RepeatingWorkPanel';
import type { RepeatingWorkPanelProps } from './RepeatingWorkPanel';

// Ported from SuggestedAutomations.test.jsx: every assertion there has a
// counterpart here, on the source groups / patterns contract.

const SOURCES: ScanSources = {
    windowDays: 90,
    groups: [
        { id: 'mail', kind: 'live', connected: true, apps: [{ id: 'gmail', label: 'Gmail', connected: true }, { id: 'outlook', label: 'Outlook', connected: false }] },
        { id: 'calendar', kind: 'stored', connected: false, apps: [] },
        { id: 'files', kind: 'live', connected: true, apps: [{ id: 'nextcloud', label: 'Nextcloud Files', connected: true }] },
        { id: 'beeflow', kind: 'stored', connected: true, apps: [] },
    ],
};
const NOTHING_CONNECTED: ScanSources = { windowDays: 90, groups: SOURCES.groups.map(g => ({ ...g, connected: false, apps: [] })) };

const PATTERN = { kind: 'sequence', signature: 'sig-1', cadence: { kind: 'weekly', weekday: 1 }, occurrences: 14, windowDays: 90, weekdayHistogram: [0, 9, 1, 0, 0, 0, 0], minutesPerMonth: [60, 120], apps: ['gmail'], reasons: ['frequent'], confidence: 'normal' };
const card = (id: string, title: string, over: Record<string, unknown> = {}) => ({ id, title, description: `About ${title}`, requiredIntegrations: ['gmail'], groundedIn: 'activity', pattern: { ...PATTERN, signature: `sig-${id}` }, ...over });
const SUMMARY = { sources: ['gmail'], events: 12, piiCategories: [] as string[] };
type Frame = [string, unknown];
const done = (suggestions: unknown[], summary: unknown = SUMMARY): Frame => ['done', { suggestions, summary, scannedAt: new Date().toISOString() }];
const drive = (frames: Frame[]) => async (_b: unknown, onEvent: ScanEventHandler) => { for (const [e, d] of frames) onEvent(e, d); };
const lastScan = (suggestions: unknown[]): ScanResult => ({ suggestions: suggestions as ScanResult['suggestions'], summary: SUMMARY, reason: null, scannedAt: new Date().toISOString(), cached: true, mode: 'patterns' });

function mount({ last = null as ScanResult | null, sources = SOURCES, props = {} as Partial<RepeatingWorkPanelProps> } = {}) {
    const api = {
        sources: vi.spyOn(repeatingApi, 'fetchScanSources').mockResolvedValue(sources),
        last: vi.spyOn(repeatingApi, 'fetchLastScan').mockResolvedValue(last),
        feedback: vi.spyOn(repeatingApi, 'postFeedback').mockResolvedValue(undefined),
        stream: vi.spyOn(repeatingApi, 'streamPatternScan'),
    };
    const onBuild = vi.fn();
    const view = render(withQueryClient(<RepeatingWorkPanel onBuild={onBuild} undoMs={30} {...props} />));
    return { api, onBuild, view };
}
const scanButton = () => screen.findByRole('button', { name: 'Scan my recent work' });
async function scanWith(frames: Frame[], opts: Parameters<typeof mount>[0] = {}) {
    const user = userEvent.setup();
    const m = mount(opts);
    m.api.stream.mockImplementation(drive(frames));
    await user.click(await scanButton());
    return { user, ...m };
}

afterEach(() => { vi.restoreAllMocks(); });

it('shows a tile per source group, listing only the connected apps', async () => {
    mount();
    const mail = within(await screen.findByTestId('source-tile-mail'));
    expect(mail.getByText('Gmail')).toBeTruthy();
    expect(mail.queryByText('Outlook')).toBeNull(); // not connected: not offered
    expect(within(screen.getByTestId('source-tile-calendar')).getByRole('link', { name: 'Connect' })).toBeTruthy();
});

it('before any scan: a header that says what Bee reads, and one primary action', async () => {
    mount();
    expect(screen.getByRole('heading', { name: 'Find repeating work' })).toBeTruthy();
    expect(screen.getByText(/nothing is built without you/)).toBeTruthy();
    expect(screen.getByText('Last 90 days')).toBeTruthy();
    expect((await scanButton()).className).toContain('bg-[var(--accent-primary)]');
    expect(screen.queryByText(/Scanned/)).toBeNull();
});

it('while scanning shows the flow and one status line, with the log behind "Show details"', async () => {
    const user = userEvent.setup();
    const { api } = mount();
    let finish = () => {};
    api.stream.mockImplementation((_b, onEvent) => new Promise<void>((resolve) => {
        onEvent('source_step', { source: 'mail', app: 'gmail', status: 'start' });
        finish = () => { onEvent('done', { suggestions: [], summary: SUMMARY }); resolve(); };
    }));
    await user.click(await scanButton());
    expect(await screen.findByText('Reading Gmail…')).toBeTruthy();
    expect(screen.getByTestId('scan-flow')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
    expect(screen.queryByTestId('scan-log')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Show details' }));
    expect(screen.getByTestId('scan-log').textContent).toMatch(/Reading Gmail/);
    await act(async () => { finish(); });
    expect(await screen.findByText('No repeating work spotted')).toBeTruthy();
    expect(screen.queryByTestId('scan-progress')).toBeNull();
});

it('after a scan: what it read, the log behind details, and a card per pattern', async () => {
    const { user, api } = await scanWith([
        ['phase', { phase: 'collecting' }],
        ['source_step', { source: 'mail', app: 'gmail', status: 'start' }],
        ['source_step', { source: 'mail', app: 'gmail', status: 'done', events: 12 }],
        ['stats', { events: 12, templates: 2, candidates: 2 }],
        done([card('s1', 'Invoice to sheet'), card('s2', 'Weekly digest')]),
    ]);
    expect(await screen.findByText(/Looked at Gmail · 12 events · no personal data found/)).toBeTruthy();
    expect(screen.getByText('No message text was sent to the AI, only patterns.')).toBeTruthy();
    expect(screen.queryByText(/Read Gmail/)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Show details' }));
    expect(screen.getByText(/Read Gmail · 12 events/)).toBeTruthy();
    expect(screen.getByText(/Scanned/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Scan my recent work' })).toBeNull();
    expect(screen.getAllByTestId('pattern-card')).toHaveLength(2);
    expect(within(screen.getByTestId('suggestion-list')).getByText('Weekly digest')).toBeTruthy();
    // Every connected group is switched on by default, and the viewer's zone
    // goes along so weekdays and hours are counted in local time.
    expect(api.stream).toHaveBeenCalledWith(
        { mode: 'patterns', sources: ['mail', 'files', 'beeflow'], focus: '', force: false, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
        expect.any(Function), expect.anything(),
    );
});

it('surfaces the personal-data categories the Privacy Shield found', async () => {
    await scanWith([done([], { ...SUMMARY, piiCategories: ['Person', 'Email'] })]);
    expect(await screen.findByText(/personal data found: Person, Email/)).toBeTruthy();
});

it('says why nothing was found, what to try, and offers ideas instead', async () => {
    await scanWith([done([])]);
    expect(await screen.findByText('No repeating work spotted')).toBeTruthy();
    expect(screen.getByText(/Bee read Gmail but found nothing that repeats/)).toBeTruthy();
    expect(screen.getByText(/name a focus such as invoices/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Suggest ideas instead' })).toBeTruthy();
});

it('says when there is not enough history yet', async () => {
    await scanWith([['done', { suggestions: [], summary: SUMMARY, reason: 'not_enough_history' }]]);
    expect(await screen.findByText('Not enough history yet')).toBeTruthy();
});

it('shows a calm cooldown, not a failure, when rate-limited (429)', async () => {
    const user = userEvent.setup();
    const { api } = mount();
    api.stream.mockRejectedValue(Object.assign(new Error('Too many requests. Retry in ~20s.'), { status: 429, retryAfter: 20 }));
    await user.click(await scanButton());
    expect(await screen.findByText(/scan again in \d+s/)).toBeTruthy();
    expect(screen.queryByTestId('repeating-error')).toBeNull();
    expect(screen.getByRole('button', { name: 'Scan my recent work' })).toBeDisabled();
});

it('prompts to connect an app when nothing is connected', async () => {
    mount({ sources: NOTHING_CONNECTED });
    expect(await screen.findByText(/Connect an app first/)).toBeTruthy();
    expect(screen.getByTestId('repeating-no-apps')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Scan my recent work' })).toBeNull();
});

it('shows the measured evidence, and an older scan with its sentence but no time-saved figure', async () => {
    await scanWith([done([
        card('s1', 'Invoice to sheet'),
        { id: 's2', title: 'Old idea', requiredIntegrations: ['gmail'], groundedIn: 'activity', evidence: { summary: 'Observed 12 invoice emails this month' }, value: { minutesSavedPerMonth: 45 } },
    ])]);
    expect(await screen.findByText('14× in 90 days')).toBeTruthy();
    expect(screen.getByText('≈1–2 h/month (estimated)')).toBeTruthy();
    expect(screen.getByText('Observed 12 invoice emails this month')).toBeTruthy();
    expect(screen.getByText('Observed')).toBeTruthy();
    expect(screen.queryByText(/min\/mo|hr\/mo/i)).toBeNull();
});

it('paints the last scan WITHOUT firing a new stream call', async () => {
    const { api } = mount({ last: lastScan([card('s1', 'Cached idea')]) });
    expect(await screen.findByText('Cached idea')).toBeTruthy();
    expect(screen.getByText(/Scanned just now/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Scan again' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Scan my recent work' })).toBeNull();
    expect(api.stream).not.toHaveBeenCalled();
});

it('Scan again makes exactly one new, forced stream call', async () => {
    const { user, api } = await scanWith([done([card('s1', 'First idea')])]);
    await screen.findByText('First idea');
    expect(api.stream).toHaveBeenCalledTimes(1);
    await user.click(await screen.findByRole('button', { name: 'Scan again' }));
    await waitFor(() => expect(api.stream).toHaveBeenCalledTimes(2));
    expect(api.stream).toHaveBeenLastCalledWith(expect.objectContaining({ force: true }), expect.any(Function), expect.anything());
});

it('a failed re-scan keeps the results on screen under the error', async () => {
    const user = userEvent.setup();
    const { api } = mount({ last: lastScan([card('s1', 'Cached idea')]) });
    api.stream.mockImplementation(drive([['error', { error: 'The model did not answer.' }]]));
    await user.click(await screen.findByRole('button', { name: 'Scan again' }));
    expect(await screen.findByTestId('repeating-error')).toHaveTextContent('The model did not answer.');
    expect(screen.getByText('Cached idea')).toBeTruthy();
});

it('"Not repetitive" removes the card, offers Undo, then records it by signature', async () => {
    const { user, api } = await scanWith([done([card('s1', 'Delete me'), card('s2', 'Keep me')])]);
    const target = (await screen.findByText('Delete me')).closest('[data-testid="pattern-card"]') as HTMLElement;
    await user.click(within(target).getByRole('button', { name: /Not repetitive/ }));
    await user.click(screen.getByRole('menuitem', { name: 'This is already automated' }));
    expect(screen.queryByRole('heading', { name: 'Delete me' })).toBeNull();
    expect(screen.getByText('Keep me')).toBeTruthy();
    expect(screen.getByTestId('repeating-undo')).toHaveTextContent('Marked as not repetitive.');
    await waitFor(() => expect(api.feedback).toHaveBeenCalledWith(expect.objectContaining({
        action: 'dismissed', signature: 'sig-s1', reasonCode: 'already_automated',
    })));
});

it('Undo puts the card back and records nothing', async () => {
    const user = userEvent.setup();
    const { api } = mount({ last: lastScan([card('s1', 'Snooze me')]), props: { undoMs: 5000 } });
    await user.click(await screen.findByRole('button', { name: 'Not now' }));
    expect(screen.queryByRole('heading', { name: 'Snooze me' })).toBeNull();
    expect(screen.getByTestId('repeating-undo')).toHaveTextContent('Hidden for 30 days.');
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(screen.getByRole('heading', { name: 'Snooze me' })).toBeTruthy();
    expect(api.feedback).not.toHaveBeenCalled();
});

it('Build this sends to the builder at once; Adjust first only fills it in', async () => {
    const user = userEvent.setup();
    const { api, onBuild } = mount({ last: lastScan([card('s1', 'Build me')]) });
    await user.click(await screen.findByRole('button', { name: 'Build this' }));
    expect(onBuild).toHaveBeenLastCalledWith(expect.objectContaining({ id: 's1' }), { autoSend: true });
    await waitFor(() => expect(api.feedback).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'opened', signature: 'sig-s1' })));
    await user.click(screen.getByRole('button', { name: 'Adjust first' }));
    expect(onBuild).toHaveBeenLastCalledWith(expect.objectContaining({ id: 's1' }), { autoSend: false });
    await waitFor(() => expect(api.feedback).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'asked' })));
});

it('keeps the launcher\'s onBuildSuggestion / onAskSuggestion wiring working', async () => {
    const user = userEvent.setup();
    const onBuildSuggestion = vi.fn();
    const onAskSuggestion = vi.fn();
    mount({ last: lastScan([card('s1', 'Build me')]), props: { onBuild: undefined, onBuildSuggestion, onAskSuggestion } });
    await user.click(await screen.findByRole('button', { name: 'Build this' }));
    expect(onBuildSuggestion).toHaveBeenCalledWith(expect.objectContaining({ id: 's1' }));
    await user.click(screen.getByRole('button', { name: 'Adjust first' }));
    expect(onAskSuggestion).toHaveBeenCalledWith(expect.objectContaining({ id: 's1' }));
});

it('ideas come only from the fallback link, in their own labelled list', async () => {
    const { user, api } = await scanWith([done([])]);
    api.stream.mockImplementation(drive([done([{ id: 'i1', title: 'Idea one', groundedIn: 'idea', requiredIntegrations: ['gmail'] }])]));
    await user.click(await screen.findByRole('button', { name: 'Suggest ideas instead' }));
    const ideas = within(await screen.findByTestId('repeating-ideas'));
    expect(ideas.getByText('Ideas · not seen in your activity')).toBeTruthy();
    expect(ideas.getByTestId('pattern-card')).toHaveAttribute('data-variant', 'idea');
    expect(ideas.queryByTestId('evidence-pills')).toBeNull();
    expect(api.stream).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'ideas' }), expect.any(Function), expect.anything());
    expect(screen.queryByRole('button', { name: 'Suggest ideas instead' })).toBeNull();
});

it('Try again after a failed ideas run asks for ideas again, not for a new patterns scan', async () => {
    const { user, api } = await scanWith([done([])]);
    api.stream.mockImplementation(drive([['error', { error: 'The model did not answer.' }]]));
    await user.click(await screen.findByRole('button', { name: 'Suggest ideas instead' }));
    expect(await screen.findByTestId('repeating-error')).toHaveTextContent('The model did not answer.');
    api.stream.mockImplementation(drive([done([{ id: 'i1', title: 'Idea one', groundedIn: 'idea' }])]));
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTestId('repeating-ideas')).toBeTruthy();
    expect(api.stream).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'ideas' }), expect.any(Function), expect.anything());
});

it('Stop ends the scan and says so', async () => {
    const user = userEvent.setup();
    const { api } = mount();
    api.stream.mockImplementation((_b, _e, signal) => new Promise<void>((resolve) => { signal?.addEventListener('abort', () => resolve()); }));
    await user.click(await scanButton());
    await user.click(await screen.findByRole('button', { name: 'Stop' }));
    expect(await screen.findByText('Scan stopped. Nothing new was saved.')).toBeTruthy();
    expect(await scanButton()).toBeTruthy();
});

it('says when the sources changed since the scan', async () => {
    const { user } = await scanWith([done([card('s1', 'Weekly report')])]);
    await screen.findByText('Weekly report');
    expect(screen.queryByText(/sources or focus changed/)).toBeNull();
    await user.click(screen.getByRole('switch', { name: 'Include Files' }));
    expect(screen.getByText(/sources or focus changed/)).toBeTruthy();
});

it('never renders purple/violet/indigo in the scan UI', async () => {
    const { view } = await scanWith([
        ['source_step', { source: 'mail', app: 'gmail', status: 'skipped', reason: 'shield' }],
        done([card('s1', 'Idea', { pattern: { ...PATTERN, confidence: 'early', template: 'Invoice <n>' } })], { ...SUMMARY, piiCategories: ['Person'] }),
    ]);
    await screen.findByText('Idea');
    expect(view.container.innerHTML).not.toMatch(/purple|violet|indigo/);
});
