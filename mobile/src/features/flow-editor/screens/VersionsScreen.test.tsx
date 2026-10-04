/**
 * The version history over a mocked HTTP client: the saves grouped by what
 * is live, the working copy and the live one marked, a version compared (with the current automation,
 * then with another save through the server's diff route), and a restore
 * that asks first and then replaces the open draft.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import React from 'react';

import { api } from '@/core/api/client';
import { renderScreen } from '@/shared/testing/renderWithProviders';

import type { FlowDefinition } from '../model';
import { peekDraftStore } from '../state';
import { releaseDrafts, serveAutomation } from './testing';
import { VersionsScreen } from './VersionsScreen';

jest.setTimeout(30_000);

jest.mock('expo-router', () => jest.requireActual('@/shared/testing/screenMocks').focusedRouter(() => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() })));
jest.mock('@/core/auth/AuthProvider', () => ({ useAuth: jest.fn() }));
jest.mock('@/core/access/api', () => jest.requireActual('@/shared/testing/screenMocks').noAccess());
jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());

const NOW: FlowDefinition = {
    trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
    steps: [{ id: 'a', type: 'set', label: 'Tidy' }, { id: 'b', type: 'wait', label: 'Pause' }],
    edges: [{ from: 'trg', to: 'a' }, { from: 'a', to: 'b' }],
};
const V1: FlowDefinition = { ...NOW, steps: [NOW.steps[0] as FlowDefinition['steps'][number]], edges: [{ from: 'trg', to: 'a' }] };
const today = new Date();
const yesterday = new Date(today.getTime() - 86_400_000);
const summary = (id: string, version: number, savedAt: Date, flags: Record<string, unknown>) => ({
    id, automationId: 'a1', version, savedAt: savedAt.toISOString(), changeSummary: `Save ${version}`, savedByName: 'Ada Lovelace', ...flags,
});

beforeEach(() => {
    serveAutomation({ id: 'a1', title: 'Mail sorter', definition: NOW, version: 2 }, {
        '/api/automation/a1/versions': {
            versions: [summary('v2', 2, today, { isEditing: true }), summary('v1', 1, yesterday, { isLive: true, name: 'First release' })],
        },
        '/api/automation/a1/versions/v1': { version: { id: 'v1', automationId: 'a1', version: 1, definition: V1 } },
        '/api/automation/a1/versions/v2/diff/v1': {
            a: { id: 'v2', automationId: 'a1', version: 2, definition: NOW },
            b: { id: 'v1', automationId: 'a1', version: 1, definition: V1 },
            summary: { steps: { added: [], removed: ['b'], changed: [] }, edgesChanged: true, triggerChanged: false },
        },
    });
    (api.post as jest.Mock).mockImplementation(async () => ({
        automation: { id: 'a1', title: 'Mail sorter', definition: V1, version: 3 },
        restoredFromVersion: 1,
    }));
});

afterEach(releaseDrafts);

const mount = () => renderScreen(<VersionsScreen automationId="a1" />);

it('lists the saves by what is live, the working copy and the live one marked', async () => {
    await mount();
    expect(await screen.findByText('Save 2')).toBeTruthy();
    expect(screen.getByText('NOT LIVE YET')).toBeTruthy();
    expect(screen.getByText('LIVE')).toBeTruthy();
    expect(screen.getByText('editing')).toBeTruthy();
    expect(screen.getByText('live')).toBeTruthy();
    // A milestone is titled by its name, and flagged.
    expect(screen.getByText('First release')).toBeTruthy();
    expect(screen.getByLabelText('Milestone')).toBeTruthy();
    expect(screen.getAllByText(/ · Ada Lovelace$/)).toHaveLength(2);
    expect(screen.queryByTestId('restore-v2')).toBeNull();
    expect(screen.getByTestId('restore-v1')).toBeTruthy();
});

it('compares a save with the automation now, then with another save', async () => {
    await mount();
    await fireEvent.press(await screen.findByTestId('version-v1'));
    expect(await screen.findByText('1 step removed')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('diff-compare'));
    await fireEvent.press(await screen.findByRole('menuitem', { name: 'v2' }));
    expect(await screen.findByText('Removed: Pause')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('diff-raw'));
    // The first changed lines: the edge into the step that is gone.
    expect(await screen.findByText(/^− \s*"to": "b"$/)).toBeTruthy();
});

it('restores after asking, and the open draft takes the restored flow', async () => {
    await mount();
    await fireEvent.press(await screen.findByTestId('restore-v1'));
    await fireEvent.press(await screen.findByText('Restore'));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/automation/a1/versions/v1/restore', undefined, { retry: false }));
    await waitFor(() => expect(peekDraftStore('a1')?.getState().definition).toEqual(V1));
});
