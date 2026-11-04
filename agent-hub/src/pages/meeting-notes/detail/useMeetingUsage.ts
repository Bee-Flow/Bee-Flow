import { useEffect, useRef } from 'react';
import useUsage from '@/hooks/useUsage';
import type { MeetingNote, MeetingRowPatch } from './meetingDetailTypes';

/**
 * "Used by n" — ONE fetch for the tab badge, the tab body, the outputs bar
 * under the tags and the delete confirmation (Track 0.4, endpoint M2). Four
 * consumers, one list: a bar that says a knowledge base collects this meeting
 * while the delete dialog says nothing depends on it would be worse than
 * either being absent.
 *
 * `unchecked` names the kinds the server could NOT answer for. It is not
 * decoration: an incomplete list must never be presented as a complete one,
 * and the count in the tab badge stays blank rather than under-reporting.
 */
export default function useMeetingUsage(meetingId: string | undefined) {
    const { usage, unchecked, error: usageError, loading: usageLoading, refetch } = useUsage('meeting', meetingId || null);
    const uncheckedKinds = usageError ? [] : (unchecked || []);
    const usedByCount = (usageError || uncheckedKinds.length > 0) ? undefined : (usage === null ? undefined : usage.length);
    // `refetch` because most of the list is derived from the TAGS: after a tag
    // edit, a regenerate or a finished re-transcription the old list is stale.
    return { usage, uncheckedKinds, usageError, usageLoading, usedByCount, refetch };
}

/** What the library row shows of a note, read off the detail payload. */
function rowPatchOf(data: MeetingNote): MeetingRowPatch {
    const items = data.actionItems || [];
    return {
        status: data.status,
        failureReason: data.status === 'failed' ? (String(data.failureReason || data.summary || '').trim() || null) : null,
        title: data.title,
        tags: data.tags || [],
        durationSeconds: data.durationSeconds,
        actionsTotal: items.length,
        actionsOpen: items.filter((ai) => !ai.done).length,
    };
}

/**
 * When the detail's own poll sees the note leave 'processing', hand the result
 * to the library row and re-read what uses the note. Nothing else does: the
 * list stops polling once no row it holds is 'processing', and a
 * re-transcription can change the tags the usage list is derived from.
 */
export function useProcessingSettled(data: MeetingNote | null, onChanged: (id: string, patch: MeetingRowPatch) => void, refetchUsage: () => void) {
    const seen = useRef<{ id: string; status: string | undefined } | null>(null);
    useEffect(() => {
        const was = seen.current;
        seen.current = data ? { id: data.id, status: data.status } : null;
        if (!data || !was || was.id !== data.id) return;
        if (was.status !== 'processing' || data.status === 'processing') return;
        onChanged?.(data.id, rowPatchOf(data));
        refetchUsage();
    }, [data, onChanged, refetchUsage]);
}
