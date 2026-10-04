/**
 * Test-only: what every flow-editor screen test sets up around its screen —
 * a signed-in user, the automation and the step catalogue served over the mocked
 * HTTP client, a save that answers with the next version, and the draft
 * registry emptied after each test. Nothing in the app imports this.
 *
 * The module mocks stay in each test file (Jest hoists `jest.mock` only
 * there); their factories are in `@/shared/testing/screenMocks`:
 *
 *   jest.mock('expo-router', () => jest.requireActual('@/shared/testing/screenMocks').focusedRouter(() => mockRouter));
 *   jest.mock('@/core/auth/AuthProvider', () => ({ useAuth: jest.fn() }));
 *   jest.mock('@/core/access/api', () => jest.requireActual('@/shared/testing/screenMocks').noAccess());
 *   jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());
 */

import { cleanup } from '@testing-library/react-native';
import React from 'react';

import { api } from '@/core/api/client';
import { useAuth } from '@/core/auth/AuthProvider';
import { renderScreen } from '@/shared/testing/renderWithProviders';

import type { FlowDefinition } from '../model';
import { resetDraftRegistry } from '../state';
import { BuildScreen } from './BuildScreen';
import mailSorter from './mailSorter.fixture.json';

/** The automation the build screen tests open: a manual start, an AI step that sorts the mail, a notification. */
export const MAIL_SORTER = mailSorter.definition as FlowDefinition;
export const MAIL_SORTER_ROW = { ...mailSorter.row, definition: MAIL_SORTER };

/** The build screen over automation a1, inside the providers the app root mounts. */
export const renderBuild = () => renderScreen(<BuildScreen id="a1" />);

/** A signed-in session; `permissions` null means the gates fall back to the role alone. */
export function signIn(user: Record<string, unknown> = { id: 'u1' }, permissions: unknown = null): void {
    (useAuth as jest.Mock).mockReturnValue({ stage: { kind: 'signed-in', user }, user, permissions });
}

/**
 * GETs answer the automation and the catalogue, then `extra` by exact path, and
 * null for anything else; a PUT answers the saved definition at the next
 * version. Clears every mock first, so it is a test's whole `beforeEach`.
 */
export function serveAutomation(row: { id: string } & Record<string, unknown>, extra: Record<string, unknown> = {}): void {
    jest.clearAllMocks();
    signIn();
    const answers: Record<string, unknown> = {
        [`/api/automation/${row.id}`]: { automation: row, summary: '' },
        '/api/automation/catalog': { apps: [], flags: { code: true } },
        ...extra,
    };
    (api.get as jest.Mock).mockImplementation(async (path: string) => answers[path] ?? null);
    (api.put as jest.Mock).mockImplementation(async (_path: string, body: { definition: FlowDefinition }) => ({
        automation: { ...row, definition: body.definition, version: 4 },
        warnings: [],
    }));
}

/** Unmount first: releasing a store starts its grace timer, which the reset then clears. */
export async function releaseDrafts(): Promise<void> {
    await cleanup();
    resetDraftRegistry();
}
