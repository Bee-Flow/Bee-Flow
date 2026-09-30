/**
 * The Cowork hub, rendered against canned answers: every section it has always
 * drawn is still there, in urgency order, now as cells of one virtualised list
 * — and the stop button on a live run still reaches the cancel route.
 */

import { QueryClient } from '@tanstack/react-query';
import { act, fireEvent, screen } from '@testing-library/react-native';
import React from 'react';

import { api } from '@/core/api/client';
import { renderWithProviders } from '@/shared/testing/renderWithProviders';
import { ToastProvider } from '@/shared/ui';

import { CoworkHubScreen } from './CoworkHubScreen';

jest.setTimeout(30_000);

jest.mock('expo-router', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
    Stack: { Screen: () => null },
}));
jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());
// The live feed never speaks in this test; it just has to stay open quietly.
jest.mock('@/core/api/sse', () => ({
    streamSse: () => ({
        [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
    }),
}));
// Pulled in through the approvals feature's index; ESM that jest cannot load.
jest.mock('@/shared/markdown/Markdown', () => ({ Markdown: () => null }));

const STARTED = new Date().toISOString();

const ANSWERS: Record<string, unknown> = {
    '/api/automation/approvals': { approvals: [{ id: 'ap1', status: 'pending', prompt: 'Refund?', createdAt: STARTED }] },
    '/api/cowork': [
        { id: 's1', title: 'Weekly digest', isActive: true, repeatInterval: 'weekly', nextRunAt: '2099-01-05T09:00:00Z' },
        { id: 's2', title: 'Quiet one', isActive: false },
    ],
    '/api/automation': { automations: [{ id: 'a1', title: 'Invoices', kind: 'automation' }] },
    '/api/automation/_runs/active': { active: [{ runId: 'r9', automationId: 'a1', status: 'running', startedAt: STARTED }] },
    '/api/automation/_runs/recent': {
        runs: [{ id: 'r1', automationId: 'a1', status: 'error', error: 'The mailbox refused', startedAt: STARTED }],
    },
    '/api/ai-tasks': { tasks: [], maxTasks: 10 },
    '/api/reminders': [],
};

// Mutations too are kept forever: a finished mutation's default five-minute
// garbage-collection timer would otherwise hold the test worker open.
const client = () =>
    new QueryClient({
        defaultOptions: {
            queries: { retry: false, gcTime: Infinity },
            mutations: { retry: false, gcTime: Infinity },
        },
    });

const draw = () =>
    renderWithProviders(
        <ToastProvider>
            <CoworkHubScreen />
        </ToastProvider>,
        { queryClient: client() },
    );

beforeEach(() => {
    (api.get as jest.Mock).mockImplementation((path: string) => Promise.resolve(ANSWERS[path] ?? null));
    (api.post as jest.Mock).mockResolvedValue({ run: null });
});

describe('CoworkHubScreen', () => {
    it('draws every section of the hub', async () => {
        await draw();
        expect(await screen.findByText('Needs you')).toBeTruthy();
        for (const text of [
            '1 decision is waiting on you.',
            'Scheduled',
            'Weekly digest',
            'Quiet one',
            'Running now',
            'Coming up',
            'Everything else',
            'Recent activity',
        ]) {
            expect(screen.getByText(text)).toBeTruthy();
        }
    });

    it('stops a live run from its row', async () => {
        await draw();
        const stop = await screen.findByLabelText('Stop Invoices');
        await act(async () => {
            fireEvent.press(stop);
        });
        expect(api.post).toHaveBeenCalledWith('/api/automation/runs/r9/cancel', {}, { retry: false });
    });
});
