/**
 * Meeting-notes writes. Each hook owns its invalidation; the screen passes
 * only what it wants to SAY (a toast, a closed sheet) through `handlers`.
 *
 * Every write refreshes the list too — a row's status and title live there.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';

import {
    deleteTranscription,
    regenerateSummary,
    reidentifySpeakers,
    renameTranscription,
    reprocessTranscription,
    setActionItems,
    updateSpeakers,
} from '../api/endpoints';
import { recordingKeys } from '../api/keys';
import type { RegenerateResult } from '../model/regenerate';
import { reprocessErrorCode } from '../model/reprocess';
import type { ActionItem, SpeakerEdit, Transcription } from '../model/types';

export interface Handlers<T = void> {
    onSuccess?: (result: T) => void;
    onError?: (error: Error) => void;
}

function useInvalidate(id: string) {
    const queryClient = useQueryClient();
    const list = () => void queryClient.invalidateQueries({ queryKey: recordingKeys.list });
    return {
        list,
        both: () => {
            void queryClient.invalidateQueries({ queryKey: recordingKeys.detail(id) });
            list();
        },
        /** The speaker routes answer with the whole note, so seed the cache with it. */
        seed: (updated: Transcription | null) => {
            if (updated) queryClient.setQueryData(recordingKeys.detail(id), updated);
            list();
        },
    };
}

export function useRenameTranscription(id: string, handlers: Handlers = {}) {
    const invalidate = useInvalidate(id);
    return useMutation({
        mutationFn: (title: string) => renameTranscription(id, title),
        onSuccess: () => {
            handlers.onSuccess?.();
            invalidate.both();
        },
        onError: handlers.onError,
    });
}

export function useRegenerateSummary(id: string, handlers: Handlers<RegenerateResult | null> = {}) {
    const invalidate = useInvalidate(id);
    return useMutation({
        mutationFn: (choice: { template?: string; templateId?: string }) => regenerateSummary(id, choice),
        onSuccess: (result) => {
            invalidate.both();
            handlers.onSuccess?.(result);
        },
        onError: handlers.onError,
    });
}

export function useUpdateSpeakers(id: string, handlers: Handlers<Transcription | null> = {}) {
    const invalidate = useInvalidate(id);
    return useMutation({
        mutationFn: (edit: SpeakerEdit) => updateSpeakers(id, edit),
        onSuccess: (updated) => {
            invalidate.seed(updated);
            handlers.onSuccess?.(updated);
        },
        onError: handlers.onError,
    });
}

export function useReidentifySpeakers(id: string, handlers: Handlers<Transcription | null> = {}) {
    const invalidate = useInvalidate(id);
    return useMutation({
        mutationFn: (roster: string) => reidentifySpeakers(id, roster),
        onSuccess: (updated) => {
            invalidate.seed(updated);
            handlers.onSuccess?.(updated);
        },
        onError: handlers.onError,
    });
}

/** A double-tapped Retry (409 already_processing) refreshes: the note IS processing. */
export function useReprocessTranscription(id: string, handlers: Handlers = {}) {
    const invalidate = useInvalidate(id);
    return useMutation({
        mutationFn: () => reprocessTranscription(id),
        onSuccess: () => {
            invalidate.both();
            handlers.onSuccess?.();
        },
        onError: (error) => {
            handlers.onError?.(error);
            if (reprocessErrorCode(error) === 'already_processing') invalidate.both();
        },
    });
}

export function useSetActionItems(id: string, handlers: Handlers = {}) {
    const invalidate = useInvalidate(id);
    return useMutation({
        mutationFn: (items: ActionItem[]) => setActionItems(id, items),
        onSuccess: invalidate.both,
        onError: handlers.onError,
    });
}

/** `true` sends `?confirm=1` — only ever after the guard's answer was shown. */
export function useDeleteTranscription(id: string, handlers: Handlers = {}) {
    const invalidate = useInvalidate(id);
    return useMutation({
        mutationFn: (confirmedBreaking: boolean) => deleteTranscription(id, { confirmedBreaking }),
        onSuccess: () => {
            invalidate.list();
            handlers.onSuccess?.();
        },
        onError: handlers.onError,
    });
}
