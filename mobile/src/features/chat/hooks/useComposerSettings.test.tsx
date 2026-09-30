/**
 * A chat's knowledge bases: restored from the server once per conversation,
 * saved as they change, and put back — with the reason — when the server
 * refuses.
 */

import { QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import React, { type ReactNode } from 'react';

import { ApiError } from '@/core/api/client';
import { testQueryClient } from '@/shared/testing/renderWithProviders';

import { useComposerSettings, useConversationGrounding } from './useComposerSettings';

const mockSave = jest.fn();
jest.mock('../api/endpoints', () => ({
    ...jest.requireActual('../api/endpoints'),
    saveConversationKnowledgeBases: (...args: unknown[]) => mockSave(...args),
    fetchTiers: jest.fn(() => new Promise(() => undefined)),
}));
jest.mock('@/features/knowledge', () => ({ useKnowledgeBases: () => ({ data: [] }) }));

const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={testQueryClient()}>{children}</QueryClientProvider>
);

function useSubject({ id, ids }: { id: string | null; ids?: string[] }) {
    const composer = useComposerSettings();
    useConversationGrounding(composer.ground, id, ids);
    return composer;
}

beforeEach(() => mockSave.mockReset());

it("takes the server's selection once, and saves a change as it is made", async () => {
    mockSave.mockResolvedValue(['kb1', 'kb2']);
    const hook = await renderHook(useSubject, { wrapper, initialProps: { id: 'c1', ids: ['kb1'] } });
    expect(hook.result.current.settings.knowledgeBaseIds).toEqual(['kb1']);

    await act(async () => hook.result.current.onSettingsChange({ ...hook.result.current.settings, knowledgeBaseIds: ['kb1', 'kb2'] }));
    await waitFor(() => expect(mockSave).toHaveBeenCalledWith('c1', ['kb1', 'kb2']));
    expect(hook.result.current.settings.knowledgeBaseIds).toEqual(['kb1', 'kb2']);

    // A refetch of the same conversation does not overwrite what the person chose.
    await hook.rerender({ id: 'c1', ids: ['kb1'] });
    expect(hook.result.current.settings.knowledgeBaseIds).toEqual(['kb1', 'kb2']);
});

it('puts the selection back and says why when the server refuses', async () => {
    mockSave.mockRejectedValue(Object.assign(new ApiError('Nope'), { status: 400, body: { invalid: ['kb9'] } }));
    const hook = await renderHook(useSubject, { wrapper, initialProps: { id: 'c1', ids: ['kb1'] } });
    await act(async () => hook.result.current.onSettingsChange({ ...hook.result.current.settings, knowledgeBaseIds: ['kb1', 'kb9'] }));
    await waitFor(() => expect(hook.result.current.kbRefusal).toBe('invalid'));
    expect(hook.result.current.settings.knowledgeBaseIds).toEqual(['kb1']);
});

it('holds a new chat’s choice locally: nothing to save to yet', async () => {
    const hook = await renderHook(useSubject, { wrapper, initialProps: { id: null } });
    await act(async () => hook.result.current.onSettingsChange({ ...hook.result.current.settings, knowledgeBaseIds: ['kb1'] }));
    expect(hook.result.current.settings.knowledgeBaseIds).toEqual(['kb1']);
    expect(mockSave).not.toHaveBeenCalled();
});
