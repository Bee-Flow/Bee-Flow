/**
 * The usage dashboard and a breakdown screen against canned server answers:
 * what they load with which range, the licence gate on the non-overview
 * reports, and who is turned away.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import React, { type ReactElement } from 'react';

import { api } from '@/core/api/client';
import { renderWithProviders } from '@/shared/testing/renderWithProviders';
import { ToastProvider } from '@/shared/ui';

import { OrgUsageReportScreen } from './OrgUsageReportScreen';
import { OrgUsageScreen } from './OrgUsageScreen';

jest.setTimeout(30_000);

const mockPush = jest.fn();
const mockState = { isOrgAdmin: true, licensed: true };

// The org context is the only thing this feature asks of features/org.
jest.mock('@/features/org', () => ({
    OrgLockedScreen: jest.requireActual('@/features/org/components/OrgLockedScreen').OrgLockedScreen,
    useOrgContext: () => ({ orgId: 'o1', isOrgAdmin: mockState.isOrgAdmin, isSelfHosted: false, isNcOrg: false }),
}));
jest.mock('@/core/access', () => {
    const open = { visible: true, locked: false, reason: null };
    const hidden = { visible: false, locked: false, reason: 'upgrade' };
    return { ...jest.requireActual('@/core/access'), useGate: () => (mockState.licensed ? open : hidden) };
});
jest.mock('@/core/api/client', () => {
    const verbs = ['get', 'post', 'put', 'patch', 'delete'] as const;
    return { ...jest.requireActual('@/core/api/client'), api: Object.fromEntries(verbs.map((v) => [v, jest.fn()])) };
});
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));

const ANSWERS: Record<string, unknown> = {
    '/api/usage/summary': { total_calls: '120', total_tokens: '5000', total_estimated_cost: '3.5', combined_total_cost: 4, azure_services_total_cost: 0.5, unique_users: '4' },
    '/api/usage/timeline': [{ period: '2026-09-20', estimated_cost: '1' }, { period: '2026-09-21', estimated_cost: '3' }],
    '/api/usage/azure-services/summary': { total_cost: 0.5 },
    '/api/usage/users': [{ user_id: 'u1', display_name: 'Bea', calls: 80, total_tokens: 3000, estimated_cost: 3 }],
    '/api/usage/models': [{ model: 'openai/gpt-5-2026-01-01', calls: 120, total_tokens: 5000, estimated_cost: 3.5 }],
    '/api/feedback/org': [
        { id: 'f1', rating: 'down', comment: 'Wrong answer', user_id: 'u1', created_at: '2026-09-21T10:00:00Z' },
        { id: 'f2', rating: 'up', comment: null, user_id: 'u2', created_at: '2026-09-21T11:00:00Z' },
    ],
    '/api/feedback/org/summary': { total: '2', thumbs_up: '1', thumbs_down: '1', with_comments: '1' },
    '/api/terminations/org/summary': { total: 3, by_type: { max_tokens: 1, max_iterations: 0, error: 2, aborted: 0 } },
    '/api/terminations/org/timeline': { rows: [{ period: '2026-09-21', termination_type: 'error', count: 2 }], interval: 'day' },
    '/api/terminations/org': { rows: [{ id: 9, timestamp: '2026-09-21T10:00:00Z', termination_type: 'error', agent_name: 'Scout', error_code: 'E_LIMIT' }] },
    '/api/terminations/org/by-agent': { rows: [{ agent_id: 'a1', agent_name: 'Scout', total: 3, errors: 2 }] },
};

beforeEach(() => {
    jest.clearAllMocks();
    mockState.isOrgAdmin = true;
    mockState.licensed = true;
    (api.get as jest.Mock).mockImplementation((path: string) => Promise.resolve(ANSWERS[path] ?? null));
});

const renderScreen = (ui: ReactElement) => renderWithProviders(<ToastProvider>{ui}</ToastProvider>);
const queryOf = (path: string) => (api.get as jest.Mock).mock.calls.filter(([p]) => p === path).map(([, opts]) => opts.query);

describe('OrgUsageScreen', () => {
    it('turns away someone who is not an org admin', async () => {
        mockState.isOrgAdmin = false;
        await renderScreen(<OrgUsageScreen />);
        expect(screen.getByText('Organisation reports are for administrators')).toBeTruthy();
        expect(api.get).not.toHaveBeenCalled();
    });

    it('loads the overview for 30 days and opens a full report', async () => {
        await renderScreen(<OrgUsageScreen />);
        expect(await screen.findByText('€4.00')).toBeTruthy();
        expect(await screen.findByText('Bea')).toBeTruthy();
        expect(await screen.findByText('gpt-5')).toBeTruthy();
        expect(queryOf('/api/usage/summary')[0]).toEqual(expect.objectContaining({ days: 30, startDate: expect.any(String), endDate: expect.any(String) }));
        expect(queryOf('/api/usage/timeline')[0]).toEqual(expect.objectContaining({ days: 30, interval: 'day' }));
        await fireEvent.press(screen.getByTestId('report-azure'));
        expect(mockPush).toHaveBeenCalledWith('/org/usage/azure?range=30d');

        await fireEvent.press(screen.getByTestId('range-all'));
        await waitFor(() => expect(queryOf('/api/usage/summary')).toContainEqual({ days: 3650 }));
    });

    it('offers only the overview without advanced_usage_monitoring', async () => {
        mockState.licensed = false;
        await renderScreen(<OrgUsageScreen />);
        expect(await screen.findByText('€4.00')).toBeTruthy();
        expect(screen.queryByText('Feedback')).toBeNull();
        expect(api.get).not.toHaveBeenCalledWith('/api/feedback/org', expect.anything());
    });

    it('shows feedback and terminations for the window', async () => {
        await renderScreen(<OrgUsageScreen />);
        await fireEvent.press(await screen.findByText('Feedback'));
        expect(await screen.findByText('👎 Wrong answer')).toBeTruthy();
        expect(queryOf('/api/feedback/org')[0]).toEqual({ startDate: expect.any(String), endDate: expect.any(String) });
        await fireEvent.press(screen.getByTestId('feedback-filter-positive'));
        expect(screen.queryByText('👎 Wrong answer')).toBeNull();
        expect(screen.getByText('50%')).toBeTruthy();

        await fireEvent.press(screen.getByText('Stopped early'));
        expect(await screen.findByText('Scout · E_LIMIT')).toBeTruthy();
        expect(queryOf('/api/terminations/org')[0]).toEqual(expect.objectContaining({ limit: 200 }));
        expect(queryOf('/api/terminations/org/timeline')[0]).toEqual(expect.objectContaining({ interval: 'day' }));
    });
});

describe('OrgUsageReportScreen', () => {
    it('lists every row of the report for the range it was opened with', async () => {
        await renderScreen(<OrgUsageReportScreen report="users" range="7d" />);
        expect(await screen.findByText('Bea')).toBeTruthy();
        expect(screen.getByText('Top Users')).toBeTruthy();
        expect(queryOf('/api/usage/users')[0]).toEqual(expect.objectContaining({ days: 7 }));
    });

    it('says so for a report that does not exist, and turns away a member', async () => {
        await renderScreen(<OrgUsageReportScreen report="safety" range={undefined} />);
        expect(screen.getByText('There is no such report')).toBeTruthy();
        mockState.isOrgAdmin = false;
        await renderScreen(<OrgUsageReportScreen report="users" range="7d" />);
        expect(screen.getByText('Organisation reports are for administrators')).toBeTruthy();
    });
});
