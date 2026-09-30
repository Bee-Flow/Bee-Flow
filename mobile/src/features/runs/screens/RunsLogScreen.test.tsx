/**
 * Runs & log against canned answers: the strip and the list in "my runs",
 * the row opening its run, the status chip narrowing the query — and the
 * organisation scope refused in the server's own words, with the way back,
 * never quietly turned into "my runs".
 */

import { fireEvent, screen } from '@testing-library/react-native';
import React from 'react';

import { ApiError, api } from '@/core/api/client';
import { renderWithProviders } from '@/shared/testing/renderWithProviders';
import { ToastProvider } from '@/shared/ui';

import { RunsLogScreen } from './RunsLogScreen';

jest.setTimeout(30_000);

const mockPush = jest.fn();
/* eslint-disable @typescript-eslint/no-require-imports -- a jest.mock factory loads the shared mocks lazily */
jest.mock('expo-router', () => require('@/shared/testing/screenMocks').expoRouter(() => mockPush));
jest.mock('@/core/api/client', () => require('@/shared/testing/screenMocks').apiClient());
jest.mock('@/core/api/sse', () => require('@/shared/testing/screenMocks').silentSse());
jest.mock('@/shared/markdown/Markdown', () => ({ Markdown: () => null }));

const NOW = new Date().toISOString();
const FACETS = {
    facets: {
        status: { success: 2, error: 1 },
        triggerKind: { manual: 3 },
        automationId: { a1: 3 },
        errorClass: {},
        automations: [{ automationId: 'a1', title: 'Invoice intake', total: 3, status: { success: 2, error: 1 }, lastRunAt: NOW, lastErrorAt: NOW, lastErrorClass: 'timeout' }],
        automationsTotal: 1,
    },
};
const RUNS = {
    runs: [
        { id: 'r1', automationId: 'a1', automationTitle: 'Invoice intake', status: 'error', error: 'The mailbox refused', triggerKind: 'manual', startedAt: NOW, durationMs: 65000 },
        { id: 'r2', automationId: 'a1', automationTitle: 'Invoice intake', status: 'success', summary: 'Filed 3 invoices', triggerKind: 'schedule', startedAt: NOW },
    ],
    nextCursor: null,
};

const get = api.get as jest.Mock;

function answer(refuseOrg = false) {
    get.mockImplementation((path: string) => {
        if (path.includes('/_runs/org')) {
            return refuseOrg
                ? Promise.reject(new ApiError("Reading the organisation's runs requires the manage_automations permission.", { status: 403 }))
                : Promise.resolve(path.endsWith('facets') ? FACETS : { runs: [{ ...RUNS.runs[0], id: 'o1', mine: false }], nextCursor: null });
        }
        if (path.endsWith('/facets')) return Promise.resolve(FACETS);
        if (path.endsWith('/_runs/recent')) return Promise.resolve(RUNS);
        return Promise.resolve(null);
    });
}

beforeEach(() => {
    get.mockReset();
    mockPush.mockReset();
});

describe('RunsLogScreen', () => {
    it('draws the strip and the runs, and opens a run on its automation', async () => {
        answer();
        await renderWithProviders(
            <ToastProvider>
                <RunsLogScreen />
            </ToastProvider>,
        );
        expect(await screen.findByText('Failed — The mailbox refused')).toBeTruthy();
        expect(screen.getByText('Finished — Filed 3 invoices')).toBeTruthy();
        expect(screen.getByText('failed — it took too long and was stopped')).toBeTruthy();
        expect(screen.getByText('Started by hand · 1m 5s')).toBeTruthy();
        await fireEvent.press(screen.getByTestId('run-log-row-r1'));
        expect(mockPush).toHaveBeenCalledWith('/automations/a1/runs?runId=r1');
    });

    it('narrows the query when a status chip is chosen', async () => {
        answer();
        await renderWithProviders(
            <ToastProvider>
                <RunsLogScreen />
            </ToastProvider>,
        );
        await screen.findByText('Failed — The mailbox refused');
        await fireEvent.press(screen.getByTestId('runs-status-error'));
        await screen.findByText('Failed — The mailbox refused');
        const statuses = get.mock.calls.filter((c) => c[0].endsWith('/_runs/recent')).map((c) => c[1].query.status);
        expect(statuses).toContain('error');
    });

    it('keeps the filters and the rows on screen while a new filter loads', async () => {
        answer();
        await renderWithProviders(
            <ToastProvider>
                <RunsLogScreen />
            </ToastProvider>,
        );
        await screen.findByText('Finished — Filed 3 invoices');
        const answered = get.getMockImplementation()!;
        // The failed-only read never answers: the screen must not blank out meanwhile.
        get.mockImplementation((path: string, opts: { query?: { status?: string } }) =>
            path.endsWith('/_runs/recent') && opts?.query?.status === 'error' ? new Promise(() => {}) : answered(path, opts),
        );
        await fireEvent.press(screen.getByTestId('runs-status-error'));
        expect(screen.getByTestId('runs-status-all')).toBeTruthy();
        expect(screen.getByText('Finished — Filed 3 invoices')).toBeTruthy();
        expect(screen.queryByLabelText('Loading')).toBeNull();
    });

    it('keeps the filters when a new filter cannot be read, so another can be chosen', async () => {
        answer();
        await renderWithProviders(
            <ToastProvider>
                <RunsLogScreen />
            </ToastProvider>,
        );
        await screen.findByText('Finished — Filed 3 invoices');
        const answered = get.getMockImplementation()!;
        get.mockImplementation((path: string, opts: { query?: { status?: string } }) =>
            path.endsWith('/_runs/recent') && opts?.query?.status === 'error'
                ? Promise.reject(new ApiError('boom', { status: 500 }))
                : answered(path, opts),
        );
        await fireEvent.press(screen.getByTestId('runs-status-error'));
        expect(await screen.findByText('The server had a problem')).toBeTruthy();
        expect(screen.queryByText('Finished — Filed 3 invoices')).toBeNull();
        await fireEvent.press(screen.getByTestId('runs-status-all'));
        expect(await screen.findByText('Finished — Filed 3 invoices')).toBeTruthy();
    });

    it('counts the chips over the routine that was picked, and keeps offering the others', async () => {
        answer();
        await renderWithProviders(
            <ToastProvider>
                <RunsLogScreen />
            </ToastProvider>,
        );
        await screen.findByText('Failed — The mailbox refused');
        await fireEvent.press(screen.getByTestId('runs-automation'));
        await fireEvent.press(await screen.findByTestId('choice-a1'));
        await screen.findByText('Failed — The mailbox refused');
        const facetAsks = get.mock.calls.filter((c) => c[0].endsWith('/_runs/facets')).map((c) => c[1].query);
        expect(facetAsks).toContainEqual(expect.objectContaining({ automationId: 'a1' }));
        // The picker's choices come from the unnarrowed read: the routine is still offered.
        await fireEvent.press(screen.getByTestId('runs-automation'));
        expect(await screen.findByTestId('choice-any')).toBeTruthy();
        expect(screen.getByTestId('choice-a1')).toBeTruthy();
    });

    it('shows a colleague’s run in the org scope without offering to open it', async () => {
        answer();
        await renderWithProviders(
            <ToastProvider>
                <RunsLogScreen />
            </ToastProvider>,
        );
        await screen.findByText('Failed — The mailbox refused');
        await fireEvent.press(screen.getByText('Organisation'));
        expect(await screen.findByText(/Started by someone else/)).toBeTruthy();
        expect(screen.getByTestId('runs-org-not-live')).toBeTruthy();
        await fireEvent.press(screen.getByTestId('run-log-row-o1'));
        expect(mockPush).not.toHaveBeenCalled();
    });

    it('says why the organisation was refused and offers the way back', async () => {
        answer(true);
        await renderWithProviders(
            <ToastProvider>
                <RunsLogScreen />
            </ToastProvider>,
        );
        await screen.findByText('Failed — The mailbox refused');
        await fireEvent.press(screen.getByText('Organisation'));
        expect(await screen.findByText(/requires the manage_automations permission/)).toBeTruthy();
        expect(screen.queryByText('Failed — The mailbox refused')).toBeNull();
        await fireEvent.press(screen.getByText('Show my runs'));
        expect(await screen.findByText('Failed — The mailbox refused')).toBeTruthy();
    });
});
