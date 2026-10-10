/**
 * CoworkPage — the two halves that used to be separate screens, now one.
 *
 * Left: a brief becomes a cowork item with no extra form-filling, and the
 * schedule chips change what gets posted. Right: the selected item's detail,
 * its editor, and a row per run — the part the sidebar's page never had.
 */
import { act, cleanup, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import CoworkPage from './CoworkPage';

const api = vi.hoisted(() => ({
    listCowork: vi.fn(),
    createCowork: vi.fn(),
    updateCowork: vi.fn(),
    toggleCowork: vi.fn(),
    runCoworkNow: vi.fn(),
    deleteCowork: vi.fn(),
    composeCowork: vi.fn(),
    listCoworkRuns: vi.fn(),
    listCoworkAgents: vi.fn(),
}));

vi.mock('./coworkApi', () => api);
// The agent picker is beta-gated; default the tests to "no beta".
vi.mock('../licensing/EntitlementsContext', () => ({
    useEntitlements: () => ({ loading: false, can: () => false }),
}));
// The composer's Apps picker and tier picker fetch on mount. Give them a
// connected Google account and two tiers so both controls have something to
// show — the point of these tests is that the page renders them at all.
vi.mock('../../hooks/useIntegrationStatus', () => ({
    useIntegrationStatus: () => ({
        integrationStatus: { isGoogleUser: true, enabledApps: null, orgEnabledIntegrations: null },
    }),
}));
vi.mock('../../hooks/useModelTierSelection', () => ({
    default: () => ({
        modelTiers: { auto: { model: 'gpt-4o' }, thinking: { model: 'gpt-5' } },
        selectedTier: 'thinking',
        setSelectedTier: vi.fn(),
    }),
}));

const ITEM = {
    id: 'w1',
    title: 'Weekly digest',
    prompt: 'Summarise the week',
    isActive: true,
    lastStatus: 'success',
    nextRunAt: new Date(Date.now() + 86400_000).toISOString(),
    lastRunAt: new Date().toISOString(),
    lastResult: '# Digest\nAll good.',
    repeatInterval: 'weekly',
    runCount: 3,
};

const RUN = {
    id: 'r1',
    status: 'success',
    triggerKind: 'manual',
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: 5200,
    result: 'All good.',
    error: null,
};

function seed(items = []) {
    api.listCowork.mockResolvedValue({ items, maxItems: 10 });
}

beforeEach(() => {
    vi.clearAllMocks();
    seed();
    api.createCowork.mockResolvedValue({ id: 'new', title: 'Send the digest' });
    api.listCoworkAgents.mockResolvedValue([]);
    api.listCoworkRuns.mockResolvedValue({ runs: [], total: 0 });
    // The composer asks the server to read the brief; these tests are about
    // what the UI does with the user's own chips, so let it degrade.
    api.composeCowork.mockRejectedValue(new Error('offline'));
});

describe('CoworkPage — creating', () => {
    it('keeps the box free of chrome that repeats what the chips already say', async () => {
        // "Now · results land in your notifications" restated the When chip and
        // the Run button, and "4/10 in use" was a number nobody acts on until
        // it is 10/10 — which the page raises as a warning of its own.
        seed([ITEM]);
        render(<CoworkPage />);
        await screen.findByTestId('cowork-brief-input');

        const box = screen.getByTestId('cowork-composer');
        expect(box).not.toHaveTextContent(/results land in your notifications/);
        expect(box).not.toHaveTextContent(/in use/);
        expect(screen.queryByText(/Build an automation in Studio/)).not.toBeInTheDocument();
    });

    it('still warns once every slot is taken', async () => {
        // The quota did not become invisible — it became a warning instead of
        // a permanent counter.
        api.listCowork.mockResolvedValue({ items: [ITEM], maxItems: 1 });
        render(<CoworkPage />);
        expect(await screen.findByText(/used all 1 cowork slots/)).toBeInTheDocument();
    });

    it('creates from the brief alone — no separate title or date fields', async () => {
        render(<CoworkPage />);
        await screen.findByTestId('cowork-brief-input');

        fireEvent.change(screen.getByTestId('cowork-brief-input'), {
            target: { value: 'Send the digest\nwith source links' },
        });
        fireEvent.click(screen.getByTestId('cowork-send'));

        await waitFor(() => expect(api.createCowork).toHaveBeenCalledTimes(1));
        const payload = api.createCowork.mock.calls[0][0];
        expect(payload.title).toBe('Send the digest');
        expect(payload.prompt).toBe('Send the digest\nwith source links');
        // Default is "now", which asks the server to fire it immediately.
        expect(payload.startNow).toBe(true);
        expect(payload.repeatInterval).toBeNull();
    });

    it('will not send an empty brief', async () => {
        render(<CoworkPage />);
        await screen.findByTestId('cowork-brief-input');
        expect(screen.getByTestId('cowork-send')).toBeDisabled();
    });

    it('carries the picked cadence into the payload and relabels the button', async () => {
        render(<CoworkPage />);
        await screen.findByTestId('cowork-brief-input');

        fireEvent.change(screen.getByTestId('cowork-brief-input'), { target: { value: 'Weekly digest' } });
        fireEvent.click(screen.getByTestId('cowork-repeat-chip'));
        fireEvent.click(screen.getByText('Every week'));
        fireEvent.click(screen.getByTestId('cowork-when-chip'));
        fireEvent.click(screen.getByText('Tomorrow morning'));

        expect(screen.getByTestId('cowork-send')).toHaveTextContent('Schedule');

        fireEvent.click(screen.getByTestId('cowork-send'));
        await waitFor(() => expect(api.createCowork).toHaveBeenCalled());
        const payload = api.createCowork.mock.calls[0][0];
        expect(payload.repeatInterval).toBe('weekly');
        expect(payload.startNow).toBeUndefined();
        expect(new Date(payload.nextRunAt).getHours()).toBe(9);
    });

    it('blocks send until a custom moment is fully picked', async () => {
        render(<CoworkPage />);
        await screen.findByTestId('cowork-brief-input');
        fireEvent.change(screen.getByTestId('cowork-brief-input'), { target: { value: 'Do the thing' } });

        fireEvent.click(screen.getByTestId('cowork-when-chip'));
        fireEvent.click(screen.getByText('Pick a moment…'));
        // The sheet seeds both inputs, so the button stays live…
        expect(screen.getByTestId('cowork-send')).not.toBeDisabled();
        // …and blanking one takes it away again.
        fireEvent.change(screen.getByTestId('cowork-when-time'), { target: { value: '' } });
        expect(screen.getByTestId('cowork-send')).toBeDisabled();
    });

    it('surfaces a create failure and keeps the brief in the box', async () => {
        api.createCowork.mockRejectedValue(new Error('Maximum number of cowork items reached (10).'));
        render(<CoworkPage />);
        await screen.findByTestId('cowork-brief-input');

        fireEvent.change(screen.getByTestId('cowork-brief-input'), { target: { value: 'Do the thing' } });
        fireEvent.click(screen.getByTestId('cowork-send'));

        expect(await screen.findByText(/Maximum number of cowork items reached/)).toBeInTheDocument();
        expect(screen.getByTestId('cowork-brief-input')).toHaveValue('Do the thing');
    });

    it('offers the same Apps picker as the chat composer', async () => {
        // The page used to be a stripped-down copy of the chat box: no Apps
        // picker, no tier picker. Both render the shared CoworkComposer now.
        render(<CoworkPage />);
        await screen.findByTestId('cowork-brief-input');
        expect(screen.getByTestId('apps-picker-button')).toBeInTheDocument();
        expect(screen.getByTitle('Apps')).toBeInTheDocument();
    });

    it('sends the chosen model tier instead of silently scheduling on auto', async () => {
        render(<CoworkPage />);
        await screen.findByTestId('cowork-brief-input');

        fireEvent.change(screen.getByTestId('cowork-brief-input'), { target: { value: 'Send the digest' } });
        fireEvent.click(screen.getByTestId('cowork-send'));

        await waitFor(() => expect(api.createCowork).toHaveBeenCalled());
        expect(api.createCowork.mock.calls[0][0].modelTier).toBe('thinking');
    });

    it('starts the brief for you when an app is picked', async () => {
        render(<CoworkPage />);
        await screen.findByTestId('cowork-brief-input');

        fireEvent.click(screen.getByTestId('apps-picker-button'));
        const calendar = screen.getAllByTestId('apps-picker-item')
            .find(el => el.dataset.appId === 'google-calendar');
        fireEvent.click(calendar);

        expect(screen.getByTestId('cowork-brief-input').value).toMatch(/calendar/i);
    });

    it('selects what it just created, so its history is already on screen', async () => {
        render(<CoworkPage />);
        await screen.findByTestId('cowork-brief-input');
        // The refresh after create is what puts the new row in the list.
        api.listCowork.mockResolvedValue({ items: [{ ...ITEM, id: 'new' }], maxItems: 10 });

        fireEvent.change(screen.getByTestId('cowork-brief-input'), { target: { value: 'Send the digest' } });
        fireEvent.click(screen.getByTestId('cowork-send'));

        expect(await screen.findByTestId('cowork-detail')).toBeInTheDocument();
    });
});

describe('CoworkPage — the list', () => {
    it('counts a just-started one-off as in flight', async () => {
        // What POST /api/cowork + startNow leaves behind: deactivated so the
        // scheduler can't double-fire it, but still very much in flight. The
        // old list filed that under "Done & paused" seconds after the user
        // pressed Run.
        seed([{ ...ITEM, isActive: false, lastStatus: 'pending', lastRunAt: null, lastResult: null, runCount: 0 }]);
        render(<CoworkPage />);
        await screen.findByText('Weekly digest');

        expect(screen.getByTestId('cowork-running-count')).toHaveTextContent('1 running');
    });

    it('leaves a finished one-off out of the count', async () => {
        seed([{ ...ITEM, isActive: false, repeatInterval: null, runCount: 1 }]);
        render(<CoworkPage />);
        await screen.findByText('Weekly digest');
        expect(screen.queryByTestId('cowork-running-count')).not.toBeInTheDocument();
    });

    it('puts the composer under the hero, not in the narrow list column', async () => {
        // In the 320px column the chips wrapped onto three rows and the brief
        // was two words per line. It belongs in the wide pane, directly under
        // the promise it answers.
        seed([ITEM]);
        render(<CoworkPage />);
        const welcome = await screen.findByTestId('cowork-welcome');
        const pane = welcome.closest('div').parentElement;
        expect(pane).toContainElement(screen.getByTestId('cowork-brief-input'));
        expect(screen.getByTestId('cowork-row').closest('aside'))
            .not.toContainElement(screen.getByTestId('cowork-brief-input'));
    });

    it('brings the composer back when the user asks for a new one', async () => {
        seed([ITEM]);
        render(<CoworkPage initialCoworkId="w1" />);
        await screen.findByTestId('cowork-detail');
        expect(screen.queryByTestId('cowork-brief-input')).not.toBeInTheDocument();

        fireEvent.click(screen.getByTestId('cowork-new'));
        expect(screen.getByTestId('cowork-brief-input')).toBeInTheDocument();
        expect(screen.queryByTestId('cowork-detail')).not.toBeInTheDocument();
    });

    it('says where Cowork stops and the Builder starts — with or without items', async () => {
        // The old copy only appeared at zero items, so the one boundary this
        // screen cannot draw was explained exactly once, to someone who had
        // not yet met either side of it (CW-05).
        render(<CoworkPage />);
        expect(await screen.findByTestId('cowork-explainer')).toHaveTextContent(/Builder/);

        cleanup();
        seed([ITEM]);
        render(<CoworkPage />);
        await screen.findByText('Weekly digest');
        const explainer = screen.getByTestId('cowork-explainer');
        expect(explainer).toHaveTextContent(/Builder/);

        // In the list column, under the rows — it is a footnote to the list,
        // not a banner over the composer.
        const row = screen.getByTestId('cowork-row');
        expect(row.closest('aside')).toContainElement(explainer);
        expect(row.compareDocumentPosition(explainer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('drops the When popover below the chip when there is no room above it', async () => {
        // The composer sits at the top of the column, where the default upward
        // placement runs the panel off the viewport. Real bug, caught in the
        // browser: the sheet's title was clipped above the fold.
        const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect');
        try {
            rect.mockReturnValue({ top: -120, bottom: 0, left: 0, right: 0, width: 280, height: 400, x: 0, y: -120, toJSON: () => ({}) });
            render(<CoworkPage />);
            await screen.findByTestId('cowork-when-chip');
            fireEvent.click(screen.getByTestId('cowork-when-chip'));

            const panel = screen.getByRole('dialog', { name: 'When should this run?' });
            expect(panel.className).toContain('top-full');
            expect(panel.className).not.toContain('bottom-full');
        } finally {
            rect.mockRestore();
        }
    });
});

describe('CoworkPage — the list header (CW-02)', () => {
    it('counts what is actually on the go, not what is merely switched on', async () => {
        // The badge this replaces counted `isActive`, so six schedules with
        // two running showed a 5. Here: four items, two of them in flight —
        // one mid-run, one deactivated-but-never-run (what "Run now" leaves
        // behind) — and two settled ones that are still switched on.
        seed([
            { ...ITEM, id: 'a', isActive: true, lastStatus: 'running' },
            { ...ITEM, id: 'b', isActive: false, lastStatus: 'pending', lastRunAt: null, runCount: 0 },
            { ...ITEM, id: 'c', isActive: true, lastStatus: 'success', runCount: 4 },
            { ...ITEM, id: 'd', isActive: true, lastStatus: 'error', runCount: 2 },
        ]);
        render(<CoworkPage />);
        await screen.findAllByTestId('cowork-row');

        expect(screen.getByTestId('cowork-running-count')).toHaveTextContent('2 running');
    });

    it('says nothing at all when nothing is on the go', async () => {
        seed([{ ...ITEM, isActive: true, lastStatus: 'success', runCount: 4 }]);
        render(<CoworkPage />);
        await screen.findByTestId('cowork-row');
        expect(screen.queryByTestId('cowork-running-count')).not.toBeInTheDocument();
    });

    it('gives the new-task button a word, not just a plus', async () => {
        // An unlabelled icon in the corner is not the primary action of a
        // screen whose whole purpose is handing work over.
        render(<CoworkPage />);
        const button = await screen.findByTestId('cowork-new');
        expect(button.textContent.trim()).toBe('New task');
        expect(button.style.background).toBe('var(--accent-primary)');
        expect(button.style.color).toBe('var(--accent-primary-fg)');
    });
});

describe('CoworkPage — detail, history and editing', () => {
    it('shows the welcome until something is selected', async () => {
        seed([ITEM]);
        render(<CoworkPage />);
        await screen.findByText('Weekly digest');
        expect(screen.getByTestId('cowork-welcome')).toBeInTheDocument();
        expect(screen.queryByTestId('cowork-detail')).not.toBeInTheDocument();
    });

    it('opens the detail and its run history on select', async () => {
        seed([ITEM]);
        api.listCoworkRuns.mockResolvedValue({ runs: [RUN], total: 1 });
        render(<CoworkPage />);
        fireEvent.click(await screen.findByTestId('cowork-row'));

        expect(await screen.findByTestId('cowork-detail')).toBeInTheDocument();
        await waitFor(() => expect(api.listCoworkRuns).toHaveBeenCalledWith('w1'));
        const run = await screen.findByTestId('cowork-run');
        // The closed row says what came OUT of the run, plus its duration in
        // the one shape CW-16 settled on. "Started by you" is a fact about the
        // run rather than the work, so it lives in the opened body now.
        expect(run).toHaveTextContent('All good.');
        expect(run).toHaveTextContent('0m 05s');
        expect(run).not.toHaveTextContent('5.2s');

        fireEvent.click(within(run).getByRole('button', { expanded: false }));
        expect(run).toHaveTextContent('Started by you');
    });

    it('renders a run result as Markdown, not as raw asterisks', async () => {
        // Results are model output, so they arrive as Markdown. Printed raw,
        // a digest opened with a line of "**Quick reminders:**" and pipes.
        seed([ITEM]);
        api.listCoworkRuns.mockResolvedValue({
            runs: [{ ...RUN, result: '## Today\n\n- **Drink water**\n- Pick one thing' }],
            total: 1,
        });
        render(<CoworkPage />);
        fireEvent.click(await screen.findByTestId('cowork-row'));
        const run = await screen.findByTestId('cowork-run');
        fireEvent.click(within(run).getByRole('button', { expanded: false }));

        expect(within(run).getByRole('heading', { name: 'Today' })).toBeInTheDocument();
        expect(within(run).getAllByRole('listitem')).toHaveLength(2);
        expect(within(run).getByText('Drink water').tagName).toBe('STRONG');
        expect(run.textContent).not.toContain('**');
    });

    it('leaves a failure as plain text — a stack line is not Markdown', async () => {
        seed([ITEM]);
        api.listCoworkRuns.mockResolvedValue({
            runs: [{ ...RUN, status: 'failed', result: null, error: 'Rate limited (429): retry in 60s *now*' }],
            total: 1,
        });
        render(<CoworkPage />);
        fireEvent.click(await screen.findByTestId('cowork-row'));
        const run = await screen.findByTestId('cowork-run');
        fireEvent.click(within(run).getByRole('button', { expanded: false }));

        expect(run).toHaveTextContent('Rate limited (429): retry in 60s *now*');
    });

    it('says so plainly when a schedule has never run', async () => {
        seed([ITEM]);
        render(<CoworkPage />);
        fireEvent.click(await screen.findByTestId('cowork-row'));
        expect(await screen.findByTestId('cowork-no-runs')).toBeInTheDocument();
    });

    it('opens on the deep-linked item without a click', async () => {
        seed([ITEM]);
        render(<CoworkPage initialCoworkId="w1" />);
        expect(await screen.findByTestId('cowork-detail')).toHaveTextContent('Weekly digest');
    });

    it('runs, pauses and reloads the history', async () => {
        seed([ITEM]);
        api.runCoworkNow.mockResolvedValue({ success: true });
        api.toggleCowork.mockResolvedValue({ success: true, isActive: false });
        render(<CoworkPage initialCoworkId="w1" />);
        await screen.findByTestId('cowork-detail');

        fireEvent.click(screen.getByTestId('cowork-run-now'));
        await waitFor(() => expect(api.runCoworkNow).toHaveBeenCalledWith('w1'));
        // A run changes the history, so it must be refetched, not left stale.
        await waitFor(() => expect(api.listCoworkRuns.mock.calls.length).toBeGreaterThan(1));

        fireEvent.click(screen.getByTestId('cowork-toggle'));
        await waitFor(() => expect(api.toggleCowork).toHaveBeenCalledWith('w1'));
    });

    it('deletes only after the confirm step', async () => {
        seed([ITEM]);
        api.deleteCowork.mockResolvedValue({ success: true });
        render(<CoworkPage initialCoworkId="w1" />);
        await screen.findByTestId('cowork-detail');

        fireEvent.click(screen.getByTestId('cowork-delete'));
        expect(api.deleteCowork).not.toHaveBeenCalled();

        fireEvent.click(screen.getByTestId('cowork-confirm-delete'));
        await waitFor(() => expect(api.deleteCowork).toHaveBeenCalledWith('w1'));
    });

    it('saves an edit and only then leaves the form', async () => {
        seed([ITEM]);
        api.updateCowork.mockResolvedValue({ success: true });
        render(<CoworkPage initialCoworkId="w1" />);
        await screen.findByTestId('cowork-detail');

        fireEvent.click(screen.getByTestId('cowork-edit'));
        fireEvent.change(await screen.findByTestId('cowork-edit-title'), { target: { value: 'Monthly digest' } });
        fireEvent.click(screen.getByTestId('cowork-edit-save'));

        await waitFor(() => expect(api.updateCowork).toHaveBeenCalled());
        const [id, patch] = api.updateCowork.mock.calls[0];
        expect(id).toBe('w1');
        expect(patch.title).toBe('Monthly digest');
        await waitFor(() => expect(screen.queryByTestId('cowork-edit-form')).not.toBeInTheDocument());
    });

    it('keeps a rejected edit on screen instead of discarding it', async () => {
        seed([ITEM]);
        api.updateCowork.mockRejectedValue(new Error('Unknown timezone: Mars/Olympus'));
        render(<CoworkPage initialCoworkId="w1" />);
        await screen.findByTestId('cowork-detail');

        fireEvent.click(screen.getByTestId('cowork-edit'));
        fireEvent.change(await screen.findByTestId('cowork-edit-title'), { target: { value: 'Monthly digest' } });
        fireEvent.click(screen.getByTestId('cowork-edit-save'));

        expect(await screen.findByText(/Unknown timezone/)).toBeInTheDocument();
        expect(screen.getByTestId('cowork-edit-title')).toHaveValue('Monthly digest');
    });

    it('round-trips an hourly repeat instead of silently resetting it to Once', async () => {
        // The repeat <select> only had options down to 'quarterly', so an
        // hourly item — which the API and the AI composer both produce — fell
        // back to the first option and was rewritten to "Once" on save.
        seed([{ ...ITEM, repeatInterval: 'hourly' }]);
        api.updateCowork.mockResolvedValue({ success: true });
        render(<CoworkPage initialCoworkId="w1" />);
        await screen.findByTestId('cowork-detail');

        fireEvent.click(screen.getByTestId('cowork-edit'));
        expect(await screen.findByTestId('cowork-edit-repeat')).toHaveValue('hourly');
        fireEvent.click(screen.getByTestId('cowork-edit-save'));

        await waitFor(() => expect(api.updateCowork).toHaveBeenCalled());
        expect(api.updateCowork.mock.calls[0][1].repeatInterval).toBe('hourly');
    });

    it('sends the wall-clock time along with the moment it was moved to', async () => {
        // timeOfDay feeds the schedule description the runner puts in the
        // prompt. Leaving it behind meant a job moved to 07:00 kept telling
        // the model it runs at 09:00.
        seed([ITEM]);
        api.updateCowork.mockResolvedValue({ success: true });
        render(<CoworkPage initialCoworkId="w1" />);
        await screen.findByTestId('cowork-detail');

        fireEvent.click(screen.getByTestId('cowork-edit'));
        fireEvent.change(await screen.findByTestId('cowork-edit-time'), { target: { value: '07:00' } });
        fireEvent.click(screen.getByTestId('cowork-edit-save'));

        await waitFor(() => expect(api.updateCowork).toHaveBeenCalled());
        const patch = api.updateCowork.mock.calls[0][1];
        expect(patch.timeOfDay).toBe('07:00');
        expect(new Date(patch.nextRunAt).getHours()).toBe(7);
    });

    it('offers the Apps picker while editing, so a run can be scoped before it fires', async () => {
        // Without it you could only change which apps a cowork may touch from
        // the composer — i.e. only while creating a new one.
        seed([ITEM]);
        render(<CoworkPage initialCoworkId="w1" />);
        await screen.findByTestId('cowork-detail');
        fireEvent.click(screen.getByTestId('cowork-edit'));

        await screen.findByTestId('cowork-edit-form');
        expect(screen.getByTestId('apps-picker-button')).toBeInTheDocument();
        expect(screen.getByText(/of \d+ enabled/)).toBeInTheDocument();
    });

    it('gives the item its own app list the moment one is switched off', async () => {
        // A cowork runs unattended hours later, so "what may this one touch"
        // is a per-item question. Until the picker is touched the item has no
        // list and follows the workspace default.
        seed([ITEM]);
        api.updateCowork.mockResolvedValue({ success: true });
        render(<CoworkPage initialCoworkId="w1" />);
        await screen.findByTestId('cowork-detail');
        fireEvent.click(screen.getByTestId('cowork-edit'));
        await screen.findByTestId('cowork-edit-form');

        fireEvent.click(screen.getByTestId('apps-picker-button'));
        fireEvent.click(screen.getByLabelText('Enable Gmail'));
        fireEvent.click(screen.getByTestId('cowork-edit-save'));

        await waitFor(() => expect(api.updateCowork).toHaveBeenCalled());
        const { enabledApps } = api.updateCowork.mock.calls[0][1];
        // The first toggle materialises the inherited set minus the one app —
        // switching Gmail off must not switch everything else off with it.
        expect(Array.isArray(enabledApps)).toBe(true);
        expect(enabledApps).not.toContain('gmail');
        expect(enabledApps).toContain('google-calendar');
    });

    it('leaves the list alone when the picker is never opened', async () => {
        seed([ITEM]);
        api.updateCowork.mockResolvedValue({ success: true });
        render(<CoworkPage initialCoworkId="w1" />);
        await screen.findByTestId('cowork-detail');
        fireEvent.click(screen.getByTestId('cowork-edit'));
        fireEvent.click(await screen.findByTestId('cowork-edit-save'));

        await waitFor(() => expect(api.updateCowork).toHaveBeenCalled());
        // null, not [] — "follow the workspace list", not "may use nothing".
        expect(api.updateCowork.mock.calls[0][1].enabledApps).toBeNull();
    });

    it('can hand an item back to the workspace list', async () => {
        seed([{ ...ITEM, enabledApps: ['gmail'] }]);
        api.updateCowork.mockResolvedValue({ success: true });
        render(<CoworkPage initialCoworkId="w1" />);
        await screen.findByTestId('cowork-detail');
        fireEvent.click(screen.getByTestId('cowork-edit'));

        fireEvent.click(await screen.findByTestId('cowork-apps-reset'));
        fireEvent.click(screen.getByTestId('cowork-edit-save'));

        await waitFor(() => expect(api.updateCowork).toHaveBeenCalled());
        expect(api.updateCowork.mock.calls[0][1].enabledApps).toBeNull();
    });

    it('abandons an open edit when the user switches to another item', async () => {
        // Carrying the form over would save one item's text onto another.
        seed([ITEM, { ...ITEM, id: 'w2', title: 'Daily standup' }]);
        render(<CoworkPage initialCoworkId="w1" />);
        await screen.findByTestId('cowork-detail');
        fireEvent.click(screen.getByTestId('cowork-edit'));
        await screen.findByTestId('cowork-edit-form');

        const rows = screen.getAllByTestId('cowork-row');
        fireEvent.click(rows.find(r => within(r).queryByText('Daily standup')));

        expect(screen.queryByTestId('cowork-edit-form')).not.toBeInTheDocument();
        expect(screen.getByTestId('cowork-detail')).toHaveTextContent('Daily standup');
    });
});

/**
 * ── Characterisation (CW-02/03/05/11/16/17) ──────────────────────────────
 *
 * The list, the one status box and the page's own strings, pinned exactly as
 * they behave TODAY so the rebuild has something to fail against. Tests named
 * "(wart: …)" describe behaviour that is current, not behaviour that is right.
 */

describe('CoworkPage — how the list is built', () => {
    it('is one flat list — no headings sorting the rows into buckets', async () => {
        // Two sections, "Running & scheduled" over "Done & paused", used to be
        // the only place a state was named: the row carried the status as a
        // small coloured icon with no word. Now the row says it (CW-03), and
        // the split only reorders the list out from under whoever is reading
        // it the moment something finishes.
        seed([
            { ...ITEM, id: 'a' },
            { ...ITEM, id: 'b', isActive: false, runCount: 1, repeatInterval: null },
        ]);
        render(<CoworkPage />);
        await screen.findAllByTestId('cowork-row');

        expect(screen.queryAllByRole('heading', { level: 2 })).toHaveLength(0);
        expect(screen.getAllByTestId('cowork-row').map(r => r.dataset.coworkId)).toEqual(['a', 'b']);
    });

    it('says on the row itself that an active item last failed', async () => {
        seed([{ ...ITEM, isActive: true, lastStatus: 'error', runCount: 2 }]);
        const { container } = render(<CoworkPage />);
        await screen.findByTestId('cowork-row');
        expect(container.querySelector('[data-status-key]').textContent).toBe('Failed');
    });

    it('shows a switched-off item that is still running as running, and counts it', async () => {
        seed([{ ...ITEM, isActive: false, lastStatus: 'running', runCount: 1 }]);
        const { container } = render(<CoworkPage />);
        await screen.findByTestId('cowork-row');
        expect(container.querySelector('[data-status-key]').textContent).toBe('Running');
        expect(screen.getByTestId('cowork-running-count')).toHaveTextContent('1 running');
    });

    it('renders rows in the order the server sent them — nothing is sorted here', async () => {
        seed([
            { ...ITEM, id: 'c', title: 'Zebra' },
            { ...ITEM, id: 'a', title: 'Apple' },
            { ...ITEM, id: 'b', title: 'Mango' },
        ]);
        render(<CoworkPage />);
        await screen.findByText('Zebra');
        expect(screen.getAllByTestId('cowork-row').map(r => r.dataset.coworkId)).toEqual(['c', 'a', 'b']);
    });

    it('shows one loading line and a disabled refresh while the first load is in flight', async () => {
        api.listCowork.mockReturnValue(new Promise(() => {}));
        api.listCoworkAgents.mockReturnValue(new Promise(() => {}));
        render(<CoworkPage />);

        expect(screen.getByText('Loading…')).toBeInTheDocument();
        expect(screen.getByTestId('cowork-refresh')).toBeDisabled();
        expect(screen.getByTestId('cowork-new')).not.toBeDisabled();
    });

    it('keeps the stale list on screen when a refresh fails, and calls the failure a status, not an alert (wart)', async () => {
        seed([ITEM]);
        render(<CoworkPage />);
        await screen.findByText('Weekly digest');

        api.listCowork.mockRejectedValue(new Error('Backend down'));
        fireEvent.click(screen.getByTestId('cowork-refresh'));

        const box = await screen.findByText('Backend down');
        expect(box.getAttribute('role')).toBe('status');
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
        // The rows the failed refresh could not replace are still shown.
        expect(screen.getByTestId('cowork-row')).toBeInTheDocument();
    });

    it('lets a load error take the one status box away from the quota warning', async () => {
        api.listCowork.mockResolvedValue({ items: [ITEM], maxItems: 1 });
        render(<CoworkPage />);
        await screen.findByText(/used all 1 cowork slots/);

        api.listCowork.mockRejectedValue(new Error('Backend down'));
        fireEvent.click(screen.getByTestId('cowork-refresh'));

        expect(await screen.findByText('Backend down')).toBeInTheDocument();
        expect(screen.queryByText(/used all 1 cowork slots/)).not.toBeInTheDocument();
    });
});

describe('CoworkPage — the quota ceiling and the flash', () => {
    it('drops the send silently once every slot is taken — the button stays live (wart)', async () => {
        api.listCowork.mockResolvedValue({ items: [ITEM], maxItems: 1 });
        render(<CoworkPage />);
        await screen.findByTestId('cowork-brief-input');

        fireEvent.change(screen.getByTestId('cowork-brief-input'), { target: { value: 'One more thing' } });
        expect(screen.getByTestId('cowork-send')).not.toBeDisabled();
        fireEvent.click(screen.getByTestId('cowork-send'));

        // Nothing async is even started: no compose, no create, no message.
        expect(api.composeCowork).not.toHaveBeenCalled();
        expect(api.createCowork).not.toHaveBeenCalled();
        expect(screen.getByTestId('cowork-brief-input')).toHaveValue('One more thing');
    });

    it('confirms a "run now" creation under the composer, and clears the box', async () => {
        render(<CoworkPage />);
        await screen.findByTestId('cowork-brief-input');

        fireEvent.change(screen.getByTestId('cowork-brief-input'), { target: { value: 'Send the digest' } });
        fireEvent.click(screen.getByTestId('cowork-send'));

        const flash = await screen.findByText('Off it goes — the result lands in your notifications.');
        expect(flash.getAttribute('role')).toBe('status');
        expect(screen.getByTestId('cowork-brief-input')).toHaveValue('');
    });

    it('says only "Scheduled." for something dated in the future', async () => {
        render(<CoworkPage />);
        await screen.findByTestId('cowork-brief-input');

        fireEvent.change(screen.getByTestId('cowork-brief-input'), { target: { value: 'Send the digest' } });
        fireEvent.click(screen.getByTestId('cowork-when-chip'));
        fireEvent.click(screen.getByText('Tomorrow morning'));
        fireEvent.click(screen.getByTestId('cowork-send'));

        expect(await screen.findByText('Scheduled.')).toBeInTheDocument();
    });

    it('clears the flash after exactly 4 seconds', async () => {
        const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
        try {
            render(<CoworkPage />);
            await screen.findByTestId('cowork-brief-input');
            fireEvent.change(screen.getByTestId('cowork-brief-input'), { target: { value: 'Send the digest' } });
            fireEvent.click(screen.getByTestId('cowork-send'));
            await screen.findByText('Off it goes — the result lands in your notifications.');

            // The timer is armed in an effect after the render that shows the
            // flash; on a loaded runner that effect can land just after the text.
            const findTimer = () => setTimeoutSpy.mock.calls.findIndex(([, ms]) => ms === 4000);
            await waitFor(() => expect(findTimer()).toBeGreaterThanOrEqual(0));
            const idx = findTimer();
            clearTimeout(setTimeoutSpy.mock.results[idx].value);
            await act(async () => { setTimeoutSpy.mock.calls[idx][0](); });

            expect(screen.queryByText(/Off it goes/)).not.toBeInTheDocument();
        } finally {
            setTimeoutSpy.mockRestore();
        }
    });

    it('hides its own creation flash the moment the new item comes back from the server (wart)', async () => {
        // The flash lives inside the composer block, and creating something
        // selects it — which replaces the composer with the detail pane. So the
        // confirmation is only ever seen when the refresh has not caught up.
        render(<CoworkPage />);
        await screen.findByTestId('cowork-brief-input');
        api.listCowork.mockResolvedValue({ items: [{ ...ITEM, id: 'new' }], maxItems: 10 });

        fireEvent.change(screen.getByTestId('cowork-brief-input'), { target: { value: 'Send the digest' } });
        fireEvent.click(screen.getByTestId('cowork-send'));

        await screen.findByTestId('cowork-detail');
        expect(screen.queryByText(/Off it goes/)).not.toBeInTheDocument();
    });

    it('sets a "Running" flash after Run now that no surface can display (wart)', async () => {
        // Run now is reachable only from the detail pane, and the detail pane
        // is exactly the state in which the flash box is not rendered — on the
        // phone layout too, where a selected item hides the whole list column.
        seed([ITEM]);
        api.runCoworkNow.mockResolvedValue({ success: true });
        render(<CoworkPage initialCoworkId="w1" />);
        await screen.findByTestId('cowork-detail');

        fireEvent.click(screen.getByTestId('cowork-run-now'));
        await waitFor(() => expect(api.runCoworkNow).toHaveBeenCalledWith('w1'));

        expect(screen.queryByText(/Running — the result lands in your notifications/)).not.toBeInTheDocument();
    });

    it('reports a failed action as an alert above the detail', async () => {
        seed([ITEM]);
        api.runCoworkNow.mockRejectedValue(new Error('Runner is offline'));
        render(<CoworkPage initialCoworkId="w1" />);
        await screen.findByTestId('cowork-detail');

        fireEvent.click(screen.getByTestId('cowork-run-now'));

        const alert = await screen.findByRole('alert');
        expect(alert).toHaveTextContent('Runner is offline');
        expect(screen.getByTestId('cowork-detail')).toBeInTheDocument();
    });
});

describe('CoworkPage — what the router is told', () => {
    it('reports a click on a row as cowork/<id>', async () => {
        const onNavigate = vi.fn();
        seed([ITEM]);
        render(<CoworkPage onNavigate={onNavigate} />);
        fireEvent.click(await screen.findByTestId('cowork-row'));
        expect(onNavigate).toHaveBeenCalledWith('cowork/w1');
    });

    it('says nothing when the selection is cleared, so the URL keeps the old item (wart)', async () => {
        const onNavigate = vi.fn();
        seed([ITEM]);
        render(<CoworkPage onNavigate={onNavigate} />);
        fireEvent.click(await screen.findByTestId('cowork-row'));
        expect(onNavigate).toHaveBeenCalledTimes(1);

        fireEvent.click(screen.getByTestId('cowork-new'));
        expect(screen.getByTestId('cowork-brief-input')).toBeInTheDocument();
        expect(onNavigate).toHaveBeenCalledTimes(1);
    });

    it('says nothing after a delete either, leaving the URL on an item that is gone (wart)', async () => {
        const onNavigate = vi.fn();
        seed([ITEM]);
        api.deleteCowork.mockResolvedValue({ success: true });
        render(<CoworkPage initialCoworkId="w1" onNavigate={onNavigate} />);
        await screen.findByTestId('cowork-detail');

        fireEvent.click(screen.getByTestId('cowork-delete'));
        api.listCowork.mockResolvedValue({ items: [], maxItems: 10 });
        fireEvent.click(screen.getByTestId('cowork-confirm-delete'));

        await waitFor(() => expect(api.deleteCowork).toHaveBeenCalledWith('w1'));
        await waitFor(() => expect(screen.queryAllByTestId('cowork-row')).toHaveLength(0));
        expect(onNavigate).not.toHaveBeenCalled();
    });

    it('shows the welcome, with no "not found" of any kind, for a deep link to a missing item', async () => {
        seed([ITEM]);
        render(<CoworkPage initialCoworkId="gone" />);
        await screen.findByTestId('cowork-row');

        expect(screen.getByTestId('cowork-welcome')).toBeInTheDocument();
        expect(screen.queryByTestId('cowork-detail')).not.toBeInTheDocument();
        expect(screen.queryByText(/not found|no longer|removed/i)).not.toBeInTheDocument();
    });
});

describe('CoworkPage — the delete confirmation', () => {
    const openConfirm = async (over = {}) => {
        seed([{ ...ITEM, ...over }]);
        api.deleteCowork.mockResolvedValue({ success: true });
        render(<CoworkPage initialCoworkId="w1" />);
        await screen.findByTestId('cowork-detail');
        fireEvent.click(screen.getByTestId('cowork-delete'));
        const panel = screen.getByText('Delete this cowork?').parentElement;
        const dialog = screen.getByRole('dialog');
        return { panel, dialog, backdrop: dialog.parentElement };
    };

    it('quotes the title and spells out what is lost', async () => {
        await openConfirm();
        expect(screen.getByText(/stops running/))
            .toHaveTextContent('“Weekly digest” stops running and its history is removed. This can’t be undone.');
    });

    it('quotes nothing at all for an untitled item, while the detail still says "Untitled cowork" (wart)', async () => {
        await openConfirm({ title: '' });
        expect(screen.getByTestId('cowork-detail')).toHaveTextContent('Untitled cowork');
        expect(screen.getByText(/stops running/)).toHaveTextContent('“” stops running');
    });

    it('closes on a backdrop click without deleting anything', async () => {
        const { backdrop } = await openConfirm();
        fireEvent.mouseDown(backdrop, { target: backdrop, bubbles: true });
        expect(screen.queryByText('Delete this cowork?')).not.toBeInTheDocument();
        expect(api.deleteCowork).not.toHaveBeenCalled();
    });

    it('ignores a click inside the panel', async () => {
        const { panel } = await openConfirm();
        fireEvent.click(panel);
        expect(screen.getByText('Delete this cowork?')).toBeInTheDocument();
    });

    it('closes on Escape and is a real dialog to a screen reader, now that it is routed through Modal', async () => {
        await openConfirm();
        expect(screen.getByRole('dialog')).toBeInTheDocument();
        fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' });
        expect(screen.queryByText('Delete this cowork?')).not.toBeInTheDocument();
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
});

describe('CoworkPage — polling while something is in flight', () => {
    const intervalSpy = () => vi.spyOn(globalThis, 'setInterval');
    const pollCall = spy => spy.mock.calls.find(([, ms]) => ms === 10_000);

    it('refreshes the list every 10 seconds while an item is running', async () => {
        const spy = intervalSpy();
        try {
            seed([{ ...ITEM, lastStatus: 'running' }]);
            render(<CoworkPage />);
            await screen.findByTestId('cowork-row');

            // The row is on screen before the effect that arms the interval has
            // flushed; wait for the registration itself, not for the DOM.
            await waitFor(() => expect(pollCall(spy)).toBeTruthy());
            const call = pollCall(spy);
            await act(async () => { call[0](); });
            expect(api.listCowork).toHaveBeenCalledTimes(2);
        } finally {
            spy.mockRestore();
        }
    });

    it('keeps polling forever for a paused item that never ran (wart: in-flight cannot tell it from a queued one)', async () => {
        const spy = intervalSpy();
        try {
            seed([{ ...ITEM, isActive: false, lastStatus: 'idle', lastRunAt: null, lastResult: null, runCount: 0 }]);
            render(<CoworkPage />);
            await screen.findByTestId('cowork-row');
            await waitFor(() => expect(pollCall(spy)).toBeTruthy());
        } finally {
            spy.mockRestore();
        }
    });

    it('does not poll once everything has settled', async () => {
        const spy = intervalSpy();
        try {
            seed([ITEM]);
            render(<CoworkPage />);
            await screen.findByTestId('cowork-row');
            // Flush the effects first, so "no interval" is a real answer and not
            // just "not yet".
            await act(async () => {});
            expect(pollCall(spy)).toBeUndefined();
        } finally {
            spy.mockRestore();
        }
    });
});

describe('CoworkPage — on a phone', () => {
    it('rides the composer above the list and drops the second pane', async () => {
        seed([ITEM]);
        render(<CoworkPage isMobile />);
        await screen.findByTestId('cowork-row');

        const aside = screen.getByTestId('cowork-row').closest('aside');
        expect(aside).toContainElement(screen.getByTestId('cowork-brief-input'));
        expect(screen.getAllByTestId('cowork-welcome')).toHaveLength(1);
    });

    it('gives the whole screen to a selected item, with a way back that the router never hears about (wart)', async () => {
        const onNavigate = vi.fn();
        seed([ITEM]);
        render(<CoworkPage isMobile initialCoworkId="w1" onNavigate={onNavigate} />);
        await screen.findByTestId('cowork-detail');

        expect(screen.queryByTestId('cowork-row')).not.toBeInTheDocument();
        expect(screen.queryByTestId('cowork-new')).not.toBeInTheDocument();
        expect(screen.queryByTestId('cowork-brief-input')).not.toBeInTheDocument();

        fireEvent.click(screen.getByLabelText('Back to the list'));
        expect(await screen.findByTestId('cowork-row')).toBeInTheDocument();
        expect(onNavigate).not.toHaveBeenCalled();
    });
});
