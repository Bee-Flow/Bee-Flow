/**
 * Saving the form while the AI builder holds the automation is a failed save —
 * the draft store refuses the edit, so reporting "saved" would throw the
 * rename or the collect switch away without a word.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import React, { type ReactNode } from 'react';

import { api } from '@/core/api/client';
import { peekDraftStore, resetDraftRegistry } from '@/features/flow-editor/state';

import { useQuestionsDraft } from './useQuestionsDraft';

jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());

const FORM = { title: 'Intake', description: '', submitLabel: 'Send', successMessage: 'Thanks', collect: true, fields: [{ name: 'full_name', type: 'text', label: 'Your name' }] };
const DEF = { trigger: { id: 'trg', type: 'trigger', kind: 'form', form: FORM }, steps: [], edges: [] };

function wrapper({ children }: { children: ReactNode }) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false, gcTime: Infinity } } });
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

beforeEach(() => {
    (api.get as jest.Mock).mockImplementation(async (path: string) =>
        path === '/api/automation/f1' ? { automation: { id: 'f1', title: 'Intake', definition: DEF, version: 1 }, summary: '' } : {},
    );
    (api.put as jest.Mock).mockImplementation(async (_path: string, body: { definition: unknown }) => ({
        automation: { id: 'f1', title: 'Intake', definition: body.definition, version: 2 },
        warnings: [],
    }));
});

afterEach(() => {
    resetDraftRegistry();
    jest.clearAllMocks();
});

it('says a rename failed while the AI builder holds the automation, and saves it once it lets go', async () => {
    const { result, unmount } = await renderHook(() => useQuestionsDraft('f1'), { wrapper });
    await waitFor(() => expect(result.current.ready).toBe(true));
    await act(async () => peekDraftStore('f1')?.getState().setLocked(true));
    expect(result.current.locked).toBe(true);

    let ok: boolean | undefined;
    await act(async () => {
        ok = await result.current.patchSaved({ title: 'Renamed' });
    });
    expect(ok).toBe(false);
    expect(String(result.current.saveError)).toContain('The AI is building this automation');
    expect(api.put).not.toHaveBeenCalled();

    await act(async () => peekDraftStore('f1')?.getState().setLocked(false));
    await act(async () => {
        ok = await result.current.patchSaved({ title: 'Renamed' });
    });
    expect(ok).toBe(true);
    expect(result.current.saveError).toBeNull();
    expect((api.put as jest.Mock).mock.calls[0]?.[1].definition.trigger.form.title).toBe('Renamed');
    await unmount();
});
