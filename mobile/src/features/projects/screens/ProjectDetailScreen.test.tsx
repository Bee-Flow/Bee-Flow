/**
 * One Solution, against canned answers: the object header with its tabs and
 * the publish gate, the Content bands with a store that could not be read
 * said as such, the checks with their "Show me", the wiring as a list, the
 * members with the owner's invite, and filing something out after a
 * confirmation. A listing that could not be read is an error with a retry,
 * never a spinner, and a failed write is said through describeError.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import React from 'react';

import { ApiError, api } from '@/core/api/client';
import { ConfirmProvider } from '@/shared/patterns';
import { renderWithProviders } from '@/shared/testing/renderWithProviders';
import { ToastProvider } from '@/shared/ui';

import { ProjectDetailScreen } from './ProjectDetailScreen';

jest.setTimeout(60_000);

jest.mock('expo-router', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), navigate: jest.fn(), canGoBack: () => true, dismissTo: jest.fn() }),
    Stack: { Screen: () => null },
}));
jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());
jest.mock('@/core/auth/AuthProvider', () => ({ useCurrentUser: () => ({ id: 'me' }) }));
jest.mock('@/core/access', () => ({ useHasLicenseFeature: () => true }));
jest.mock('@/core/api/shareFile', () => ({ shareText: jest.fn() }));
jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn() }));

const ANSWERS: Record<string, unknown> = {
    '/api/projects/p1': { id: 'p1', name: 'Sales', ownerId: 'me', role: 'owner', version: 3 },
    '/api/projects/p1/members': {
        ownerId: 'me',
        members: [{ id: 's1', projectId: 'p1', sharedWithType: 'user', sharedWithId: 'u2', permission: 'viewer' }],
    },
    '/api/projects/p1/resources': {
        role: 'owner',
        automations: [{ id: 'a1', title: 'Lead digest', userId: 'me', isActive: true }],
        apps: [{ id: 'app1', name: 'Intake', userId: 'me' }],
        notebooks: [],
        webpages: null,
        datatables: [],
        agents: [],
        knowledgeBases: [],
        approvals: [],
    },
    '/api/projects/p1/completeness': {
        blocked: false,
        complete: true,
        findings: [
            {
                code: 'app.unwired',
                severity: 'warning',
                message: 'Intake has a button with no automation.',
                deepLink: '/app/studio/apps/app1',
                targetRef: { kind: 'app', id: 'app1' },
            },
        ],
        unavailable: [],
    },
    '/api/projects/p1/graph': {
        nodes: [
            { id: 'app:app1', type: 'app', name: 'Intake' },
            { id: 'automation:a1', type: 'automation', name: 'Lead digest' },
        ],
        edges: [{ from: 'app:app1', to: 'automation:a1', kind: 'runs', targetId: 'a1', problem: null }],
        externals: [],
        problems: [],
        unavailable: [],
        complete: true,
    },
    '/api/projects/package/blueprints': { blueprints: [] },
    '/api/projects/p1/package/installs': { installsHere: 0, installsElsewhere: 0 },
    '/api/projects/p1/activity': { items: [{ id: 'e1', actorId: 'me', action: 'project_created' }], hasMore: false },
};

async function renderScreen(tab?: string) {
    return renderWithProviders(
        <ToastProvider>
            <ConfirmProvider>
                <ProjectDetailScreen id="p1" initialTab={tab} />
            </ConfirmProvider>
        </ToastProvider>,
    );
}

beforeEach(() => {
    jest.clearAllMocks();
    (api.get as jest.Mock).mockImplementation((path: string) =>
        path.startsWith('/auth/') ? Promise.reject(new Error('403')) : Promise.resolve(ANSWERS[path] ?? null),
    );
});

describe('ProjectDetailScreen', () => {
    it('opens on Content: the bands, the rows with their dependency and finding, and the unread store', async () => {
        await renderScreen();
        expect(await screen.findByText('Lead digest')).toBeTruthy();
        expect(screen.getByText('Sales')).toBeTruthy();
        expect(screen.getByText('PEOPLE USE')).toBeTruthy();
        expect(screen.getByText('Intake')).toBeTruthy();
        expect(screen.getByText('Worth a look')).toBeTruthy();
        expect(screen.getByTestId('section-unavailable-webpages')).toBeTruthy();
        expect(screen.getByText('Check')).toBeTruthy();
        expect(screen.getByText('Versions')).toBeTruthy();
    });

    it('lets the owner publish once the checks said nothing blocks', async () => {
        await renderScreen();
        await screen.findByText('Lead digest');
        await fireEvent.press(screen.getByTestId('solution-publish'));
        (api.post as jest.Mock).mockResolvedValueOnce({ _savedAs: 'bp1', _version: 1 });
        await fireEvent.press(await screen.findByTestId('publish-confirm'));
        expect(await screen.findByText('Published as version 1.')).toBeTruthy();
        expect(api.post).toHaveBeenCalledWith('/api/projects/p1/package/export', { save: true }, expect.anything());
    });

    it('takes an item out after saying it is not deleted', async () => {
        (api.put as jest.Mock).mockResolvedValue({ success: true });
        await renderScreen();
        await screen.findByText('Lead digest');
        await fireEvent.press(screen.getAllByLabelText('Remove from project')[0]!);
        await fireEvent.press(await screen.findByText('Remove'));
        await screen.findByText('Lead digest');
        expect(api.put).toHaveBeenCalledWith('/api/projects/p1/resources', { kind: 'app', id: 'app1', attach: false });
    });

    it('lists what the checks found, with the way to it', async () => {
        await renderScreen('control');
        expect(await screen.findByText('Intake has a button with no automation.')).toBeTruthy();
        expect(screen.getByTestId('solution-finding-open')).toBeTruthy();
        expect(screen.getByText('None of these stop you publishing — they are things to tidy when you get to them.')).toBeTruthy();
    });

    it('draws the wiring as a grouped list', async () => {
        await renderScreen('flow');
        expect(await screen.findByText('How it fits together')).toBeTruthy();
        expect(screen.getByText('RUNS')).toBeTruthy();
        expect(screen.getByText('Everything in this project is connected and owned consistently.')).toBeTruthy();
    });

    it('shows the people, and lets the owner change a role', async () => {
        (api.put as jest.Mock).mockResolvedValue({ success: true });
        await renderScreen('members');
        expect(await screen.findByText('You')).toBeTruthy();
        expect(screen.getByTestId('members-add')).toBeTruthy();
        await fireEvent.press(screen.getByTestId('member-s1'));
        await fireEvent.press(await screen.findByText('Can edit'));
        await screen.findByText('You');
        expect(api.put).toHaveBeenCalledWith('/api/projects/p1/members/s1', { role: 'editor' });
    });

    it('says a Content listing that could not be read, and reads it again on retry', async () => {
        const answer = (path: string) =>
            path.startsWith('/auth/') ? Promise.reject(new Error('403')) : Promise.resolve(ANSWERS[path] ?? null);
        (api.get as jest.Mock).mockImplementation((path: string) =>
            path === '/api/projects/p1/resources' ? Promise.reject(new ApiError('HTTP 500', { status: 500 })) : answer(path),
        );
        await renderScreen();
        expect(await screen.findByText('The server had a problem')).toBeTruthy();
        expect(screen.queryByText('Lead digest')).toBeNull();

        (api.get as jest.Mock).mockImplementation(answer);
        await fireEvent.press(screen.getByText('Try again'));
        expect(await screen.findByText('Lead digest')).toBeTruthy();
    });

    it('says a failed removal through describeError, not the raw status', async () => {
        (api.put as jest.Mock).mockRejectedValue(new ApiError('HTTP 500', { status: 500 }));
        await renderScreen();
        await screen.findByText('Lead digest');
        await fireEvent.press(screen.getAllByLabelText('Remove from project')[0]!);
        await fireEvent.press(await screen.findByText('Remove'));
        expect(await screen.findByText('This is not something you did. Try again in a moment.')).toBeTruthy();
        expect(screen.queryByText('HTTP 500')).toBeNull();
    });

    it('says a failed role change through describeError', async () => {
        (api.put as jest.Mock).mockRejectedValue(new ApiError('HTTP 500', { status: 500 }));
        await renderScreen('members');
        await screen.findByText('You');
        await fireEvent.press(screen.getByTestId('member-s1'));
        await fireEvent.press(await screen.findByText('Can edit'));
        expect(await screen.findByText('This is not something you did. Try again in a moment.')).toBeTruthy();
    });

    it('says a failed delete through describeError', async () => {
        (api.delete as jest.Mock).mockRejectedValue(new ApiError('HTTP 500', { status: 500 }));
        await renderScreen();
        await screen.findByText('Lead digest');
        await fireEvent.press(screen.getByTestId('solution-menu'));
        await fireEvent.press(await screen.findByRole('menuitem', { name: 'Delete' }));
        await fireEvent.press(await screen.findByLabelText('Delete'));
        await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/api/projects/p1'));
        expect(await screen.findByText('This is not something you did. Try again in a moment.')).toBeTruthy();
    });

    it('shows the overview counts and the recent activity', async () => {
        await renderScreen('overview');
        expect(await screen.findByText('Someone created the project')).toBeTruthy();
        expect(screen.getByLabelText('Automations: 1')).toBeTruthy();
        expect(screen.getByLabelText('Webpages: —')).toBeTruthy();
    });
});
