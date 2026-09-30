/**
 * The drawer, rendered against canned answers: New Chat, Approvals (on the
 * web's terms), Search and Agents — Cowork, Studio, Apps, Forms and Notebooks
 * open from the Studio tab instead — chats grouped by day with their actions,
 * and a profile menu that offers Organisation only to an organisation
 * administrator. Every row closes the drawer before it goes.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import React from 'react';

import { api } from '@/core/api/client';
import { useAuth } from '@/core/auth/AuthProvider';
import type { PermissionsResponse, User } from '@/core/auth/types';
import { ConfirmProvider } from '@/shared/patterns';
import { renderWithProviders } from '@/shared/testing/renderWithProviders';
import { ToastProvider } from '@/shared/ui';

import { DrawerContent } from './DrawerContent';

jest.setTimeout(30_000);

const mockRouter = { push: jest.fn(), navigate: jest.fn(), replace: jest.fn(), back: jest.fn(), canDismiss: () => false };
jest.mock('expo-router', () => ({
    useRouter: () => mockRouter,
    usePathname: () => '/',
}));
jest.mock('@/core/auth/AuthProvider', () => ({ useAuth: jest.fn() }));
jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());
jest.mock('@/core/access/api', () => ({
    fetchEntitlements: jest.fn(async () => ({
        mode: 'cloud',
        tier: 'enterprise',
        superAdmin: false,
        degraded: false,
        ceiling: { core: ['automations', 'app_studio', 'approvals', 'projects', 'notebooks'], beta: [], integration: [] },
        effective: { core: ['automations', 'app_studio', 'approvals', 'projects', 'notebooks'], beta: [], integration: [] },
        reasons: {},
        registry: [],
    })),
    fetchLicenseInfo: jest.fn(async () => ({ tier: 'enterprise', source: 'license_key', features: [], serverOverride: false })),
}));
// Pulled in through the approvals and chat features' indexes; ESM jest cannot load.
jest.mock('@/shared/markdown/Markdown', () => ({ Markdown: () => null }));

const NOW = new Date().toISOString();
const ANSWERS: Record<string, unknown> = {
    '/api/cowork': [
        { id: 's1', title: 'Digest', isActive: true },
        { id: 's2', title: 'Quiet', isActive: true },
        { id: 's3', title: 'Off', isActive: false },
    ],
    '/api/automation/approvals': { approvals: [{ id: 'ap1', status: 'pending', createdAt: NOW }] },
    '/ai/direct/conversations': [
        { id: 'c1', title: 'Quarterly plan', pinned: true, created_at: NOW, updated_at: NOW },
        { id: 'c2', title: 'Invoice question', created_at: NOW, updated_at: NOW },
    ],
    '/api/studio/counts': { counts: { automations: 4, datatables: 0 }, makers: 2 },
    '/api/studio-apps': {
        apps: [{ id: 'ap', name: 'Expenses', icon: '📊', description: 'Claim what you spent', isPublished: true, accentColor: '#ff0000' }],
    },
    '/api/automation/forms': {
        forms: [
            { id: 'f1', title: 'Intake', description: 'New clients', live: true, createdAt: NOW },
            { id: 'f2', title: 'Paused one', live: false, createdAt: NOW },
        ],
    },
    '/api/projects': [{ id: 'p1', name: 'Launch', icon: '🚀', color: '#ff0000', permission: 'owner' }],
    '/agents': [{ id: 'a1', name: 'Scout', owner_id: 'u1' }],
    '/agents/published': [],
    '/agents/favorites': ['a1'],
};

const ADA: User = { id: 'u1', displayName: 'Ada Lovelace', isAdmin: false, role: 'user', provider: 'local' };

function signIn(user: Partial<User>, permissions: string[]) {
    const full = { ...ADA, ...user };
    const perms: PermissionsResponse = {
        permissions,
        groups: [],
        organizations: [],
        allowedAgentTypes: [],
        canUseFeature: { automations: true, app_studio: true },
    };
    (useAuth as jest.Mock).mockReturnValue({
        stage: { kind: 'signed-in', user: full },
        user: full,
        permissions: perms,
        signOut: jest.fn(),
        busy: false,
    });
}

const closeDrawer = jest.fn();

const draw = (path = '/') =>
    renderWithProviders(
        <ToastProvider>
            <ConfirmProvider>
                <DrawerContent navigation={{ closeDrawer }} path={path} />
            </ConfirmProvider>
        </ToastProvider>,
    );

beforeEach(() => {
    jest.clearAllMocks();
    (api.get as jest.Mock).mockImplementation((path: string) => Promise.resolve(ANSWERS[path] ?? null));
    (api.delete as jest.Mock).mockResolvedValue(undefined);
});

describe('DrawerContent', () => {
    it('draws New Chat, Approvals with its badge, Search and Agents', async () => {
        signIn({ orgRole: 'org_admin' }, ['manage_agents', 'use_approvals', 'use_apps', 'use_forms', 'use_notebooks']);
        await draw();
        expect(await screen.findByLabelText('Approvals, 1')).toBeTruthy();
        for (const label of ['New Chat', 'Search', 'Agents']) expect(screen.getByText(label)).toBeTruthy();
    });

    it('leaves Cowork, Studio, Apps, Forms and Notebooks to the Studio tab', async () => {
        signIn({ orgRole: 'org_admin' }, ['manage_agents', 'use_automations', 'use_apps', 'use_forms', 'use_notebooks']);
        await draw();
        await screen.findByText('Quarterly plan');
        for (const key of ['cowork', 'studio', 'apps', 'forms', 'notebooks']) {
            expect(screen.queryByTestId(`drawer-${key}`)).toBeNull();
        }
        expect(screen.queryByText('Cowork')).toBeNull();
        expect(screen.queryByText('Studio')).toBeNull();
    });

    it('keeps Approvals from someone who takes no part in them', async () => {
        signIn({ orgRole: 'member' }, ['use_notebooks']);
        await draw();
        await screen.findByText('Quarterly plan');
        expect(screen.queryByText('Approvals')).toBeNull();
    });

    it('groups the chats by day and opens one over the drawer', async () => {
        signIn({}, []);
        await draw();
        expect(await screen.findByText('Pinned')).toBeTruthy();
        expect(screen.getByText('Today')).toBeTruthy();
        await fireEvent.press(screen.getByTestId('drawer-chat-c2'));
        expect(closeDrawer).toHaveBeenCalled();
        expect(mockRouter.push).toHaveBeenCalledWith('/chat/c2');
    });

    it('offers rename, unpin and delete on a chat', async () => {
        signIn({}, []);
        await draw();
        await fireEvent(await screen.findByTestId('drawer-chat-c1'), 'longPress');
        expect(await screen.findByText('Rename')).toBeTruthy();
        expect(screen.getByText('Unpin')).toBeTruthy();
        expect(screen.getByText('Delete')).toBeTruthy();
    });

    it('starts a new chat from a favourite agent, as the web does', async () => {
        signIn({}, []);
        await draw();
        await fireEvent.press(await screen.findByTestId('drawer-agent-a1'));
        expect(mockRouter.push).toHaveBeenCalledWith('/agents/a1?c=new');
    });

    it('draws each project’s own icon on its colour tile', async () => {
        signIn({}, []);
        await draw();
        // The emoji is the tile's picture, hidden from a screen reader (the row says the name).
        expect(await screen.findByText('🚀', { includeHiddenElements: true })).toBeTruthy();
        expect(screen.getByText('Launch')).toBeTruthy();
    });

    it('deletes a chat from the drawer without leaving the tab it sits over', async () => {
        signIn({}, []);
        await draw();
        await fireEvent(await screen.findByTestId('drawer-chat-c2'), 'longPress');
        await fireEvent.press(await screen.findByText('Delete'));
        const confirm = await screen.findAllByText('Delete');
        await fireEvent.press(confirm[confirm.length - 1] as never);
        await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/ai/direct/conversations/c2'));
        expect(mockRouter.replace).not.toHaveBeenCalled();
    });

    it('keeps Approvals for an org admin whose own inbox is empty but whose organisation has some', async () => {
        (api.get as jest.Mock).mockImplementation((path: string, options?: { query?: { scope?: string } }) => {
            if (path === '/api/automation/approvals') {
                const org = options?.query?.scope === 'org';
                return Promise.resolve({ approvals: org ? [{ id: 'o1', status: 'approved', createdAt: NOW }] : [] });
            }
            return Promise.resolve(ANSWERS[path] ?? null);
        });
        signIn({ orgRole: 'org_admin' }, ['use_approvals']);
        await draw();
        await fireEvent.press(await screen.findByTestId('drawer-approvals'));
        expect(mockRouter.push).toHaveBeenCalledWith('/approvals?scope=org');
    });

    it('offers Organisation in the profile menu to an organisation administrator only', async () => {
        signIn({ orgRole: 'org_admin' }, ['org_admin']);
        const first = await draw();
        await fireEvent.press(await screen.findByTestId('drawer-profile'));
        expect(await screen.findByText('Organisation')).toBeTruthy();
        expect(screen.getByText('Settings')).toBeTruthy();
        expect(screen.getByText('Sign Out')).toBeTruthy();
        expect(screen.queryByText(/Admin/)).toBeNull();
        first.queryClient.clear();
    });

    it('keeps Organisation from a member', async () => {
        signIn({ orgRole: 'member' }, ['manage_users']);
        await draw();
        await fireEvent.press(await screen.findByTestId('drawer-profile'));
        await waitFor(() => expect(screen.getByText('Settings')).toBeTruthy());
        expect(screen.queryByText('Organisation')).toBeNull();
    });
});

describe('DrawerContent on the Studio tab', () => {
    const BUILDER = ['use_automations', 'use_datatables', 'use_approvals', 'use_apps', 'use_forms', 'use_notebooks'];

    it('replaces the chat sidebar with Studio’s menu, keeping the bell’s header and the profile footer', async () => {
        signIn({ orgRole: 'org_admin' }, BUILDER);
        await draw('/studio');
        expect(await screen.findByTestId('drawer-studio-menu')).toBeTruthy();
        expect(screen.getByText('Studio')).toBeTruthy();
        expect(screen.getByTestId('drawer-back-to-chat')).toBeTruthy();
        expect(screen.getByTestId('drawer-profile')).toBeTruthy();
        expect(screen.getByTestId('drawer-logo')).toBeTruthy();
        for (const key of ['new-chat', 'search', 'agents']) expect(screen.queryByTestId(`drawer-${key}`)).toBeNull();
        expect(screen.queryByText('Quarterly plan')).toBeNull();
    });

    it('lists the Workspace group and, for a builder, the sections with their counts, and Approvals', async () => {
        signIn({ orgRole: 'org_admin' }, BUILDER);
        await draw('/studio');
        expect(await screen.findByLabelText('Cowork, 2')).toBeTruthy();
        expect(await screen.findByLabelText('Automations, 4')).toBeTruthy();
        expect(screen.getByText('Workspace')).toBeTruthy();
        expect(screen.getByText('Build')).toBeTruthy();
        expect(screen.getByTestId('drawer-studio-notebooks')).toBeTruthy();
        expect(screen.getByTestId('drawer-studio-search')).toBeTruthy();
        expect(await screen.findByLabelText('Approvals, 1')).toBeTruthy();
    });

    it('gives someone who does not build the Workspace group only', async () => {
        signIn({ orgRole: 'member' }, ['use_notebooks']);
        await draw('/studio');
        expect(await screen.findByLabelText('Cowork, 2')).toBeTruthy();
        expect(screen.getByTestId('drawer-studio-notebooks')).toBeTruthy();
        expect(screen.queryByText('Build')).toBeNull();
        expect(screen.queryByTestId('drawer-studio-aiTasks')).toBeNull();
        expect(screen.queryByTestId('drawer-studio-search')).toBeNull();
    });

    it('opens a destination over the drawer, and goes back to Chat', async () => {
        signIn({ orgRole: 'org_admin' }, BUILDER);
        await draw('/studio');
        await fireEvent.press(await screen.findByTestId('drawer-studio-aiTasks'));
        expect(closeDrawer).toHaveBeenCalled();
        expect(mockRouter.push).toHaveBeenCalledWith('/automations');
        await fireEvent.press(screen.getByTestId('drawer-studio-cowork'));
        expect(mockRouter.push).toHaveBeenCalledWith('/cowork');
        await fireEvent.press(screen.getByTestId('drawer-back-to-chat'));
        expect(mockRouter.navigate).toHaveBeenCalledWith('/');
    });

    it('keeps the chat sidebar on Meeting Notes', async () => {
        signIn({}, []);
        await draw('/record');
        expect(await screen.findByText('Quarterly plan')).toBeTruthy();
        expect(screen.queryByTestId('drawer-studio-menu')).toBeNull();
    });
});
