/**
 * Leaving the last screen of a routine whose save is failing asks first; a
 * healthy draft, or a screen that is not the last holder, leaves at once.
 */

import { act, fireEvent, screen } from '@testing-library/react-native';
import React from 'react';
import { Text } from 'react-native';

import { ConfirmProvider } from '@/shared/patterns';
import { renderWithProviders } from '@/shared/testing/renderWithProviders';

import { useUnsavedLeave } from './useUnsavedLeave';
import { applyPatchStep } from '../model/index';
import type { FlowDefinition } from '../model/types';
import { createDraftStore } from '../state/draftStore';
import { draftStoreFor, resetDraftRegistry, retainDraftStore } from '../state/registry';
import type { DraftStore } from '../state/types';

type Listener = (event: { preventDefault: () => void; data: { action: unknown } }) => void;
const listeners: Listener[] = [];
const mockDispatch = jest.fn();
jest.mock('expo-router', () => ({
    useNavigation: () => ({
        addListener: (_name: string, listener: Listener) => {
            listeners.push(listener);
            return () => listeners.splice(listeners.indexOf(listener), 1);
        },
        dispatch: mockDispatch,
    }),
}));

const DEF: FlowDefinition = { trigger: { id: 'trg', type: 'trigger', kind: 'manual' }, steps: [{ id: 's1', type: 'set' }], edges: [] };

function Probe({ store }: { store: DraftStore }) {
    useUnsavedLeave('a1', store);
    return <Text>editor</Text>;
}

function failingStore(): DraftStore {
    const store = draftStoreFor('a1', () =>
        createDraftStore({
            automationId: 'a1',
            deps: {
                save: async () => {
                    throw new TypeError('Network request failed');
                },
                create: async () => ({ automation: null, warnings: [], answers: null }),
                retryDelaysMs: [],
            },
        }),
    );
    store.getState().hydrate(DEF, 1);
    retainDraftStore('a1');
    return store;
}

async function leave() {
    const event = { preventDefault: jest.fn(), data: { action: { type: 'GO_BACK' } } };
    await act(async () => listeners.forEach((l) => l(event)));
    return event;
}

afterEach(() => {
    resetDraftRegistry();
    listeners.length = 0;
    mockDispatch.mockClear();
});

it('lets a saved draft go without asking', async () => {
    const store = failingStore();
    await renderWithProviders(
        <ConfirmProvider>
            <Probe store={store} />
        </ConfirmProvider>,
    );
    expect(listeners).toHaveLength(0);
});

it('asks before the last screen of a failing draft closes, and goes on "Leave anyway"', async () => {
    const store = failingStore();
    await renderWithProviders(
        <ConfirmProvider>
            <Probe store={store} />
        </ConfirmProvider>,
    );
    store.getState().applyOp((d) => applyPatchStep(d, 's1', { label: 'offline' }));
    await act(async () => {
        await store.getState().flush();
    });
    expect(store.getState().status).toBe('error');
    const event = await leave();
    expect(event.preventDefault).toHaveBeenCalled();
    expect(screen.getByText('Not saved yet')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Leave anyway'));
    expect(mockDispatch).toHaveBeenCalledWith({ type: 'GO_BACK' });
});

it('does not hold a screen that another screen still shares the draft with', async () => {
    const store = failingStore();
    retainDraftStore('a1');
    await renderWithProviders(
        <ConfirmProvider>
            <Probe store={store} />
        </ConfirmProvider>,
    );
    store.getState().applyOp((d) => applyPatchStep(d, 's1', { label: 'offline' }));
    await act(async () => {
        await store.getState().flush();
    });
    expect((await leave()).preventDefault).not.toHaveBeenCalled();
});
