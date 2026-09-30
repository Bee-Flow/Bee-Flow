/**
 * The open routine's draft, for a screen: finds (or makes) the routine's draft
 * store, loads the routine into it, keeps it alive while the screen is
 * mounted, and makes sure nothing typed is lost — the store is flushed when
 * the app goes to the background and when the last screen using it closes.
 *
 * `id` is the routine's id, or NEW_FLOW_ID for a routine that does not exist
 * yet: that one starts from `seed` and is created on its first edit, after
 * which `onCreated` gets the id (to replace the route) and the store is also
 * found under that id.
 */

import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useStore } from 'zustand';

import { useAuth } from '@/core/auth/AuthProvider';

import { adoptRow, refreshRoutineViews } from './cacheSync';
import { useFlowDefinition } from './queries';
import { attachDisk, useLocalDraft, writeDiskNow, type LocalDraft } from './useDiskDraft';
import { createFlow, saveFlow } from '../api/definition';
import type { FlowAutomation } from '../api/types';
import type { FlowDefinition } from '../model/types';
import { createDraftStore } from '../state/draftStore';
import { aliasDraftStore, draftStoreFor, newDraftKey, releaseDraftStore, retainDraftStore } from '../state/registry';
import { newFlowSeed } from '../state/seed';
import type { DraftDeps, DraftState, DraftStore } from '../state/types';

export const NEW_FLOW_ID = 'new';

export interface FlowDraftOptions {
    /** A new routine's starting definition (default: a manual trigger and nothing else). */
    seed?: FlowDefinition;
    /** A new routine's title. */
    title?: string;
    /** A new routine now exists (its first save, or an AI turn, created it) — e.g. to replace the route. */
    onCreated?: (automationId: string) => void;
}

export interface FlowDraft {
    store: DraftStore;
    /** The registry key: the routine id, or a new routine's one-off key. Pass it to the other hooks. */
    key: string;
    /** The server's row (null for a new routine, and while loading). */
    automation: FlowAutomation | null;
    summary: string;
    isLoading: boolean;
    error: unknown;
    /** Re-read the routine; resolves when the read settles (a pull-to-refresh waits for it). */
    refetch: () => Promise<unknown>;
    /** Edits this phone kept while the server did not have them (hooks/useDiskDraft). */
    local: LocalDraft;
}

function draftDeps(queryClient: QueryClient, key: string): DraftDeps {
    return {
        save: (id, definition) => saveFlow(id, { definition }),
        create: (body) => createFlow(body),
        onSaved: (result) => adoptRow(queryClient, result.automation),
        onCreated: (row) => {
            aliasDraftStore(key, row.id);
            adoptRow(queryClient, row);
        },
    };
}

/**
 * A new routine got its row — by its first save, or by an AI turn that
 * created it — so the store is also found under the id, and the screen is
 * told once.
 */
function useAnnounceCreated(key: string, isNew: boolean, automationId: string | null, onCreated?: (id: string) => void) {
    const announced = useRef<string | null>(null);
    useEffect(() => {
        if (!isNew || !automationId || announced.current === automationId) return;
        announced.current = automationId;
        aliasDraftStore(key, automationId);
        onCreated?.(automationId);
    }, [key, isNew, automationId, onCreated]);
}

/**
 * Whose unsaved edits these are, for the phone's sealed copy. The app always
 * renders the editor signed in; a test harness without the auth provider
 * simply gets no copy on disk.
 */
function useDraftOwner(): string | undefined {
    try {
        return useAuth().user?.id;
    } catch {
        return undefined;
    }
}

export function useFlowDraft(id: string, options: FlowDraftOptions = {}): FlowDraft {
    const queryClient = useQueryClient();
    const owner = useDraftOwner();
    const isNew = id === NEW_FLOW_ID;
    const [newKey] = useState(newDraftKey);
    const key = isNew ? newKey : id;
    // Idempotent: the registry answers the store already open under this key.
    const store = draftStoreFor(key, () =>
        createDraftStore({
            automationId: isNew ? null : id,
            seed: isNew ? (options.seed ?? newFlowSeed()) : null,
            title: options.title,
            deps: draftDeps(queryClient, key),
        }),
    );
    attachDisk(store, owner);
    const automationId = useStore(store, (s) => s.automationId);
    useAnnounceCreated(key, isNew, automationId, options.onCreated);
    const query = useFlowDefinition(automationId);
    const row = query.data?.automation ?? null;

    useEffect(() => {
        if (row) store.getState().hydrate(row.definition, row.version);
    }, [row, store]);
    const local = useLocalDraft(store, row !== null);

    useEffect(() => {
        retainDraftStore(key);
        return () => {
            releaseDraftStore(key);
            refreshRoutineViews(queryClient, store.getState().automationId);
        };
    }, [key, queryClient, store]);

    useEffect(() => {
        const sub = AppState.addEventListener('change', (next) => {
            if (next !== 'active') {
                writeDiskNow(store);
                void store.getState().flush();
            }
        });
        return () => sub.remove();
    }, [store]);

    return {
        store,
        key,
        automation: row,
        summary: query.data?.summary ?? '',
        isLoading: automationId !== null && query.isLoading,
        error: query.error,
        refetch: () => query.refetch(),
        local,
    };
}

/** Subscribe to one slice of a draft; re-renders only when that slice changes. */
export function useDraftState<U>(store: DraftStore, select: (state: DraftState) => U): U {
    return useStore(store, select);
}
