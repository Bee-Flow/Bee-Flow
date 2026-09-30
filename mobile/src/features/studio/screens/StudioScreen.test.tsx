/**
 * The Studio hub against canned answers: what needs attention (and the line
 * that says whether that is the whole picture), what was edited last, every
 * section under its heading with its count or its lock, and the New menu.
 * Every section opens its native screen.
 */

import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import React from 'react';

import { api } from '@/core/api/client';
import { useAuth } from '@/core/auth/AuthProvider';
import type { User } from '@/core/auth/types';
import { pullToRefresh, renderWithProviders } from '@/shared/testing/renderWithProviders';

import { StudioScreen } from './StudioScreen';

jest.setTimeout(30_000);

const mockRouter = { push: jest.fn(), navigate: jest.fn(), dismissTo: jest.fn(), canDismiss: () => false, back: jest.fn() };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));
jest.mock('@/core/auth/AuthProvider', () => ({ useAuth: jest.fn() }));
jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());
jest.mock('@/core/access/api', () => ({
    fetchEntitlements: jest.fn(async () => ({
        mode: 'cloud',
        tier: 'enterprise',
        superAdmin: false,
        degraded: false,
        ceiling: { core: ['automations', 'app_studio', 'skills'], beta: [], integration: [] },
        effective: { core: ['automations', 'skills'], beta: [], integration: [] },
        reasons: {},
        registry: [],
    })),
    fetchLicenseInfo: jest.fn(async () => ({ tier: 'enterprise', source: 'license_key', features: [], serverOverride: false })),
}));

const ANSWERS: Record<string, unknown> = {
    '/api/studio/counts': { counts: { automations: 4, skills: 2 }, makers: 3 },
    '/api/studio/attention': {
        rows: [
            {
                source: 'automationFailing',
                code: 'automation_failing',
                severity: 'error',
                kind: 'automation',
                targetId: 'a1',
                message: 'Invoices failed three times in a row',
                deepLink: '/app/studio/automations/a1',
            },
        ],
        total: 1,
        unavailable: ['kbEmptyInUse'],
        capped: [],
        gated: [],
        complete: false,
    },
    '/api/automation': { automations: [{ id: 'a1', title: 'Invoices', updatedAt: '2026-09-20T10:00:00Z', isActive: true }] },
    '/api/skills': [{ id: 's1', name: 'Tone of voice', updatedAt: '2026-09-21T10:00:00Z' }],
    '/api/datatables': { datatables: [] },
};

const ADA: User = { id: 'u1', displayName: 'Ada', isAdmin: false, role: 'user', provider: 'local', orgRole: 'org_admin' };

beforeEach(() => {
    jest.clearAllMocks();
    (useAuth as jest.Mock).mockReturnValue({
        stage: { kind: 'signed-in', user: ADA },
        user: ADA,
        permissions: {
            permissions: ['manage_skills', 'use_automations', 'use_datatables', 'manage_apps'],
            groups: [],
            organizations: [],
            allowedAgentTypes: [],
            canUseFeature: { automations: true, app_studio: true },
        },
    });
    (api.get as jest.Mock).mockImplementation((path: string) => Promise.resolve(ANSWERS[path] ?? null));
});

describe('StudioScreen', () => {
    it('says what needs attention, and that the answer is not the whole picture', async () => {
        await renderWithProviders(<StudioScreen />);
        expect(await screen.findByText('Invoices failed three times in a row')).toBeTruthy();
        expect(screen.getByText(/Some checks could not run, so this list may be incomplete\. Not checked: Knowledge\./)).toBeTruthy();
        expect(screen.getByText('1 thing needs attention')).toBeTruthy();
    });

    it('lists what was edited last, newest first, with its status in words', async () => {
        await renderWithProviders(<StudioScreen />);
        expect(await screen.findByText('Tone of voice')).toBeTruthy();
        expect(screen.getByText('On')).toBeTruthy();
    });

    it('groups the sections, counts them, and shows a licence-locked one locked', async () => {
        await renderWithProviders(<StudioScreen />);
        expect(await screen.findByLabelText('Automations, 4')).toBeTruthy();
        expect(screen.getByText('Build')).toBeTruthy();
        expect(screen.getByText('Not switched on for your organisation — ask an admin')).toBeTruthy();
        expect(screen.getByText('3 makers')).toBeTruthy();
    });

    it('opens every section on its native screen', async () => {
        await renderWithProviders(<StudioScreen />);
        await fireEvent.press(await screen.findByTestId('studio-section-aiTasks'));
        // A screen over the drawer is pushed; only a tab root is switched to (openRoute).
        expect(mockRouter.push).toHaveBeenCalledWith('/automations');
        await fireEvent.press(screen.getByTestId('studio-section-datatables'));
        expect(mockRouter.push).toHaveBeenCalledWith('/datatables');
    });

    it('opens the New menu with its AI row and the kinds under their headings', async () => {
        await renderWithProviders(<StudioScreen />);
        await fireEvent.press(await screen.findByTestId('studio-new'));
        expect(await screen.findByText('Describe it — AI picks the building blocks')).toBeTruthy();
        expect(screen.getByTestId('new-menu-aiTasks')).toBeTruthy();
        await fireEvent.press(screen.getByTestId('new-menu-skills'));
        expect(mockRouter.push).toHaveBeenCalledWith('/skills?new=1');
    });

    it('opens the building-block picker from the New menu\'s AI row, and builds natively from its plan', async () => {
        (api.post as jest.Mock).mockResolvedValue({
            kind: 'automation',
            name: 'Chase invoices',
            seed: 'Remind customers of unpaid invoices every Monday.',
            companions: [{ kind: 'datatable', name: 'Invoices' }],
            available: ['automation', 'datatable'],
            undecided: [],
        });
        await renderWithProviders(<StudioScreen />);
        await fireEvent.press(await screen.findByTestId('studio-new'));
        await fireEvent.press(await screen.findByTestId('new-menu-ai'));
        expect(await screen.findByText('Build with AI')).toBeTruthy();
        expect(screen.queryByTestId('new-menu-aiTasks')).toBeNull();
        await fireEvent.changeText(screen.getByTestId('studio-ai-input'), 'remind customers of unpaid invoices');
        await fireEvent.press(screen.getByTestId('studio-ai-submit'));
        expect(await screen.findByText('New Automation: Chase invoices')).toBeTruthy();
        await fireEvent.press(screen.getByTestId('studio-ai-create'));
        expect(mockRouter.push).toHaveBeenCalledWith('/automations/new');
        await waitFor(() => expect(screen.queryByText('Build with AI')).toBeNull());
    });

    it('folds findings of one kind into one line with a count, and shows the rest on the full list', async () => {
        const unverified = (id: string) => ({
            source: 'appValidation',
            code: 'binding.table_unverified',
            severity: 'warning',
            kind: 'app',
            targetId: id,
            message: `records binding references "${id}" — not verified until publish.`,
            remediation: 'Publishing checks it exists.',
            deepLink: `/app/studio/apps/${id}`,
        });
        const attention = ANSWERS['/api/studio/attention'] as { rows: unknown[] };
        (api.get as jest.Mock).mockImplementation((path: string) =>
            Promise.resolve(
                path === '/api/studio/attention'
                    ? { ...attention, rows: [...attention.rows, unverified('t1'), unverified('t2'), unverified('t3')], total: 4 }
                    : (ANSWERS[path] ?? null),
            ),
        );
        await renderWithProviders(<StudioScreen />);
        expect(await screen.findByLabelText('App has validation problems, 3')).toBeTruthy();
        expect(screen.getByText('Publishing checks it exists.')).toBeTruthy();
        expect(screen.queryByText(/not verified until publish/)).toBeNull();
        expect(screen.getByText('4 things need attention')).toBeTruthy();
        await fireEvent.press(screen.getByTestId('studio-attention-all'));
        expect(mockRouter.push).toHaveBeenCalledWith('/studio/attention');
    });

    it('opens a single finding on its own object', async () => {
        await renderWithProviders(<StudioScreen />);
        await fireEvent.press(await screen.findByTestId('studio-attention-group-automation_failing'));
        expect(mockRouter.push).toHaveBeenCalledWith('/automations/a1');
    });

    it('re-reads "Recently edited" on a pull, so a rename made elsewhere shows', async () => {
        await renderWithProviders(<StudioScreen />);
        expect(await screen.findByText('Tone of voice')).toBeTruthy();
        (api.get as jest.Mock).mockImplementation((path: string) =>
            Promise.resolve(
                path === '/api/skills'
                    ? [{ id: 's1', name: 'House style', updatedAt: '2026-09-22T10:00:00Z' }]
                    : (ANSWERS[path] ?? null),
            ),
        );
        await act(async () => pullToRefresh(screen.getByTestId('studio-hub')));
        expect(await screen.findByText('House style')).toBeTruthy();
        expect(screen.queryByText('Tone of voice')).toBeNull();
        const refreshing = () =>
            (screen.getByTestId('studio-hub').props.refreshControl as { props: { refreshing: boolean } }).props.refreshing;
        await waitFor(() => expect(refreshing()).toBe(false));
    });
});
