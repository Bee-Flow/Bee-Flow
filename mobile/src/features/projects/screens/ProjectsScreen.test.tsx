/**
 * The Solutions overview, against canned answers: the two project tabs
 * partition every row, a card says what could not be read instead of a
 * zero, a failed overview is an error and not an empty workspace, the
 * catalogue installs a Blueprint, and New Solution creates one and opens it.
 */

import { fireEvent, screen } from '@testing-library/react-native';
import React from 'react';

import { api } from '@/core/api/client';
import { ConfirmProvider } from '@/shared/patterns';
import { renderWithProviders } from '@/shared/testing/renderWithProviders';
import { ToastProvider } from '@/shared/ui';

import { ProjectsScreen } from './ProjectsScreen';

jest.setTimeout(30_000);

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
    useRouter: () => ({ push: mockPush, replace: jest.fn(), back: jest.fn(), navigate: jest.fn(), canGoBack: () => true, dismissTo: jest.fn() }),
    Stack: { Screen: () => null },
}));
jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());
jest.mock('@/core/access', () => ({ useHasLicenseFeature: () => true }));
jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn() }));

const SUMMARY = {
    projects: [
        {
            id: 'p1',
            name: 'Intake',
            description: 'Leads in',
            permission: 'owner',
            counts: { automations: 3, apps: 1, webpages: null },
            runs: { today: 2, failed: 1 },
            completeness: { blocked: true, complete: true, findings: 2, errors: 2, warnings: 0 },
        },
        { id: 'p2', name: 'Onboarding', permission: 'viewer', installedFromBlueprintId: 'bp1', update: { installedVersion: 1, latestVersion: 2, available: true } },
    ],
    unavailable: [],
    hasMore: false,
};

function answer(summary: unknown) {
    (api.get as jest.Mock).mockImplementation((path: string) => {
        if (path === '/api/projects/summary') return summary instanceof Error ? Promise.reject(summary) : Promise.resolve(summary);
        if (path === '/api/projects/package/blueprints') return Promise.resolve({ blueprints: [{ id: 'bp1', name: 'Onboarding kit', version: 2 }] });
        return Promise.resolve(null);
    });
}

async function renderScreen(props: { initialTab?: string; create?: boolean } = {}) {
    return renderWithProviders(
        <ToastProvider>
            <ConfirmProvider>
                <ProjectsScreen {...props} />
            </ConfirmProvider>
        </ToastProvider>,
    );
}

beforeEach(() => {
    jest.clearAllMocks();
    answer(SUMMARY);
});

describe('ProjectsScreen', () => {
    it('shows the Solutions built here, with what could not be counted said out loud', async () => {
        await renderScreen();
        expect(await screen.findByText('Intake')).toBeTruthy();
        expect(screen.queryByText('Onboarding')).toBeNull();
        expect(screen.getByText('2 things to fix')).toBeTruthy();
        expect(screen.getByText('Not everything could be counted: pages, tables, agents, knowledge bases, notebooks, skills, templates')).toBeTruthy();
        expect(screen.getByText('owner')).toBeTruthy();
        await fireEvent.press(screen.getByTestId('solution-card-p1'));
        expect(mockPush).toHaveBeenCalledWith('/projects/p1');
    });

    it('puts a Solution that came from a Blueprint under Installed, with its update', async () => {
        await renderScreen({ initialTab: 'installed' });
        expect(await screen.findByText('Onboarding')).toBeTruthy();
        expect(screen.getByText('v2 available')).toBeTruthy();
        expect(screen.getByText('viewer · installed at v1')).toBeTruthy();
        expect(screen.getByText('Not checked')).toBeTruthy();
    });

    it('says a failed overview failed rather than showing an empty workspace', async () => {
        answer(new Error('Request failed'));
        await renderScreen();
        expect(await screen.findByText('Try again')).toBeTruthy();
        expect(screen.queryByText(/Nothing here yet/)).toBeNull();
    });

    it('lists the catalogue and installs from it', async () => {
        (api.post as jest.Mock).mockResolvedValueOnce({ projectId: 'p9', report: { installed: { apps: [{}] }, skipped: [], warnings: [] } });
        await renderScreen({ initialTab: 'catalogue' });
        await fireEvent.press(await screen.findByTestId('blueprint-install-bp1'));
        await fireEvent.press(await screen.findByTestId('install-confirm'));
        expect(await screen.findByText('Installed.')).toBeTruthy();
        expect(api.post).toHaveBeenCalledWith('/api/projects/package/install', { blueprintId: 'bp1', name: 'Onboarding kit' }, expect.anything());
        await fireEvent.press(screen.getByText('Open it'));
        expect(mockPush).toHaveBeenCalledWith('/projects/p9');
    });

    it('creates a Solution from the sheet and opens it', async () => {
        (api.post as jest.Mock).mockResolvedValueOnce({ id: 'p7', name: 'Returns' });
        await renderScreen({ create: true });
        await fireEvent.changeText(await screen.findByPlaceholderText('Name the Solution…'), 'Returns');
        await fireEvent.press(screen.getByText('Create'));
        await screen.findByText('Intake');
        expect(api.post).toHaveBeenCalledWith('/api/projects', expect.objectContaining({ name: 'Returns', icon: '📦' }));
        expect(mockPush).toHaveBeenCalledWith('/projects/p7');
    });
});
