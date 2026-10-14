import { useState } from 'react';
import { nOf } from '../../../components/admin/Studio/KnowledgeStudio/plural';
import { toast } from '../../../components/shared/Toast';
import type { TranslateFn } from '../../../hooks/useTranslation';
import * as api from '../lib/transcriptionsApi';
import type { ApiError, MeetingActionItem, MeetingNote, MeetingRowPatch, SetMeeting } from './meetingDetailTypes';

interface RegenerateAnswer {
    summary?: string;
    actionItems?: unknown;
    decisions?: MeetingActionItem[];
    questions?: MeetingActionItem[];
    chapters?: unknown[];
    summaryTemplateId?: string | null;
    summaryTemplateVersion?: number | null;
    artifactsRegenerated?: boolean;
}

/** The note after a summary regeneration, from the server's answer. */
export function mergeRegenerated(p: MeetingNote, res: RegenerateAnswer): MeetingNote {
    return {
        ...p,
        summary: res.summary,
        // The MERGED list, and the whole point of M3: the route re-extracts the
        // AI's action items and keeps every `source:'user'` one, so what comes
        // back already contains the actions this person typed themselves —
        // with their destinations. Take it whole, and only when it IS a list:
        // anything else leaves the list on screen alone rather than emptying
        // the card over a malformed answer.
        actionItems: Array.isArray(res.actionItems) ? res.actionItems : p.actionItems,
        // Regenerate is also the upgrade path for meetings recorded before
        // chapters / decisions / questions existed.
        decisions: res.decisions || p.decisions,
        questions: res.questions || p.questions,
        chapters: res.chapters || p.chapters,
        // Which template wrote this new text (M4 step 3). `?? null` and not
        // `|| p.…`: for a one-off prompt the server deliberately answers null —
        // that CLEARS the stamp, and falling back to the old value would leave
        // the previous template on text it did not write.
        summaryTemplateId: res.summaryTemplateId ?? null,
        summaryTemplateVersion: res.summaryTemplateVersion ?? null,
    };
}

/** Say what the regeneration could not do (the lists are kept, never silently). */
function announceRegenerateOutcome(t: TranslateFn, res: RegenerateAnswer) {
    // A FAILED ARTIFACT PASS MUST SAY SO. The server then keeps the existing
    // action items, decisions and questions and answers
    // `artifactsRegenerated: false`. Without this message that is
    // indistinguishable on screen from "nothing new came out". `=== false` and
    // not `!res….`: an older answer without the field claims nothing.
    if (res.artifactsRegenerated === false) {
        toast.info(t('meetings.artifacts_not_regenerated', 'The summary was rewritten, but working out the action items, decisions and questions failed — the existing ones were kept. Try again in a moment.'));
    }
    // AND WHICH ITEMS THE NEW PASS NO LONGER PRODUCED. The server keeps an AI
    // item a human touched (checked off, or retyped) even when the fresh
    // extraction no longer recognises it, and returns it with
    // `orphaned: true`. Letting that through silently would make the card
    // claim the AI just produced it; the lasting mark is on the card itself
    // (ActionItemsList).
    const keptCount = Array.isArray(res.actionItems)
        ? (res.actionItems as MeetingActionItem[]).filter((ai) => ai && ai.orphaned).length
        : 0;
    if (keptCount > 0) {
        // Base key + `_plural`, with the ternary around the KEY: "action
        // item(s)" is English grammar in JavaScript and no translation can do
        // anything with it.
        toast.info(nOf(
            t, 'meetings.action_items_kept', keptCount,
            'One action item was kept: the new pass no longer found it, and it had been checked off or edited.',
            '{count} action items were kept: the new pass no longer found them, and they had been checked off or edited.',
        ));
    }
}

/** Keeps accented letters as their base ("cliëntenraad" → "clientenraad") instead of deleting them. */
export function exportFileStem(title: string | undefined): string {
    return (title || 'meeting')
        .normalize('NFKD').replace(/[̀-ͯ]/g, '')
        .replace(/[^\w -]/g, '').trim() || 'meeting';
}

export interface MeetingCommandDeps {
    data: MeetingNote | null;
    setLocal: SetMeeting;
    refresh: () => Promise<unknown> | unknown;
    onChanged?: (id: string, patch: MeetingRowPatch) => void;
    onDeleted?: (id: string) => void;
    confirm: (opts: { title: string; description: string; confirmLabel: string }) => Promise<boolean>;
    t: TranslateFn;
    uncheckedKinds: string[];
}

/** The commands on a meeting: re-transcribe, export, copy, delete and regenerate the summary. */
export default function useMeetingCommands({ data, setLocal, refresh, onChanged, onDeleted, confirm, t, uncheckedKinds }: MeetingCommandDeps) {
    const [busy, setBusy] = useState(false);
    const [regenerating, setRegenerating] = useState(false);

    const handleReprocess = async () => {
        if (!data) return;
        const ok = await confirm({
            title: t('meetings.reprocess_title', 'Re-transcribe this recording?'),
            description: t('meetings.reprocess_desc', 'The existing transcript, summary and action items will be replaced.'),
            confirmLabel: t('meetings.retranscribe', 'Re-transcribe'),
        });
        if (!ok) return;
        setBusy(true);
        try {
            await api.reprocessTranscription(data.id);
            await refresh();
            onChanged?.(data.id, {});
        } catch (e) {
            const err = e as ApiError;
            // Branch on the server's stable code, not on prose. 503 means the
            // storage service is briefly unreachable and the recording is fine;
            // 410 means it is genuinely gone — and for a browser recording there
            // is no original file to ask for.
            if (err.code === 'audio_storage_unavailable') {
                toast.error(t('meetings.audio_storage_unavailable', 'Audio storage is temporarily unavailable. Try again in a minute — your recording is safe.'));
            } else if (err.code === 'audio_gone_recorded' || err.code === 'audio_gone_uploaded') {
                await refresh();   // surfaces the AudioUnavailable panel
                toast.error(err.message);
            } else {
                toast.error(t('meetings.reprocess_failed', 'Reprocess failed: {message}', { message: err.message }));
            }
        } finally {
            setBusy(false);
        }
    };

    const handleExport = async (format: string) => {
        if (!data) return;
        try {
            const blob = await api.exportTranscription(data.id, format);
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${exportFileStem(data.title)}.${format}`;
            a.click();
            URL.revokeObjectURL(url);
        } catch (err) {
            toast.error(t('meetings.export_failed', 'Export failed: {message}', { message: (err as Error).message }));
        }
    };

    const handleCopyTranscript = async () => {
        if (!data?.transcript) return;
        try {
            await navigator.clipboard.writeText(data.transcript);
            toast.success(t('meetings.transcript_copied', 'Transcript copied'));
        } catch { /* clipboard unavailable — nothing to say */ }
    };

    /**
     * Delete, through the shared danger zone rather than a yes/no dialog.
     *
     * `confirmedBreaking` comes from DangerZone: true only when the list ON
     * SCREEN was non-empty and the meeting's title was typed against it. It is
     * OR-ed with `uncheckedKinds` because the danger zone counts ROWS and a
     * kind the server could not check has no row — without this the request
     * would go out unconfirmed, come back 409 with an empty list, and press
     * again into the same 409 for ever.
     *
     * Errors are NOT swallowed into a toast: a 409 has to reach DangerZone,
     * which re-shows the server's fresher list and asks again.
     */
    const handleDelete = async (confirmedBreaking: boolean) => {
        if (!data) return undefined;
        const result = await api.deleteTranscription(data.id, {
            confirmedBreaking: confirmedBreaking || uncheckedKinds.length > 0,
        });
        onDeleted?.(data.id);
        return result;
    };

    const handleRegenerateSummary = async (template: unknown) => {
        if (!data) return;
        setRegenerating(true);
        try {
            const res: RegenerateAnswer = await api.regenerateSummary(data.id, template);
            setLocal((p) => mergeRegenerated(p, res));
            if (Array.isArray(res.actionItems)) {
                const items = res.actionItems as MeetingActionItem[];
                onChanged?.(data.id, { actionsTotal: items.length, actionsOpen: items.filter((ai) => !ai.done).length });
            }
            announceRegenerateOutcome(t, res);
        } catch (err) {
            toast.error(t('meetings.regenerate_failed', 'Regenerate failed: {message}', { message: (err as Error).message }));
        } finally {
            setRegenerating(false);
        }
    };

    return {
        busy, setBusy, regenerating, setRegenerating,
        handleReprocess, handleExport, handleCopyTranscript, handleDelete, handleRegenerateSummary,
    };
}
