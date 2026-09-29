import { render, screen, cleanup, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Studio → Runs & log — the screen, and specifically the scope switch, which
 * is the permission-bearing control of this stage.
 *
 * The executions surface below it is stubbed: it has its own tests, and what
 * matters here is exactly WHICH runScope it is handed.
 */
const apiMock = vi.hoisted(() => ({}));
const panelProps = vi.hoisted(() => ({ current: [] }));

vi.mock('../../../../hooks/useAutomationApi', () => ({ default: () => apiMock }));
vi.mock('../../../../hooks/useTranslation', () => ({
    useTranslation: () => ({ t: (key, fallback, params) => interpolate(fallback ?? key, params), locale: 'en' }),
}));
const interpolate = (s, params) => String(s).replace(/\{(\w+)\}/g, (m, k) => (params && k in params ? String(params[k]) : m));
vi.mock('../Executions/ExecutionsPanel', () => ({
    default: (props) => { panelProps.current.push(props); return <div data-testid="executions-panel" data-run-scope={props.runScope} />; },
}));

import RunsStudio from './RunsStudio';

const facetsBody = (automations = []) => ({ facets: { status: {}, automations } });

beforeEach(() => {
    cleanup();
    panelProps.current = [];
    apiMock.getRunFacets = vi.fn().mockResolvedValue(facetsBody([
        { automationId: 'a1', title: 'Weekly digest', total: 3, status: { success: 3 }, lastRunAt: new Date().toISOString() },
    ]));
    apiMock.getOrgRunFacets = vi.fn().mockResolvedValue(facetsBody([
        { automationId: 'a2', title: 'Credit check', total: 1, status: { error: 1 }, lastErrorClass: 'rate_limit', lastErrorAt: new Date().toISOString() },
    ]));
});

const lastPanel = () => panelProps.current.at(-1);

describe('RunsStudio — the scope switch', () => {
    it('opens on MY RUNS and reads the user-scoped facets', async () => {
        render(<RunsStudio />);
        await waitFor(() => expect(apiMock.getRunFacets).toHaveBeenCalled());
        expect(apiMock.getOrgRunFacets).not.toHaveBeenCalled();
        expect(screen.getByTestId('runs-scope-mine').getAttribute('aria-pressed')).toBe('true');
        expect(lastPanel().runScope).toBe('mine');
        // No "not live" note in the personal scope: it IS live.
        expect(screen.queryByTestId('runs-org-not-live')).toBeNull();
    });

    it('asks the strip for a FIXED 24-hour window, whatever the table below is filtered to', async () => {
        render(<RunsStudio />);
        await waitFor(() => expect(apiMock.getRunFacets).toHaveBeenCalled());
        expect(apiMock.getRunFacets).toHaveBeenCalledWith(expect.objectContaining({ range: 24 }));
    });

    it('switching to Organisation reaches the org endpoint and hands the panel "org"', async () => {
        render(<RunsStudio />);
        await waitFor(() => expect(apiMock.getRunFacets).toHaveBeenCalled());
        await userEvent.click(screen.getByTestId('runs-scope-org'));
        await waitFor(() => expect(apiMock.getOrgRunFacets).toHaveBeenCalled());
        expect(lastPanel().runScope).toBe('org');
        expect(screen.getByTestId('runs-scope-org').getAttribute('aria-pressed')).toBe('true');
    });

    it('says out loud that the organisation list is not live and not openable by anyone', async () => {
        render(<RunsStudio />);
        await userEvent.click(screen.getByTestId('runs-scope-org'));
        await waitFor(() => expect(screen.getByTestId('runs-org-not-live')).toBeTruthy());
        expect(screen.getByTestId('runs-org-not-live').textContent).toMatch(/do not update/i);
    });

    it('a refused org scope shows the SERVER\'s reason and does NOT fall back to my runs', async () => {
        // The failure this whole stage is written against: answering a
        // narrower question than the one that was asked, and saying nothing.
        apiMock.getOrgRunFacets = vi.fn().mockRejectedValue(
            new Error("Reading the organisation's runs requires the manage_automations permission."),
        );
        render(<RunsStudio />);
        await userEvent.click(screen.getByTestId('runs-scope-org'));
        await waitFor(() => expect(screen.getByTestId('runs-scope-error')).toBeTruthy());
        expect(screen.getByTestId('runs-scope-error').textContent).toMatch(/manage_automations/);
        // Still on 'org' — the switch stays where the person put it.
        expect(screen.getByTestId('runs-scope-org').getAttribute('aria-pressed')).toBe('true');
        expect(lastPanel().runScope).toBe('org');
        // And the strip does not draw the previous scope's numbers under the
        // new heading: an unreadable strip, not a stale one.
        expect(screen.getByTestId('now-running-unknown')).toBeTruthy();
        expect(screen.queryByTestId('now-running-list')).toBeNull();
    });

    it('offers an explicit way back to my runs after a refusal', async () => {
        apiMock.getOrgRunFacets = vi.fn().mockRejectedValue(new Error('403'));
        render(<RunsStudio />);
        await userEvent.click(screen.getByTestId('runs-scope-org'));
        await waitFor(() => expect(screen.getByTestId('runs-scope-back')).toBeTruthy());
        await userEvent.click(screen.getByTestId('runs-scope-back'));
        await waitFor(() => expect(lastPanel().runScope).toBe('mine'));
        // The error clears when the new scope's read starts, one render after
        // the switch itself.
        await waitFor(() => expect(screen.queryByTestId('runs-scope-error')).toBeNull());
    });

    it('a refusal that arrives after switching back does not land under my runs', async () => {
        let refuse;
        apiMock.getOrgRunFacets = vi.fn(() => new Promise((_, reject) => { refuse = reject; }));
        render(<RunsStudio />);
        await userEvent.click(screen.getByTestId('runs-scope-org'));
        await waitFor(() => expect(apiMock.getOrgRunFacets).toHaveBeenCalled());
        await userEvent.click(screen.getByTestId('runs-scope-mine'));
        await waitFor(() => expect(lastPanel().runScope).toBe('mine'));
        await act(async () => { refuse(new Error('403')); });
        expect(screen.queryByTestId('runs-scope-error')).toBeNull();
    });

    it('a body this build cannot read is unreadable, not empty', async () => {
        apiMock.getRunFacets = vi.fn().mockResolvedValue({ ok: true });
        render(<RunsStudio />);
        await waitFor(() => expect(screen.getByTestId('now-running-unknown')).toBeTruthy());
        expect(screen.queryByTestId('now-running-empty')).toBeNull();
    });

    it('the strip renders the scope it actually read', async () => {
        render(<RunsStudio />);
        await waitFor(() => expect(screen.getByText('Weekly digest')).toBeTruthy());
        await userEvent.click(screen.getByTestId('runs-scope-org'));
        await waitFor(() => expect(screen.getByText('Credit check')).toBeTruthy());
        expect(screen.queryByText('Weekly digest')).toBeNull();
    });
});

describe('RunsStudio — wiring to the rest of the shell', () => {
    it('mounts the global executions surface and passes deep-link ids through', async () => {
        render(<RunsStudio initialRunId="r9" initialRunStepId="s3" onEditingChange={vi.fn()} />);
        await waitFor(() => expect(screen.getByTestId('executions-panel')).toBeTruthy());
        const p = lastPanel();
        expect(p.scope).toBe('global');
        expect(p.active).toBe(true);
        expect(p.initialRunId).toBe('r9');
        expect(p.initialStepId).toBe('s3');
    });

    it('opens a routine in the builder, never a run id', async () => {
        const onNavigate = vi.fn();
        render(<RunsStudio onNavigate={onNavigate} />);
        await waitFor(() => expect(screen.getByTestId('now-running-open')).toBeTruthy());
        await userEvent.click(screen.getByTestId('now-running-open'));
        expect(onNavigate).toHaveBeenCalledWith('studio/automations/a1');
        // The panel's own editor jump goes to the same place.
        lastPanel().onOpenEditor('a7');
        expect(onNavigate).toHaveBeenLastCalledWith('studio/automations/a7');
    });

    it('does not offer navigation it cannot perform', async () => {
        render(<RunsStudio />);
        await waitFor(() => expect(screen.getByTestId('now-running-list')).toBeTruthy());
        expect(screen.queryByTestId('now-running-open')).toBeNull();
    });

    it('…and stops offering it in the ORGANISATION scope, where the server refuses', async () => {
        // The strip made every routine name a button. In the org scope those are
        // colleagues' routines and GET /api/automation/:id answers 403, so the
        // button led to a refusal — a control that looks available and is not.
        // The facets carry no ownership, so per row is not decidable here; the
        // scope is the only honest line this screen has, and it is the same one
        // the scope notice already states.
        const onNavigate = vi.fn();
        render(<RunsStudio onNavigate={onNavigate} />);
        await waitFor(() => expect(screen.getByTestId('now-running-open')).toBeTruthy());

        await userEvent.click(screen.getByText('Organisation'));
        await waitFor(() => expect(lastPanel().runScope).toBe('org'));
        await waitFor(() => expect(screen.queryByTestId('now-running-open')).toBeNull());

        // Back to my own runs and the button returns — it was withheld for the
        // scope, not removed from the screen.
        await userEvent.click(screen.getByText('My runs'));
        await waitFor(() => expect(screen.getByTestId('now-running-open')).toBeTruthy());
    });
});
