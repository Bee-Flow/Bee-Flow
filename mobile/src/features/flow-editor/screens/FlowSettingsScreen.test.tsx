/**
 * A routine's settings over a mocked HTTP client and device: the name goes
 * through its own call, a notification switch is a draft edit, webhook URLs
 * are listed and made for the webhook trigger, the routine exports as a
 * shared file and imports from a picked one, and deleting asks what uses it
 * first and then leaves for the list.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';
import React from 'react';

import { api } from '@/core/api/client';
import { renderScreen } from '@/shared/testing/renderWithProviders';

import type { FlowDefinition } from '../model';
import { peekDraftStore } from '../state';
import { FlowSettingsScreen } from './FlowSettingsScreen';
import { releaseDrafts, serveRoutine, signIn } from './testing';

jest.setTimeout(30_000);

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), dismiss: jest.fn() };
// The root stack as the settings screen sees it: opened from the Automations list.
const mockStack = [
    { name: 'automations/index' },
    { name: 'automations/[id]', params: { id: 'a1' } },
    { name: 'automations/[id]/settings', params: { id: 'a1' } },
];
jest.mock('expo-router', () => {
    const routed = jest.requireActual('@/shared/testing/screenMocks').focusedRouter(() => mockRouter);
    return { ...routed, useNavigation: () => ({ ...routed.useNavigation(), getState: () => ({ routes: mockStack }) }) };
});
jest.mock('@/core/auth/AuthProvider', () => ({ useAuth: jest.fn() }));
jest.mock('@/core/access/api', () => jest.requireActual('@/shared/testing/screenMocks').noAccess());
jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));
jest.mock('expo-sharing', () => ({ isAvailableAsync: jest.fn(async () => true), shareAsync: jest.fn(async () => undefined) }));
jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn() }));
const mockFileText = jest.fn();
jest.mock('expo-file-system', () => {
    class Directory {
        exists = true;
        create() {}
    }
    class File {
        uri: string;
        exists = false;
        constructor(...parts: unknown[]) {
            this.uri = parts.map((p) => (typeof p === 'string' ? p : 'cache')).join('/');
        }
        create() {}
        delete() {}
        write() {}
        text() {
            return mockFileText(this.uri);
        }
    }
    return { Directory, File, Paths: { cache: 'cache' } };
});

const DEF: FlowDefinition = {
    trigger: { id: 'trg', type: 'trigger', kind: 'webhook' },
    steps: [{ id: 'a', type: 'set', label: 'Tidy' }],
    edges: [{ from: 'trg', to: 'a' }],
};
const row = { id: 'a1', userId: 'u1', title: 'Mail sorter', description: 'Sorts mail', definition: DEF, version: 2, folderId: null };

beforeEach(() => {
    serveRoutine(row, {
        '/api/automation/a1/webhooks': { webhooks: [{ id: 'wh1', automationId: 'a1', url: 'https://x.test/hooks/wh1' }] },
        '/api/automation/folders': { folders: [{ id: 'f1', name: 'Finance' }] },
        '/api/automation/a1/usage': { usage: [], complete: true },
        '/api/automation/a1/principals': { users: [{ id: 'u1', name: 'Ada Lovelace' }], groups: [{ id: 'g1', name: 'Sales', memberCount: 3 }] },
        '/api/automation/a1/export': { envelope: { format: 'beeflow.automation', automation: { title: 'Mail sorter' } }, warnings: ['Removed a pinned sample.'] },
    });
    signIn({ id: 'u1', displayName: 'Ada Lovelace' });
    (api.put as jest.Mock).mockImplementation(async (_path: string, body: Record<string, unknown>) => ({ automation: { ...row, ...body, version: 3 }, warnings: [] }));
    (api.post as jest.Mock).mockImplementation(async (path: string) => {
        if (path === '/api/automation/a1/webhook') return { webhook: { id: 'wh2', automationId: 'a1', secret: 'whsec_abcdefgh1234' }, url: 'https://x.test/hooks/wh2' };
        if (path === '/api/automation/import') return { automation: { ...row, id: 'a2' }, warnings: [{ code: 'x', message: 'Connect Gmail', severity: 'warning' }] };
        return null;
    });
    (api.delete as jest.Mock).mockResolvedValue({ success: true });
});

afterEach(releaseDrafts);

const mount = () => renderScreen(<FlowSettingsScreen automationId="a1" />);

it('renames through its own call, never sending the definition', async () => {
    await mount();
    await fireEvent.changeText(await screen.findByTestId('settings-title'), 'Mail triage');
    await fireEvent.press(screen.getByTestId('settings-save'));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/api/automation/a1', { title: 'Mail triage', description: 'Sorts mail' }));
});

it('turns a notification on as a draft edit', async () => {
    await mount();
    await screen.findByTestId('notify-onSuccess');
    // Ticking a channel of an event that is off switches the event on (the web's overview).
    await fireEvent.press(screen.getByTestId('notify-onSuccess-bell'));
    const settings = peekDraftStore('a1')?.getState().definition?.notificationSettings as Record<string, { enabled: boolean; channels: string[] }>;
    expect(settings.onSuccess).toMatchObject({ enabled: true, channels: ['bell'] });
    expect(settings.onError).toMatchObject({ enabled: true, channels: ['bell', 'email'] });
    expect(peekDraftStore('a1')?.getState().canUndo).toBe(true);
});

it('names who gets an event and adds a group from the routine\'s people', async () => {
    await mount();
    // The owner, by name from the routine's people (GET /:id/principals): errors
    // go to the owner, approvals to the approver, and success is off.
    expect(await screen.findByText('Ada Lovelace (owner)')).toBeTruthy();
    expect(screen.getByText('The approver')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('notify-details'));
    await fireEvent.press(await screen.findByText('+ add'));
    await fireEvent.press(await screen.findByText('Sales'));
    const settings = peekDraftStore('a1')?.getState().definition?.notificationSettings as Record<string, { recipients: unknown[] }>;
    expect(settings.onError?.recipients).toEqual([{ type: 'owner' }, { type: 'group', id: 'g1' }]);
    expect(await screen.findByText('Ada Lovelace (owner), Group Sales')).toBeTruthy();
});

it('lists the webhook URLs and makes one for the webhook trigger', async () => {
    await mount();
    expect(await screen.findByText('https://x.test/hooks/wh1')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('settings-new-webhook'));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/automation/a1/webhook', {}, { retry: false }));
});

it('shares the export as a file and opens an imported routine', async () => {
    await mount();
    await fireEvent.press(await screen.findByTestId('settings-export'));
    await waitFor(() => expect(Sharing.shareAsync).toHaveBeenCalledWith(expect.stringMatching(/Mail sorter\.beeflow\.json$/), expect.objectContaining({ mimeType: 'application/json' })));
    expect(await screen.findByText('Removed a pinned sample.')).toBeTruthy();

    (DocumentPicker.getDocumentAsync as jest.Mock).mockResolvedValue({ canceled: false, assets: [{ uri: 'file:///picked.json', name: 'picked.json' }] });
    mockFileText.mockResolvedValue('{"format":"beeflow.automation","automation":{"title":"Copy"}}');
    await fireEvent.press(screen.getByTestId('settings-import'));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/automation/import', { format: 'beeflow.automation', automation: { title: 'Copy' } }, { retry: false }));
    await waitFor(() => expect(mockRouter.push).toHaveBeenCalledWith({ pathname: '/automations/[id]/build', params: { id: 'a2' } }));
});

it('refuses a picked file that is not a routine, without asking the server', async () => {
    await mount();
    (DocumentPicker.getDocumentAsync as jest.Mock).mockResolvedValue({ canceled: false, assets: [{ uri: 'file:///notes.txt', name: 'notes.txt' }] });
    mockFileText.mockResolvedValue('just some notes');
    await fireEvent.press(await screen.findByTestId('settings-import'));
    expect(await screen.findByText('That file is not an exported routine.')).toBeTruthy();
    expect(api.post).not.toHaveBeenCalled();
});

it('deletes after checking what uses the routine, then leaves every screen of it', async () => {
    await mount();
    await fireEvent.press(await screen.findByTestId('settings-delete'));
    await fireEvent.press(await screen.findByText('Delete for good'));
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/api/automation/a1', { retry: false }));
    expect(api.get).toHaveBeenCalledWith('/api/automation/a1/usage', expect.anything());
    // Back to the list it was opened from, with no screen of the deleted routine left behind.
    await waitFor(() => expect(mockRouter.dismiss).toHaveBeenCalledWith(2));
    expect(mockRouter.replace).not.toHaveBeenCalled();
});

it('shows the AI Act declaration to someone who may see compliance, and leads to the ladder', async () => {
    signIn({ id: 'u1', displayName: 'Ada' }, { permissions: ['admin_compliance'], groups: [], organizations: [], allowedAgentTypes: [] });
    const base = (api.get as jest.Mock).getMockImplementation() as (path: string) => Promise<unknown>;
    (api.get as jest.Mock).mockImplementation(async (path: string) =>
        path === '/api/compliance/ai-act/assessments/automation/a1'
            ? { outcome: 'minimal', attested_at: '2026-09-01T10:00:00Z', expires_at: '2099-01-01T00:00:00Z', current: true, signals: { contains_ai: false, customer_facing: false } }
            : base(path),
    );
    await mount();
    expect(await screen.findByText('Minimal risk')).toBeTruthy();
    expect(screen.getByText('no AI steps · internal only')).toBeTruthy();
    expect(screen.getByTestId('flow-compliance-assess')).toBeTruthy();
});

it('keeps the Compliance block away from someone who may not see compliance', async () => {
    await mount();
    await screen.findByTestId('settings-export');
    expect(screen.queryByTestId('flow-compliance-assess')).toBeNull();
    expect(api.get).not.toHaveBeenCalledWith('/api/compliance/ai-act/assessments/automation/a1');
});

it('switches this device’s auto-map preference', async () => {
    await mount();
    const toggle = await screen.findByTestId('flow-auto-map');
    expect(toggle).toBeTruthy();
    await fireEvent(screen.getByLabelText('Auto-map step inputs when connecting'), 'valueChange', false);
    const { autoMapOnConnect, resetAutoMapPreference } = jest.requireActual('../state') as typeof import('../state');
    expect(autoMapOnConnect()).toBe(false);
    resetAutoMapPreference();
});
