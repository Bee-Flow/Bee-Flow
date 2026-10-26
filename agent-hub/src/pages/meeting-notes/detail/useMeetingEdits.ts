import { applyDestination } from '../lib/actionDestinations';
import * as api from '@/api/transcriptionsApi';
import { appendArtifact } from '../lib/transcriptLines';
import type { MeetingActionItem, MeetingNote, MeetingRowPatch, SetMeeting } from './meetingDetailTypes';

export interface MeetingEditDeps {
    data: MeetingNote | null;
    setLocal: SetMeeting;
    refresh: () => unknown;
    onChanged?: (id: string, patch: MeetingRowPatch) => void;
    /** Offer "regenerate the summary with the new names?" after a speaker change. */
    offerRegenerate: () => void;
    /** Toast for the one failure that has to be said out loud (destination). */
    notifyDestinationNotSaved: () => void;
}

const actionCounts = (list: MeetingActionItem[]) => ({ actionsTotal: list.length, actionsOpen: list.filter((ai) => !ai.done).length });

/**
 * The writes on the note itself: title, tags, the action list, the decisions
 * list and the speakers. Every one updates the screen first and falls back to
 * a refetch when the PATCH fails.
 */
export default function useMeetingEdits({ data, setLocal, refresh, onChanged, offerRegenerate, notifyDestinationNotSaved }: MeetingEditDeps) {
    const handleRename = async (title: string) => {
        if (!data) return;
        setLocal((p) => ({ ...p, title }));
        try {
            await api.patchTranscription(data.id, { title });
            onChanged?.(data.id, { title });
        } catch { refresh(); }
    };

    const saveTags = async (next: string[]) => {
        if (!data) return;
        setLocal((p) => ({ ...p, tags: next }));
        try { await api.patchTranscription(data.id, { tags: next }); onChanged?.(data.id, { tags: next }); } catch { refresh(); }
    };
    const handleAddTag = async (tag: string) => { if (data) await saveTags([...(data.tags || []), tag]); };
    const handleRemoveTag = async (tag: string) => { if (data) await saveTags((data.tags || []).filter((x) => x !== tag)); };

    /**
     * Save the action list — the ONE write path behind the three things that
     * change it: a checkbox, an edited sentence, a destination (M3).
     *
     * TWO RULES, BOTH LOAD-BEARING.
     *
     * 1. THE FULL LIST GOES OVER THE WIRE. `PATCH actionItems` REPLACES the
     *    column, so sending only the item that changed would delete every
     *    other action on the note — including the ones a person typed
     *    themselves, which is the exact loss M3 exists to prevent. There is no
     *    undo, and nothing on screen would say it had happened.
     * 2. THE SERVER'S ANSWER WINS. The route validates and re-shapes what it
     *    is handed (core/meetingNotes/actionItems.js: an id it minted for an
     *    item that arrived without one, a destination stamped with its own
     *    clock) and echoes the cleaned list back. A client that ignored that
     *    echo would keep rendering its optimistic copy until the next full
     *    refetch, and then watch the ids change under it mid-edit.
     *
     * Answers whether the note was saved, so a caller whose OTHER write
     * already succeeded (the automation really ran) can say that this half did
     * not.
     */
    const saveActionItems = async (next: MeetingActionItem[]): Promise<boolean> => {
        if (!data) return false;
        setLocal((p) => ({ ...p, actionItems: next }));
        // The rail's "n actions open" reads the list aggregates; keep them in
        // step with the toggle so the row does not lag the checkbox.
        onChanged?.(data.id, actionCounts(next));
        try {
            const res = await api.patchTranscription(data.id, { actionItems: next });
            if (Array.isArray(res?.actionItems)) {
                setLocal((p) => ({ ...p, actionItems: res.actionItems }));
                onChanged?.(data.id, actionCounts(res.actionItems));
            }
            return true;
        } catch {
            refresh();
            return false;
        }
    };

    const updateItem = (itemId: string | undefined, patch: (ai: MeetingActionItem) => MeetingActionItem) =>
        (data?.actionItems || []).map((ai) => (ai.id === itemId ? patch(ai) : ai));

    const handleToggleActionItem = async (itemId: string | undefined) => {
        if (!data) return;
        await saveActionItems(updateItem(itemId, (ai) => ({ ...ai, done: !ai.done })));
    };

    const handleEditActionItem = async (itemId: string | undefined, nextText: string) => {
        if (!data) return;
        const cleaned = String(nextText || '').trim();
        if (!cleaned) return;
        await saveActionItems(updateItem(itemId, (ai) => ({ ...ai, text: cleaned })));
    };

    /**
     * Record where an action went (M3). The destination's own write has
     * already happened — DestinationPicker only calls back once the run, the
     * row or the knowledge source answered — so a failure HERE is the one case
     * that has to be said out loud: the automation ran, and the note lost the
     * chip that says so.
     */
    const handleSetActionDestination = async (itemId: string | undefined, destination: unknown) => {
        if (!data) return;
        const ok = await saveActionItems(applyDestination(data.actionItems || [], itemId, destination));
        if (!ok) notifyDestinationNotSaved();
    };

    /**
     * Save one of the two note lists the transcript can add to (M4). Same two
     * rules as saveActionItems, for the same reasons. Answers whether the note
     * was saved, so the popover can show a refusal instead of quietly closing.
     */
    const saveNotes = async (field: 'decisions', next: MeetingActionItem[]): Promise<boolean> => {
        if (!data) return false;
        setLocal((p) => ({ ...p, [field]: next }));
        try {
            const res = await api.patchTranscription(data.id, { [field]: next });
            if (Array.isArray(res?.[field])) setLocal((p) => ({ ...p, [field]: res[field] }));
            return true;
        } catch {
            refresh();
            return false;
        }
    };

    /**
     * A line of the transcript became an action, or a decision (M4). The item
     * arrives already marked `source: 'user'` and anchored to its line
     * (lib/transcriptLines.js); `POST /:id/regenerate-summary` keeps out of
     * the way of exactly the items marked this way. A `null` item writes
     * nothing at all rather than PATCHing the column back unchanged.
     */
    const handleAddLineAction = async (item: MeetingActionItem | null) => {
        if (!data || !item) return false;
        return saveActionItems(appendArtifact(data.actionItems || [], item));
    };
    const handleAddLineDecision = async (item: MeetingActionItem | null) => {
        if (!data || !item) return false;
        return saveNotes('decisions', appendArtifact(data.decisions || [], item));
    };

    const applySpeakerUpdate = (updated: MeetingNote) => {
        // Replace the local meeting with the fresh server shape.
        setLocal(() => updated);
        if (data) onChanged?.(data.id, updated);
        offerRegenerate();
        return updated;
    };
    const handleSpeakerEditSave = async ({ renames, merges }: { renames?: Record<string, string>; merges?: Array<{ from: string[]; into: string }> }) => {
        if (!data) return null;
        return applySpeakerUpdate(await api.updateSpeakers(data.id, { renames, merges }));
    };
    // Re-run AI naming on the stored transcript (no re-transcription). Lets a
    // note stuck on "Guest-1/2/3" be mapped to real names; an attendee list
    // makes it reliable.
    const handleReidentifySpeakers = async (attendees?: string | string[]) => {
        if (!data) return null;
        return applySpeakerUpdate(await api.reidentifySpeakers(data.id, attendees));
    };

    return {
        handleRename, handleAddTag, handleRemoveTag,
        handleToggleActionItem, handleEditActionItem, handleSetActionDestination,
        handleAddLineAction, handleAddLineDecision,
        handleSpeakerEditSave, handleReidentifySpeakers,
    };
}
