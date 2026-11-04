/**
 * Meeting-notes writes. Each hook owns its invalidation; the screen passes
 * only what it wants to SAY (a toast, a closed sheet) through `handlers`.
 *
 * Every write refreshes the list too — a row's status and title live there.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';

import {
    deleteTranscription,
    forgetMeetingAudio,
    regenerateSummary,
    reidentifySpeakers,
    renameTranscription,
    reprocessTranscription,
    setActionItems,
    updateSpeakers,
} from '../api/endpoints';
import { recordingKeys } from '../api/keys';
import { toggleActionItem } from '../model/actionItems';
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

/**
 * Tick or untick one action item.
 *
 * The PATCH replaces the WHOLE list, so a tap built from a list the previous
 * tap had not changed yet would send that item back unticked, and the last
 * PATCH to land would win. So each tap starts from the cached note, writes its
 * list into the cache at once (the checkbox moves on the tap, and the next tap
 * starts from it), and the PATCHes go out one at a time in tap order (a
 * mutation scope): the last one carries every tick. The note is read back only
 * once no tick is still waiting, because a refetch that lands between two
 * PATCHes would bring back a list without the ticks still queued. A failed
 * PATCH ends in that read-back too, so the screen shows what the server kept.
 */
export function useToggleActionItem(id: string, handlers: Handlers = {}) {
    const queryClient = useQueryClient();
    const invalidate = useInvalidate(id);
    const mutationKey = ['transcriptions', 'action-items', id];
    const mutation = useMutation({
        mutationKey,
        scope: { id: `transcriptions:action-items:${id}` },
        mutationFn: (items: ActionItem[]) => setActionItems(id, items),
        onError: handlers.onError,
        // This mutation still counts as pending while its own onSettled runs.
        onSettled: () => {
            if (queryClient.isMutating({ mutationKey }) <= 1) invalidate.both();
        },
    });
    return (index: number, fallback: readonly ActionItem[] = []) => {
        const key = recordingKeys.detail(id);
        const note = queryClient.getQueryData<Transcription | null>(key);
        const items = toggleActionItem(note?.actionItems ?? fallback, index);
        if (note) {
            // A refetch already on its way carries the list from before this tap.
            void queryClient.cancelQueries({ queryKey: key });
            const next: Transcription = { ...note, actionItems: items };
            queryClient.setQueryData(key, next);
        }
        mutation.mutate(items);
    };
}

/** `true` sends `?confirm=1` — only ever after the guard's answer was shown. */
export function useDeleteTranscription(id: string, handlers: Handlers = {}) {
    const invalidate = useInvalidate(id);
    return useMutation({
        mutationFn: (confirmedBreaking: boolean) => deleteTranscription(id, { confirmedBreaking }),
        onSuccess: () => {
            // The confirm promised the saved audio goes too: that includes the phone's copy.
            forgetMeetingAudio(id);
            invalidate.list();
            handlers.onSuccess?.();
        },
        onError: handlers.onError,
    });
}
