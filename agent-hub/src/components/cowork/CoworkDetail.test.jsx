import { render as rtlRender, screen, cleanup, waitFor, fireEvent, act, within } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import CoworkDetail from './CoworkDetail';
import { queryWrapper } from '../../test/queryWrapper';

// A fresh React Query client per render: the hooks below read through one.
const render = (ui, options) => rtlRender(ui, { wrapper: queryWrapper(), ...options });

/**
 * The detail pane says the status in words, so it is where a wrong word is
 * read rather than merely seen. Two things are pinned here: the word comes
 * from the shared table through t() (so a Dutch UI gets a Dutch word instead
 * of an English one embedded in a Dutch sentence), and the item's status and
 * a single RUN's status are looked up separately — an item that is paused can
 * perfectly well have a last run that finished.
 */

const api = vi.hoisted(() => ({
    listCoworkRuns: vi.fn(),
    listCoworkAgents: vi.fn(),
    getCoworkStats: vi.fn(),
}));
vi.mock('./coworkApi', () => api);

const item = (over = {}) => ({
    id: 'w1',
    title: 'Weekly digest',
    prompt: 'Summarise the week',
    isActive: true,
    lastStatus: 'success',
    lastRunAt: new Date().toISOString(),
    runCount: 3,
    repeatInterval: 'weekly',
    ...over,
});

const STATS = {
    total: 3, success: 3, failed: 0, avgDurationMs: 72_000, runCount: 3,
    createdAt: new Date(2026, 6, 8).toISOString(),
};

function renderDetail(over = {}, runs = []) {
    api.listCoworkRuns.mockResolvedValue({ runs, total: runs.length });
    api.getCoworkStats.mockResolvedValue(STATS);
    return render(
        <CoworkDetail
            item={item(over)}
            agents={[]}
            onRunNow={vi.fn()}
            onToggle={vi.fn()}
            onDelete={vi.fn()}
            onSave={vi.fn()}
            onEdit={vi.fn()}
            onCancelEdit={vi.fn()}
            busy={false}
            reloadKey={0}
            editing={false}
            saveError={null}
        />,
    );
}

describe('CoworkDetail — the status word', () => {
    beforeEach(() => { cleanup(); api.listCoworkRuns.mockReset(); });

    it('says "Running" for a running item', () => {
        renderDetail({ lastStatus: 'running' });
        const pill = screen.getByTestId('cowork-status');
        expect(pill.getAttribute('data-status-key')).toBe('run_status.running');
        expect(pill.textContent).toBe('Running');
    });

    it('says "Paused" for a switched-off item, under the run_status.paused key', () => {
        // Only the word and the key are checked here. The COLOUR is not: the
        // `paused` badge is the same neutral recipe as `queued` and `idle`, so
        // there is nothing to tell apart at this call site.
        renderDetail({ isActive: false, lastStatus: 'idle' });
        const pill = screen.getByTestId('cowork-status');
        expect(pill.getAttribute('data-status-key')).toBe('run_status.paused');
        expect(pill.textContent).toBe('Paused');
    });

    it('carries a run_status.* key on the badge, so a locale can replace the word', () => {
        // The whole reason the table hands out keys: with a locale loaded the
        // pill must render the translated word. The English literal in the
        // component is only ever the t() fallback. What is checked here is the
        // KEY on the element — not that any translation actually happened.
        renderDetail({ lastStatus: 'running' });
        const pill = screen.getByTestId('cowork-status');
        expect(pill.getAttribute('data-status-key')).toMatch(/^run_status\./);
    });
});

describe('CoworkDetail — the history below it', () => {
    beforeEach(() => { cleanup(); api.listCoworkRuns.mockReset(); });

    it('labels each run by its OWN status, not the item\'s', async () => {
        renderDetail(
            { isActive: false, lastStatus: 'idle' },
            [{ id: 'r1', status: 'error', startedAt: new Date().toISOString(), triggerKind: 'manual', durationMs: 1200, error: 'Mailbox not connected' }],
        );
        await waitFor(() => expect(screen.getByTestId('cowork-run')).toBeTruthy());
        expect(screen.getByTestId('cowork-status').textContent).toBe('Paused');
        const runBadge = screen.getByTestId('cowork-run').querySelector('[data-status-key]');
        expect(runBadge.getAttribute('data-status-key')).toBe('run_status.error');
        expect(runBadge.textContent).toBe('Failed');
    });
});

/* ─────────────────────────────────────────────────────────────────────────
 * CHARACTERISATION — everything below pins the detail pane as it is TODAY,
 * ahead of CW-06 (a header that says something about the run in flight),
 * CW-13 and CW-18 (a badge that counts the running one). Several tests are
 * named "wrat": they lock in behaviour that is wrong on purpose, so that
 * changing it has to break a test rather than pass unnoticed.
 * ──────────────────────────────────────────────────────────────────────── */

/** Full control over props, with the history settled before we assert. */
async function renderFull(over = {}, extra = {}, runs = [], stats = STATS) {
    api.listCoworkRuns.mockResolvedValue({ runs, total: runs.length });
    api.getCoworkStats.mockResolvedValue(stats);
    const entry = item(over);
    const handlers = {
        onRunNow: vi.fn(), onToggle: vi.fn(), onDelete: vi.fn(),
        onSave: vi.fn(), onEdit: vi.fn(), onCancelEdit: vi.fn(),
    };
    const utils = render(
        <CoworkDetail
            item={entry}
            agents={[]}
            {...handlers}
            busy={false}
            reloadKey={0}
            editing={false}
            saveError={null}
            {...extra}
        />,
    );
    await act(async () => {});
    return { ...utils, handlers, entry };
}

/** The identity block at the top: title, badge, schedule, count, buttons. */
const header = () => screen.getByTestId('cowork-detail').firstElementChild;

/** The assignment card: the brief in the user's words, plus its pills. */
const briefCard = () => screen.getByTestId('cowork-brief');

/** The bordered block that prints the brief. */
const brief = () => briefCard().querySelector('.whitespace-pre-wrap');

describe('CoworkDetail — the header with no run in flight', () => {
    beforeEach(() => { cleanup(); api.listCoworkRuns.mockReset(); });

    it('falls back to "Untitled cowork" when the item was never named', async () => {
        await renderFull({ title: '' });
        expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Untitled cowork');
    });

    it('names the cadence on the assignment card, not loose in the header (CW-08)', async () => {
        await renderFull({ repeatInterval: 'weekdays', timeOfDay: '08:00' });
        expect(briefCard()).toHaveTextContent('Every weekday 08:00');
        expect(briefCard()).not.toHaveTextContent('Runs once');
        // The header is down to identity, state and the actions.
        expect(header()).not.toHaveTextContent('Every weekday');

        cleanup();
        await renderFull({ repeatInterval: null });
        expect(briefCard()).toHaveTextContent('Runs once');
    });

    it('announces the next run only while the item is switched on', async () => {
        // Noon on today's local date, so "Today at …" holds however close to
        // midnight the suite happens to run.
        const noon = new Date(); noon.setHours(12, 0, 0, 0);
        const soon = noon.toISOString();
        await renderFull({ nextRunAt: soon });
        expect(briefCard()).toHaveTextContent(/next Today at/);

        cleanup();
        await renderFull({ nextRunAt: soon, isActive: false });
        expect(briefCard()).not.toHaveTextContent('next');

        cleanup();
        await renderFull({ nextRunAt: null });
        expect(briefCard()).not.toHaveTextContent('next');
    });

    it('wrat: a nextRunAt that has already gone by is still announced as "next"', async () => {
        // A stalled runner leaves the header confidently promising a moment
        // three days in the past. Nothing on screen says it is overdue.
        const past = new Date(Date.now() - 3 * 86400_000).toISOString();
        await renderFull({ nextRunAt: past });
        expect(briefCard()).toHaveTextContent(/next \w+ \d+ at|next \d+ \w+ at/);
        expect(briefCard()).not.toHaveTextContent('overdue');
        expect(briefCard()).not.toHaveTextContent('late');
    });

    it('leaves the tally to the figure cards instead of a loose count in the header (CW-11)', async () => {
        await renderFull({ runCount: 5 }, {}, [], { ...STATS, runCount: 5 });
        await waitFor(() => expect(screen.getByTestId('cowork-stats')).toHaveTextContent('5'));
        expect(header()).not.toHaveTextContent('5 runs');
        expect(header()).not.toHaveTextContent('runs');
    });

    it('renders its English through t() fallbacks — see CoworkDetail.i18n.test.jsx', async () => {
        // The words are asserted here, the ROUTE they took is asserted in the
        // sibling suite that echoes keys instead of fallbacks. This one only
        // pins that the English a translator has not reached yet still reads.
        const { container } = await renderFull({ repeatInterval: null });
        expect(container.querySelectorAll('[data-status-key]')).toHaveLength(1);
        for (const word of ['Runs once', 'Edit', 'Run now', 'Pause', 'The assignment']) {
            expect(screen.getByTestId('cowork-detail')).toHaveTextContent(word);
        }
        expect(screen.getByTestId('cowork-delete')).toHaveAttribute('aria-label', 'Delete this cowork');
    });
});

describe('CoworkDetail — the header while a run IS in flight (CW-06 / CW-18)', () => {
    beforeEach(() => { cleanup(); api.listCoworkRuns.mockReset(); });

    it('says since WHEN the run has been going, on the clock (CW-06)', async () => {
        const started = new Date(); started.setHours(8, 0, 4, 0);
        await renderFull({ lastStatus: 'running', currentRunStartedAt: started.toISOString() });
        // "Running since 08:00:04" — seconds included, because a run that
        // started this second and one that hung four hours ago used to look
        // exactly the same.
        expect(screen.getByTestId('cowork-status')).toHaveTextContent('Running since 08:00:04');
    });

    it('reads the clock on 24 hours, like every other time in this column', async () => {
        // startedAtClock is a SECOND clock layer beside coworkFormat's — same
        // options plus seconds — so CW-16's whole point (h23, never AM/PM
        // borrowed from the browser locale) has to be pinned here too. A
        // half-past-two run is 14:30, never 02:30 PM, and never 24:30 either.
        const started = new Date(); started.setHours(14, 30, 5, 0);
        await renderFull({ lastStatus: 'running', currentRunStartedAt: started.toISOString() });
        const badge = screen.getByTestId('cowork-status');
        expect(badge).toHaveTextContent('14:30:05');
        expect(badge.textContent).not.toMatch(/AM|PM/i);
    });

    it('starts the day at 00, not at 24', async () => {
        // The other end of the same choice: h24 renders midnight as 24:00:xx.
        const started = new Date(); started.setHours(0, 5, 9, 0);
        await renderFull({ lastStatus: 'running', currentRunStartedAt: started.toISOString() });
        expect(screen.getByTestId('cowork-status')).toHaveTextContent('00:05:09');
    });

    it('falls back to the plain word when the server sent no start time', async () => {
        // Null is the normal value for anything that is not running, and an
        // in-flight run whose open row was reaped has one too. The badge then
        // claims nothing it cannot back up.
        await renderFull({ lastStatus: 'running' });
        expect(screen.getByTestId('cowork-status').textContent).toBe('Running');

        cleanup();
        await renderFull({ lastStatus: 'running', currentRunStartedAt: 'not-a-date' });
        expect(screen.getByTestId('cowork-status').textContent).toBe('Running');
    });

    it('ignores a start time on an item that is not running', async () => {
        // A stale field on a finished item must not resurrect the sentence.
        await renderFull({
            lastStatus: 'success',
            currentRunStartedAt: new Date().toISOString(),
        });
        expect(screen.getByTestId('cowork-status').textContent).toBe('Finished');
    });

    it('wrat: the run tally still leaves the in-flight run out', async () => {
        // Unchanged by CW-11: the figure card reads the schedule's own
        // counter, which the runner only bumps once a run has closed.
        await renderFull({ lastStatus: 'running', runCount: 3 }, {}, [], { ...STATS, runCount: 3 });
        await waitFor(() => expect(screen.getByTestId('cowork-stats')).toHaveTextContent('3'));
        expect(header()).toHaveTextContent('Running');
    });
});

describe('CoworkDetail — the status word for the remaining branches', () => {
    beforeEach(() => { cleanup(); api.listCoworkRuns.mockReset(); });

    const pill = () => screen.getByTestId('cowork-status');

    it('a switched-on item that has never run is "Waiting to start"', async () => {
        await renderFull({ isActive: true, lastRunAt: null, runCount: 0, lastStatus: null });
        expect(pill().getAttribute('data-status-key')).toBe('run_status.queued');
        expect(pill()).toHaveTextContent('Waiting to start');
    });

    it('wrat: a one-off just launched with Run now reads as "Idle"', async () => {
        // POST /api/cowork + startNow deactivates the row server-side before
        // it fires, so this is what a user sees seconds after pressing Run —
        // the exact misreading coworkStatus\'s own docstring warns about.
        await renderFull({ isActive: false, lastRunAt: null, runCount: 0, lastStatus: null });
        expect(pill().getAttribute('data-status-key')).toBe('run_status.idle');
        expect(pill()).toHaveTextContent('Idle');
    });

    it('wrat: a paused item whose last run succeeded claims to be "Finished"', async () => {
        // The badge and the button directly contradict each other: "Finished"
        // above a button offering to Resume it.
        await renderFull({ isActive: false, lastStatus: 'success' });
        expect(pill().getAttribute('data-status-key')).toBe('run_status.success');
        expect(pill()).toHaveTextContent('Finished');
        expect(screen.getByTestId('cowork-toggle')).toHaveTextContent('Resume');
    });

    it('wrat: a server status the token table does not know renders as "Idle"', async () => {
        await renderFull({ isActive: true, lastStatus: 'pending' });
        expect(pill().getAttribute('data-status-key')).toBe('run_status.idle');
        expect(pill()).toHaveTextContent('Idle');
    });
});

describe('CoworkDetail — the action buttons', () => {
    beforeEach(() => { cleanup(); api.listCoworkRuns.mockReset(); });

    it('hands the id to run and toggle, but the whole item to delete', async () => {
        const { handlers, entry } = await renderFull();

        fireEvent.click(screen.getByTestId('cowork-run-now'));
        expect(handlers.onRunNow).toHaveBeenCalledWith('w1');

        fireEvent.click(screen.getByTestId('cowork-toggle'));
        expect(handlers.onToggle).toHaveBeenCalledWith('w1');

        fireEvent.click(screen.getByTestId('cowork-delete'));
        expect(handlers.onDelete).toHaveBeenCalledWith(entry);

        fireEvent.click(screen.getByTestId('cowork-edit'));
        expect(handlers.onEdit).toHaveBeenCalledTimes(1);
    });

    it('offers Pause for a live item and Resume for a switched-off one', async () => {
        await renderFull({ isActive: true });
        expect(screen.getByTestId('cowork-toggle')).toHaveTextContent('Pause');

        cleanup();
        await renderFull({ isActive: false });
        expect(screen.getByTestId('cowork-toggle')).toHaveTextContent('Resume');
    });

    it('busy disables every action', async () => {
        await renderFull({}, { busy: true });
        for (const id of ['cowork-edit', 'cowork-run-now', 'cowork-toggle', 'cowork-delete']) {
            expect(screen.getByTestId(id)).toBeDisabled();
        }
    });

    it('Run now is off while the item reports itself running', async () => {
        await renderFull({ lastStatus: 'running' });
        expect(screen.getByTestId('cowork-run-now')).toBeDisabled();
        // Only that one — pausing or deleting a running item is still allowed.
        expect(screen.getByTestId('cowork-toggle')).toBeEnabled();
        expect(screen.getByTestId('cowork-delete')).toBeEnabled();
    });

    it('wrat: Run now stays clickable for an item the badge calls "Waiting to start"', async () => {
        // The guard reads item.lastStatus directly instead of the derived
        // status, so every in-flight state except the literal string
        // "running" can be fired a second time from this button.
        const { handlers } = await renderFull({ isActive: true, lastRunAt: null, runCount: 0, lastStatus: null });
        expect(screen.getByTestId('cowork-status')).toHaveTextContent('Waiting to start');

        const button = screen.getByTestId('cowork-run-now');
        expect(button).toBeEnabled();
        fireEvent.click(button);
        expect(handlers.onRunNow).toHaveBeenCalledWith('w1');
    });
});

describe('CoworkDetail — the brief it prints', () => {
    beforeEach(() => { cleanup(); api.listCoworkRuns.mockReset(); });

    it('wrat: the prompt is plain text while a run result is Markdown', async () => {
        // The same surface parses run output as Markdown one section lower.
        const { container } = await renderFull({ prompt: '# Weekly digest\n**bold** and a - list' });
        expect(brief().textContent).toBe('# Weekly digest\n**bold** and a - list');
        expect(container.querySelector('h1')).toBeNull();
        expect(container.querySelector('strong')).toBeNull();
    });

    it('leaves an empty bordered box when there is no prompt', async () => {
        await renderFull({ prompt: '' });
        expect(brief()).not.toBeNull();
        expect(brief().textContent).toBe('');
    });
});

describe('CoworkDetail — the assignment card and its pills (CW-08)', () => {
    beforeEach(() => { cleanup(); api.listCoworkRuns.mockReset(); api.getCoworkStats.mockReset(); });

    /** The pills, as the words they show. */
    const pillTexts = () => [...briefCard().querySelectorAll('span.rounded-full')]
        .map(el => el.textContent.trim())
        .filter(Boolean);

    it('labels the brief and prints it in the user’s own words', async () => {
        await renderFull({ prompt: 'Check yesterday’s quotes against the price list.' });
        expect(briefCard()).toHaveTextContent('The assignment');
        expect(brief().textContent).toBe('Check yesterday’s quotes against the price list.');
    });

    it('names the tier rather than a model, because under auto no model is chosen yet', async () => {
        await renderFull({ modelTier: 'thinking' });
        expect(pillTexts()).toContain('Think');

        cleanup();
        await renderFull({ modelTier: null });
        // No tier stored means the server picks; the card claims nothing.
        expect(pillTexts().join(' ')).not.toMatch(/Think|Fast|Auto/);
    });

    it('names the agent this work was handed to, when there is one', async () => {
        await renderFull(
            { agentId: 'a1' },
            { agents: [{ id: 'a1', name: 'Quote checker' }, { id: 'a2', name: 'Someone else' }] },
        );
        expect(pillTexts()).toContain('Quote checker');
        expect(pillTexts()).not.toContain('Someone else');
    });

    it('counts the apps this run may touch, singular and plural', async () => {
        await renderFull({ enabledApps: ['gmail', 'calendar'] });
        expect(pillTexts()).toContain('2 apps');

        cleanup();
        await renderFull({ enabledApps: ['gmail'] });
        expect(pillTexts()).toContain('1 app');

        cleanup();
        await renderFull({ enabledApps: [] });
        expect(pillTexts().join(' ')).not.toMatch(/app/i);
    });

    it('claims no privacy shield and no sources, because neither exists yet (CW-09/CW-10)', async () => {
        // The artboard draws "Prijslijst 2026", "Offertes" and "Privacyschild
        // aan". A cowork item has no knowledge-base or table binding at all,
        // and the non-agent run path runs no shield. A pill that cannot be
        // backed up is worse than a missing pill on a privacy product.
        await renderFull({ enabledApps: ['gmail'], modelTier: 'fast' });
        const card = briefCard().textContent;
        expect(card).not.toMatch(/shield|privacy/i);
        expect(card).not.toMatch(/knowledge base|price list/i);
    });

    it('paints its pills with the shared kind tokens, never a colour of its own', async () => {
        // kindColors owns the mapping: a clock pill is the same teal as a
        // trigger node in the Builder because it means the same thing.
        await renderFull({ enabledApps: ['gmail'], modelTier: 'fast', agentId: 'a1' }, {
            agents: [{ id: 'a1', name: 'Quote checker' }],
        });
        const colours = [...briefCard().querySelectorAll('span.rounded-full svg')]
            .map(el => el.getAttribute('style') || '');
        expect(colours.length).toBeGreaterThan(2);
        for (const style of colours) {
            expect(style).toMatch(/var\(--(type|kind)-[a-z]+\)/);
        }
    });
});

describe('CoworkDetail — the header identity (CW-06)', () => {
    beforeEach(() => { cleanup(); api.listCoworkRuns.mockReset(); api.getCoworkStats.mockReset(); });

    it('opens with a tinted type tile, then the title, then the state', async () => {
        await renderFull({ title: 'Quotes of yesterday' });
        const tile = header().firstElementChild;
        expect(tile.getAttribute('style')).toContain('var(--type-ai)');
        expect(tile.querySelector('svg')).not.toBeNull();
        expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Quotes of yesterday');
    });

    it('gives Run now the accent tokens and leaves the rest secondary', async () => {
        // One primary action per pane, and it follows the admin's accent
        // through the eight themes rather than the artboard's ink hex.
        await renderFull();
        const style = screen.getByTestId('cowork-run-now').getAttribute('style');
        expect(style).toContain('var(--accent-primary)');
        expect(style).toContain('var(--accent-primary-fg)');
        expect(screen.getByTestId('cowork-toggle').getAttribute('style')).not.toContain('--accent-primary');
    });
});

describe('CoworkDetail — editing', () => {
    beforeEach(() => { cleanup(); api.listCoworkRuns.mockReset(); });

    it('replaces the entire pane with the form', async () => {
        await renderFull({}, { editing: true });
        expect(screen.getByText('Edit cowork')).toBeInTheDocument();
        expect(screen.getByTestId('cowork-edit-form')).toBeInTheDocument();

        for (const id of ['cowork-status', 'cowork-edit', 'cowork-run-now', 'cowork-toggle', 'cowork-delete']) {
            expect(screen.queryByTestId(id)).not.toBeInTheDocument();
        }
        expect(screen.queryByTestId('cowork-history')).not.toBeInTheDocument();
        expect(screen.queryByTestId('cowork-stats')).not.toBeInTheDocument();
    });

    it('wrat: opening the editor unmounts the history, and closing it refetches from scratch', async () => {
        const runs = [{ id: 'r1', status: 'success', startedAt: new Date().toISOString(), triggerKind: 'manual', durationMs: 900, result: 'ok' }];
        api.listCoworkRuns.mockResolvedValue({ runs, total: 1 });
        const entry = item();
        const shared = {
            item: entry, agents: [], onRunNow: vi.fn(), onToggle: vi.fn(), onDelete: vi.fn(),
            onSave: vi.fn(), onEdit: vi.fn(), onCancelEdit: vi.fn(),
            busy: false, reloadKey: 0, saveError: null,
        };
        const { rerender } = render(<CoworkDetail {...shared} editing={false} />);
        await waitFor(() => expect(screen.getByTestId('cowork-run')).toBeTruthy());
        expect(api.listCoworkRuns).toHaveBeenCalledTimes(1);

        rerender(<CoworkDetail {...shared} editing />);
        expect(screen.queryByTestId('cowork-run')).not.toBeInTheDocument();
        expect(api.listCoworkRuns).toHaveBeenCalledTimes(1);

        rerender(<CoworkDetail {...shared} editing={false} />);
        // Same item, same reloadKey — the history still round-trips again,
        // and shows "Loading history…" a second time on the way.
        await waitFor(() => expect(api.listCoworkRuns).toHaveBeenCalledTimes(2));
    });

    it('shows the save error the parent hands down', async () => {
        await renderFull({}, { editing: true, saveError: 'Could not save this work' });
        expect(screen.getByRole('alert')).toHaveTextContent('Could not save this work');
    });
});

describe('CoworkDetail — the history underneath', () => {
    beforeEach(() => { cleanup(); api.listCoworkRuns.mockReset(); });

    it('asks the history and the figures for its OWN id', async () => {
        await renderFull({ id: 'w9' });
        expect(api.listCoworkRuns).toHaveBeenCalledWith('w9');
        expect(api.getCoworkStats).toHaveBeenCalledWith('w9');
        // The heading lives inside the history card now, not above it.
        expect(within(screen.getByTestId('cowork-history')).getByRole('heading', { level: 3 }))
            .toHaveTextContent('What happened');
    });

    it('the run rows carry their own status, separate from the item badge', async () => {
        await renderFull(
            { lastStatus: 'running' },
            {},
            [{ id: 'r1', status: 'success', startedAt: new Date().toISOString(), triggerKind: 'schedule', durationMs: 900, result: 'ok' }],
        );
        expect(screen.getByTestId('cowork-status')).toHaveTextContent('Running');
        const row = screen.getByTestId('cowork-run');
        expect(within(row).getByText('Finished')).toBeInTheDocument();
        expect(row).toHaveTextContent('ok');
    });
});
