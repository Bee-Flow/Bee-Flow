/**
 * The Cowork writes: pause/resume, run now, delete, and the compose → create
 * pair behind the composer. Each refreshes what it changed.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';

import { composeCowork, createSchedule, deleteSchedule, runNow, toggleSchedule } from '../api/endpoints';
import { coworkKeys } from '../api/keys';
import { proposalFrom, type Proposal } from '../model/proposal';
import type { ComposedCowork } from '../model/types';

interface Handlers {
    onSuccess?: () => void;
    /** Gets what was thrown, so the screen can say it through describeError. */
    onError?: (error: Error) => void;
}

export function useToggleSchedule(id: string, handlers: Handlers = {}) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: () => toggleSchedule(id),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: coworkKeys.schedule(id) });
            void queryClient.invalidateQueries({ queryKey: coworkKeys.schedules });
        },
        onError: handlers.onError,
    });
}

export function useRunScheduleNow(id: string, handlers: Handlers = {}) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: () => runNow(id),
        onSuccess: () => {
            handlers.onSuccess?.();
            void queryClient.invalidateQueries({ queryKey: coworkKeys.runs(id) });
        },
        onError: handlers.onError,
    });
}

export function useDeleteSchedule(id: string, handlers: Handlers = {}) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: () => deleteSchedule(id),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: coworkKeys.schedules });
            handlers.onSuccess?.();
        },
        onError: handlers.onError,
    });
}

/**
 * Turn a brief into a proposal to confirm. The web's degradation, kept: a
 * compose failure falls back to the user's own words rather than losing them.
 */
export function useComposeCowork(onProposal: (proposal: Proposal) => void) {
    return useMutation({
        mutationFn: async (text: string) => {
            let spec: ComposedCowork | null = null;
            try {
                spec = await composeCowork(text);
            } catch {
                spec = null;
            }
            return proposalFrom(text, spec);
        },
        onSuccess: onProposal,
    });
}

/** Create the confirmed schedule. Nothing exists until this runs. */
export function useCreateSchedule(onCreated: () => void) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (p: Proposal) => {
            if (!p.payload) throw new Error('Could not work out when this should run.');
            return createSchedule(p.payload);
        },
        onSuccess: () => {
            onCreated();
            void queryClient.invalidateQueries({ queryKey: coworkKeys.schedules });
        },
    });
}
