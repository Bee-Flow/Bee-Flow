/**
 * The skill autosave: a save carries its structure into the cached detail
 * row (so a reopen seeds from what was saved, not the pre-edit row), and
 * `flush` resolves only after an edit made during an earlier save has landed.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react-native';
import React, { type ReactNode } from 'react';

import { ToastProvider } from '@/shared/ui';

import { useSkillEditor } from './useSkillEditor';
import { updateSkill } from '../api/endpoints';
import { skillKeys } from '../api/keys';
import { draftOf } from '../model/skillModel';
import type { Skill } from '../model/types';

jest.mock('../api/endpoints', () => ({ updateSkill: jest.fn() }));

const update = updateSkill as jest.MockedFunction<typeof updateSkill>;

const SKILL = {
    id: 'sk1',
    orgId: 'org1',
    userId: 'u1',
    name: 'Quote answers',
    canEdit: true,
    steps: [{ id: 's1', text: 'Look up the quote', refs: [] }],
} as unknown as Skill;

function setup() {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: Infinity } },
    });
    queryClient.setQueryData(skillKeys.detail('sk1'), SKILL);
    const wrapper = ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>
            <ToastProvider>{children}</ToastProvider>
        </QueryClientProvider>
    );
    return { queryClient, wrapper };
}

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((res) => (resolve = res));
    return { promise, resolve };
}

afterEach(() => update.mockReset());

describe('useSkillEditor', () => {
    it('carries a saved edit into the cached detail row', async () => {
        update.mockResolvedValue(undefined);
        const { queryClient, wrapper } = setup();
        const { result } = await renderHook(() => useSkillEditor(SKILL), { wrapper });
        const steps = [{ id: 's1', text: 'Look up the signed quote', refs: [] }];

        await act(async () => {
            result.current.patch({ steps });
            await result.current.flush();
        });

        const cached = queryClient.getQueryData<Skill>(skillKeys.detail('sk1'));
        expect(draftOf(cached as Skill).steps).toEqual(steps);
    });

    it('resolves flush only after an edit typed during a save has landed', async () => {
        const first = deferred();
        update.mockReturnValueOnce(first.promise).mockResolvedValue(undefined);
        const { wrapper } = setup();
        const { result } = await renderHook(() => useSkillEditor(SKILL), { wrapper });

        await act(async () => result.current.patch({ name: 'A' }, true));
        expect(update).toHaveBeenCalledTimes(1);
        await act(async () => result.current.patch({ name: 'AB' }));

        let landed = false;
        let flushed: Promise<void> = Promise.resolve();
        await act(async () => {
            flushed = result.current.flush().then(() => {
                landed = true;
            });
        });
        expect(landed).toBe(false);

        await act(async () => {
            first.resolve();
            await flushed;
        });
        expect(landed).toBe(true);
        expect(update).toHaveBeenCalledTimes(2);
        expect(update).toHaveBeenLastCalledWith('sk1', expect.objectContaining({ name: 'AB' }));
        expect(result.current.saveState).toBe('saved');
    });

    it('applies a function patch to the newest draft', async () => {
        update.mockResolvedValue(undefined);
        const { wrapper } = setup();
        const { result } = await renderHook(() => useSkillEditor(SKILL), { wrapper });

        await act(async () => {
            result.current.patch({ description: 'typed meanwhile' });
            result.current.patch((current) => ({ name: `${current.description} + proposal` }), true);
            await result.current.flush();
        });

        expect(result.current.draft.description).toBe('typed meanwhile');
        expect(result.current.draft.name).toBe('typed meanwhile + proposal');
    });
});
