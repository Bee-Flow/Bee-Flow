import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import ExecutionBar from './ExecutionBar';
import { runTitle } from './runLanguage';

/**
 * CHARACTERISATION — the run bar exactly as it behaves today (2026-09-06).
 *
 * Nothing here is an opinion about what the bar SHOULD say. Every assertion
 * pins a string, an attribute or a call argument that exists right now, so the
 * RUN-track rebuild (skipped-step counts, a code+params skip sentence, the
 * filter chip) shows up as a diff in this file instead of silently changing
 * what the user reads.
 *
 * No mocks: the bar's collaborators are the pure runLanguage/historyUtils
 * helpers plus RunStatusBits, which translates through the real EN catalogue
 * that src/test/setup.js has already awaited (same choice ExecutionsTable.test
 * and RunStepTimeline.test make).
 */

const baseRun = (over = {}) => ({
    id: 'abcdefgh-1234-5678',
    automationId: 'a1',
    status: 'success',
    mode: 'live',
    startedAt: '2026-08-12T14:03:00.000Z',
    durationMs: 1234,
    ...over,
});

const renderBar = (props = {}) => render(
    <ExecutionBar
        run={baseRun()}
        onBack={vi.fn()}
        onRetry={vi.fn()}
        onCancel={vi.fn()}
        onApprove={vi.fn()}
        onOpenEditor={vi.fn()}
        {...props}
    />,
);

const badge = () => document.querySelector('[data-testid="run-status-badge"]');

beforeEach(cleanup);

// ── the skeleton ────────────────────────────────────────────────────────────
describe('ExecutionBar — before the run resolves', () => {
    it('renders a loading skeleton that still carries the only way out', () => {
        renderBar({ run: null });
        expect(screen.getByText('Loading the run…')).toBeTruthy();
        expect(screen.getByRole('button', { name: /Runs/ })).toBeTruthy();
    });

    it('shows no status, no timing and none of the actions while run is null', () => {
        renderBar({ run: null });
        expect(badge()).toBeNull();
        expect(screen.queryByRole('button', { name: /Copy link/ })).toBeNull();
        expect(screen.queryByRole('button', { name: /Open in editor/ })).toBeNull();
        expect(screen.queryByText(/took/)).toBeNull();
    });

    it('the back button works from the skeleton', () => {
        const onBack = vi.fn();
        renderBar({ run: null, onBack });
        fireEvent.click(screen.getByRole('button', { name: /Runs/ }));
        expect(onBack).toHaveBeenCalledTimes(1);
    });
});

// ── the identity line ───────────────────────────────────────────────────────
describe('ExecutionBar — how the run names itself', () => {
    it('shows runTitle(run) and keeps the raw id in the tooltip only', () => {
        const run = baseRun();
        renderBar({ run });
        const name = screen.getByText(runTitle(run));
        expect(name.getAttribute('title')).toBe('abcdefgh-1234-5678');
        // The hex id is never the visible name.
        expect(name.textContent).not.toBe(run.id);
    });

    it('falls back to "Run " + the first 8 id characters when the run never started', () => {
        renderBar({ run: baseRun({ startedAt: null }) });
        expect(screen.getByText('Run abcdefgh')).toBeTruthy();
    });

    it('prints the status word from the dictionary, keyed by the status token', () => {
        renderBar({ run: baseRun({ status: 'success' }) });
        expect(badge().getAttribute('data-status-key')).toBe('run_status.success');
        expect(badge().textContent).toBe('Finished');
    });

    it('maps awaiting_confirm onto the awaiting_approval word', () => {
        renderBar({ run: baseRun({ status: 'awaiting_confirm' }) });
        expect(badge().getAttribute('data-status-key')).toBe('run_status.awaiting_approval');
        expect(badge().textContent).toBe('Waiting for approval');
    });

    it('degrades an unknown status to the neutral idle token instead of printing it', () => {
        renderBar({ run: baseRun({ status: 'exploded' }) });
        expect(badge().getAttribute('data-status-key')).toBe('run_status.idle');
        expect(badge().textContent).toBe('Idle');
        expect(screen.queryByText('exploded')).toBeNull();
    });

    it('shows the dry-run pill BESIDE the outcome, not instead of it', () => {
        renderBar({ run: baseRun({ mode: 'dry_run' }) });
        expect(screen.getByText('dry-run')).toBeTruthy();
        expect(badge().textContent).toBe('Finished');
        // runTitle also marks it.
        expect(screen.getByText(/· test$/)).toBeTruthy();
    });
});

// ── timing, trigger, version ────────────────────────────────────────────────
describe('ExecutionBar — timing, trigger and version', () => {
    it('prints the duration as "took 1.2s"', () => {
        renderBar({ run: baseRun({ durationMs: 1234 }) });
        expect(screen.getByText('took 1.2s')).toBeTruthy();
    });

    it('drops the duration entirely when durationMs is null', () => {
        renderBar({ run: baseRun({ durationMs: null }) });
        // No span at all — not an empty one. `/^took /` (with the trailing
        // space) would still pass against a rendered "took " + nothing,
        // because getByText trims; `/^took/` catches that too.
        expect(screen.queryByText(/^took/)).toBeNull();
        expect(document.querySelector('.tabular-nums')).toBeNull();
    });

    it('still prints a zero duration as "took 0ms"', () => {
        renderBar({ run: baseRun({ durationMs: 0 }) });
        expect(screen.getByText('took 0ms')).toBeTruthy();
    });

    it('names the trigger kind in words', () => {
        renderBar({ run: baseRun({ triggerKind: 'schedule' }) });
        expect(screen.getByText('· On a schedule')).toBeTruthy();
    });

    it('falls back to automationTriggerType when triggerKind is absent', () => {
        renderBar({ run: baseRun({ triggerKind: null, automationTriggerType: 'webhook' }) });
        expect(screen.getByText('· A webhook — another system called this')).toBeTruthy();
    });

    it('prints an unknown trigger kind raw, underscores swapped for spaces (wrat: untranslated machine word)', () => {
        renderBar({ run: baseRun({ triggerKind: 'brand_new_kind' }) });
        expect(screen.getByText('· brand new kind')).toBeTruthy();
    });

    it('shows nothing about the trigger when the run carries neither field', () => {
        renderBar({ run: baseRun({ triggerKind: null, automationTriggerType: null }) });
        expect(screen.queryByText(/^· /)).toBeNull();
    });

    it('names the entry point from the versioned definition snapshot, not from the id', () => {
        renderBar({
            run: baseRun({ rootStepId: 't2', rootTriggerLabel: 'Renamed since' }),
            definition: { triggers: [{ id: 't1', label: 'Schedule' }, { id: 't2', label: 'Inbox mail' }] },
        });
        expect(screen.getByText('· via Inbox mail')).toBeTruthy();
        expect(screen.queryByText('· via Renamed since')).toBeNull();
    });

    it('falls back to the server-resolved label when the snapshot has no such trigger', () => {
        renderBar({
            run: baseRun({ rootStepId: 't9', rootTriggerLabel: 'From the list' }),
            definition: { triggers: [{ id: 't1', label: 'Schedule' }] },
        });
        expect(screen.getByText('· via From the list')).toBeTruthy();
    });

    it('says nothing about the entry point when the run has no rootStepId', () => {
        renderBar({ run: baseRun({ rootStepId: null, rootTriggerLabel: 'ignored' }), definition: { triggers: [] } });
        expect(screen.queryByText(/· via/)).toBeNull();
    });

    it('shows the saved-version chip, and shows it for version 0 too', () => {
        const { unmount } = renderBar({ run: baseRun({ version: 7 }) });
        expect(screen.getByText('v7').getAttribute('title')).toBe('This run used saved version 7.');
        unmount();
        renderBar({ run: baseRun({ version: 0 }) });
        expect(screen.getByText('v0')).toBeTruthy();
    });

    it('hides the version chip when version is null', () => {
        renderBar({ run: baseRun({ version: null }) });
        expect(screen.queryByText(/^v\d/)).toBeNull();
    });
});

// ── lineage + counters ──────────────────────────────────────────────────────
describe('ExecutionBar — lineage and counters', () => {
    it('offers the parent run only when this run started its own journey', () => {
        const onOpenRun = vi.fn();
        renderBar({ run: baseRun({ id: 'r2', parentRunId: 'r1', rootRunId: 'r2' }), onOpenRun });
        const chip = screen.getByRole('button', { name: 'This was a retry of an earlier run' });
        fireEvent.click(chip);
        expect(onOpenRun).toHaveBeenCalledWith('r1');
    });

    it('says nothing for a continuation of the same journey (same rootRunId as its parent)', () => {
        renderBar({ run: baseRun({ id: 'r2', parentRunId: 'r1', rootRunId: 'r1' }), onOpenRun: vi.fn() });
        expect(screen.queryByText('This was a retry of an earlier run')).toBeNull();
    });

    it('still shows the retry chip when there is nowhere to open it, merely disabled', () => {
        renderBar({ run: baseRun({ id: 'r2', parentRunId: 'r1', rootRunId: 'r2' }), onOpenRun: null });
        expect(screen.getByRole('button', { name: 'This was a retry of an earlier run' }).disabled).toBe(true);
    });

    it('counts handled problems in hard-coded English (wrat: this sentence never passes through t())', () => {
        const { unmount } = renderBar({ run: baseRun({ handledErrorCount: 1 }) });
        expect(screen.getByText('1 problem handled automatically')).toBeTruthy();
        unmount();
        renderBar({ run: baseRun({ handledErrorCount: 3 }) });
        expect(screen.getByText('3 problems handled automatically')).toBeTruthy();
    });

    it('says nothing when handledErrorCount is 0, missing or non-numeric', () => {
        for (const handledErrorCount of [0, undefined, 'lots']) {
            cleanup();
            renderBar({ run: baseRun({ handledErrorCount }) });
            expect(screen.queryByText(/handled automatically/)).toBeNull();
        }
    });
});

// ── deadlines + error notes ─────────────────────────────────────────────────
describe('ExecutionBar — deadlines and error notes', () => {
    it('counts down an approval deadline while the run is awaiting', () => {
        const in30m = new Date(Date.now() + 30 * 60_000).toISOString();
        renderBar({ run: baseRun({ status: 'awaiting_approval', awaitingStepExpiresAt: in30m }) });
        expect(screen.getByText('expires in 30m')).toBeTruthy();
    });

    it('says "approval expired" once the deadline has passed', () => {
        const ago = new Date(Date.now() - 60_000).toISOString();
        renderBar({ run: baseRun({ status: 'awaiting_confirm', awaitingStepExpiresAt: ago }) });
        expect(screen.getByText('approval expired')).toBeTruthy();
    });

    it('hides the deadline on a run that is no longer awaiting, even though the field survives', () => {
        const in30m = new Date(Date.now() + 30 * 60_000).toISOString();
        renderBar({ run: baseRun({ status: 'success', awaitingStepExpiresAt: in30m }) });
        expect(screen.queryByText(/expires in/)).toBeNull();
    });

    it('adds the typed error class in plain words next to a failure', () => {
        renderBar({ run: baseRun({ status: 'error', errorClass: 'auth' }) });
        expect(screen.getByText('(a connection is no longer signed in)')).toBeTruthy();
    });

    it('prints no note for an error class it cannot name — ApprovalRejected included (wrat)', () => {
        renderBar({ run: baseRun({ status: 'error', errorClass: 'ApprovalRejected' }) });
        expect(screen.queryByText(/^\(/)).toBeNull();
    });

    it('keeps the class note off a non-error run that carries one', () => {
        renderBar({ run: baseRun({ status: 'success', errorClass: 'timeout' }) });
        expect(screen.queryByText('(it took too long and was stopped)')).toBeNull();
    });
});

// ── the actions ─────────────────────────────────────────────────────────────
describe('ExecutionBar — the action buttons', () => {
    it('offers "Run it again" only for a failed run that has an onRetry', () => {
        const onRetry = vi.fn().mockResolvedValue(undefined);
        const { unmount } = renderBar({ run: baseRun({ status: 'error' }), onRetry });
        fireEvent.click(screen.getByRole('button', { name: /Run it again/ }));
        expect(onRetry).toHaveBeenCalledTimes(1);
        unmount();
        renderBar({ run: baseRun({ status: 'error' }), onRetry: null });
        expect(screen.queryByRole('button', { name: /Run it again/ })).toBeNull();
    });

    it('does not offer a retry for a successful run', () => {
        renderBar({ run: baseRun({ status: 'success' }) });
        expect(screen.queryByRole('button', { name: /Run it again/ })).toBeNull();
    });

    it('offers "Stop it" for running AND for queued', () => {
        for (const status of ['running', 'queued']) {
            cleanup();
            const onCancel = vi.fn().mockResolvedValue(undefined);
            renderBar({ run: baseRun({ status }), onCancel });
            fireEvent.click(screen.getByRole('button', { name: /Stop it/ }));
            expect(onCancel).toHaveBeenCalledTimes(1);
        }
    });

    it('gives awaiting_confirm a one-click Approve, passing the decision word', async () => {
        const onApprove = vi.fn().mockResolvedValue(undefined);
        renderBar({ run: baseRun({ status: 'awaiting_confirm' }), onApprove });
        fireEvent.click(screen.getByRole('button', { name: /Approve/ }));
        expect(onApprove).toHaveBeenCalledWith('approve');
        await waitFor(() => expect(screen.getByRole('button', { name: /Approve/ }).disabled).toBe(false));
    });

    it('gives awaiting_confirm a one-click Reject, passing the decision word', async () => {
        const onApprove = vi.fn().mockResolvedValue(undefined);
        renderBar({ run: baseRun({ status: 'awaiting_confirm' }), onApprove });
        fireEvent.click(screen.getByRole('button', { name: /Reject/ }));
        expect(onApprove).toHaveBeenCalledWith('reject');
        await waitFor(() => expect(screen.getByRole('button', { name: /Reject/ }).disabled).toBe(false));
    });

    it('silently drops a SECOND action while the first is in flight, and the dropped button never looks disabled (wrat)', async () => {
        // `act()` guards on one shared `pending` key, but BarButton only
        // disables the button whose own key is pending. So Reject stays fully
        // clickable while Approve is running — and the click does nothing at
        // all: no call, no message, no spinner.
        let release;
        const onApprove = vi.fn(() => new Promise((res) => { release = res; }));
        renderBar({ run: baseRun({ status: 'awaiting_confirm' }), onApprove });
        fireEvent.click(screen.getByRole('button', { name: /Approve/ }));
        const reject = screen.getByRole('button', { name: /Reject/ });
        expect(reject.disabled).toBe(false);
        fireEvent.click(reject);
        expect(onApprove).toHaveBeenCalledTimes(1);
        expect(onApprove).toHaveBeenCalledWith('approve');
        expect(screen.queryByRole('alert')).toBeNull();
        release();
        await waitFor(() => expect(screen.getByRole('button', { name: /Approve/ }).disabled).toBe(false));
    });

    it('gives awaiting_approval NO buttons on the bar — the panel below decides', () => {
        renderBar({ run: baseRun({ status: 'awaiting_approval' }), onApprove: vi.fn() });
        expect(screen.queryByRole('button', { name: /Approve/ })).toBeNull();
        expect(screen.queryByRole('button', { name: /Reject/ })).toBeNull();
    });

    it('reports a failed action inline, naming the internal action key (wrat: "retry failed: …")', async () => {
        const onRetry = vi.fn().mockRejectedValue(new Error('server said no'));
        renderBar({ run: baseRun({ status: 'error' }), onRetry });
        fireEvent.click(screen.getByRole('button', { name: /Run it again/ }));
        await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('retry failed: server said no'));
        // and the button is usable again
        expect(screen.getByRole('button', { name: /Run it again/ }).disabled).toBe(false);
    });

    it('falls back to "unknown error" when the rejection carries no message', async () => {
        const onRetry = vi.fn().mockRejectedValue({});
        renderBar({ run: baseRun({ status: 'error' }), onRetry });
        fireEvent.click(screen.getByRole('button', { name: /Run it again/ }));
        await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('retry failed: unknown error'));
    });

    it('disables the button and ignores a second click while the action is in flight', async () => {
        let release;
        const onRetry = vi.fn(() => new Promise((res) => { release = res; }));
        renderBar({ run: baseRun({ status: 'error' }), onRetry });
        const btn = screen.getByRole('button', { name: /Run it again/ });
        fireEvent.click(btn);
        expect(btn.disabled).toBe(true);
        fireEvent.click(btn);
        expect(onRetry).toHaveBeenCalledTimes(1);
        release();
        await waitFor(() => expect(screen.getByRole('button', { name: /Run it again/ }).disabled).toBe(false));
    });
});

// ── copy link / open in editor ──────────────────────────────────────────────
describe('ExecutionBar — copy link and open in editor', () => {
    let writeText;
    beforeEach(() => {
        writeText = vi.fn();
        Object.defineProperty(window.navigator, 'clipboard', {
            value: { writeText }, configurable: true, writable: true,
        });
    });
    afterEach(() => {
        delete window.navigator.clipboard;
    });

    it('copies a deep link carrying view=runs and this run id', () => {
        renderBar({ run: baseRun({ id: 'r42' }) });
        fireEvent.click(screen.getByRole('button', { name: /Copy link/ }));
        expect(writeText).toHaveBeenCalledTimes(1);
        const url = new URL(writeText.mock.calls[0][0]);
        expect(url.searchParams.get('view')).toBe('runs');
        expect(url.searchParams.get('run')).toBe('r42');
    });

    it('gives the user no confirmation that anything was copied (wrat: silent success)', () => {
        renderBar({ run: baseRun({ id: 'r42' }) });
        fireEvent.click(screen.getByRole('button', { name: /Copy link/ }));
        expect(screen.queryByRole('alert')).toBeNull();
        expect(screen.queryByText(/[Cc]opied/)).toBeNull();
    });

    it('swallows a blocked clipboard entirely — the throw never escapes and nothing is said (wrat)', () => {
        // The empty catch means a denied clipboard is indistinguishable from a
        // successful copy: no error escapes the handler, no alert, no message.
        // Asserting only "the button is still there" pinned nothing — the bar
        // survives an escaping throw just as well.
        const escaped = [];
        const onError = (e) => { escaped.push(e.message || String(e.error)); };
        window.addEventListener('error', onError);
        Object.defineProperty(window.navigator, 'clipboard', {
            value: { writeText: () => { throw new Error('denied'); } }, configurable: true, writable: true,
        });
        renderBar({ run: baseRun({ id: 'r42' }) });
        try {
            fireEvent.click(screen.getByRole('button', { name: /Copy link/ }));
        } finally {
            window.removeEventListener('error', onError);
        }
        expect(escaped).toEqual([]);
        expect(screen.queryByRole('alert')).toBeNull();
        expect(screen.getByRole('button', { name: /Copy link/ })).toBeTruthy();
    });

    it('opens the editor for the run\'s automation', () => {
        const onOpenEditor = vi.fn();
        renderBar({ run: baseRun({ automationId: 'a9' }), onOpenEditor });
        fireEvent.click(screen.getByRole('button', { name: /Open in editor/ }));
        expect(onOpenEditor).toHaveBeenCalledWith('a9');
    });

    it('disables Open in editor when the run has no automation id', () => {
        const onOpenEditor = vi.fn();
        renderBar({ run: baseRun({ automationId: null }), onOpenEditor });
        const btn = screen.getByRole('button', { name: /Open in editor/ });
        expect(btn.disabled).toBe(true);
        fireEvent.click(btn);
        expect(onOpenEditor).not.toHaveBeenCalled();
    });

    it('hides Open in editor entirely when showOpenEditor is false', () => {
        renderBar({ showOpenEditor: false });
        expect(screen.queryByRole('button', { name: /Open in editor/ })).toBeNull();
        // Copy link survives — it is not gated on the same flag.
        expect(screen.getByRole('button', { name: /Copy link/ })).toBeTruthy();
    });
});
