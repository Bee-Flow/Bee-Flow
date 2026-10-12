import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { repeatingApi, repeatingKeys, useScanFeedback } from '../../../../../api/queries/automation/repeating';
import type { FeedbackBody, ReasonCode, RepeatingSuggestion, ScanResult } from '../../../../../api/queries/automation/repeating';
import { useTranslation } from '../../../../../hooks/useTranslation';
import { toast } from '../../../../shared/Toast';
import { feedbackSuggestion, suggestionKey } from './patternView';

/** How long "Undo" stays offered before the choice is sent. */
export const UNDO_MS = 6000;

export type HideAction = 'snoozed' | 'dismissed';

/** A hide the viewer can still take back. */
export interface PendingHide {
    key: string;
    suggestion: RepeatingSuggestion;
    action: HideAction;
    reasonCode?: ReasonCode;
}

function bodyFor(entry: PendingHide): FeedbackBody {
    const signature = entry.suggestion.pattern?.signature;
    return {
        action: entry.action,
        ...(signature ? { signature } : {}),
        ...(entry.reasonCode ? { reasonCode: entry.reasonCode } : {}),
        suggestion: feedbackSuggestion(entry.suggestion),
    };
}

/** The cached last scan without one pattern, so a remount does not bring it back. */
function withoutKey(prev: ScanResult | null | undefined, key: string): ScanResult | null | undefined {
    if (!prev) return prev;
    return { ...prev, suggestions: prev.suggestions.filter(s => suggestionKey(s) !== key) };
}

const addTo = (set: ReadonlySet<string>, key: string) => new Set(set).add(key);
const removeFrom = (set: ReadonlySet<string>, key: string) => {
    const next = new Set(set);
    next.delete(key);
    return next;
};

/**
 * The viewer's reactions to a pattern, recorded on the server by signature.
 *
 * "Not now" and "Not repetitive" hide the card at once and offer Undo; the
 * choice is only SENT when the undo window closes (or the panel unmounts),
 * so Undo never needs a server-side "un-snooze". A failed send brings the
 * card back and says so. "Build this" / "Adjust first" send `opened` /
 * `asked` straight away, best-effort: `built` is recorded when the builder
 * publishes, not here.
 */
export default function usePatternFeedback({ undoMs = UNDO_MS }: { undoMs?: number } = {}) {
    const { t } = useTranslation();
    const qc = useQueryClient();
    const { mutate } = useScanFeedback();
    const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
    const [pending, setPending] = useState<PendingHide | null>(null);
    const pendingRef = useRef<{ entry: PendingHide; timer: ReturnType<typeof setTimeout> } | null>(null);

    const send = useCallback((entry: PendingHide) => {
        mutate(bodyFor(entry), {
            onSuccess: () => qc.setQueryData<ScanResult | null>(repeatingKeys.last, prev => withoutKey(prev, entry.key)),
            onError: () => {
                setHidden(prev => removeFrom(prev, entry.key));
                toast.error(t('automations.repeating.feedbackFailed', 'Bee could not save that, so the pattern is back.'));
            },
        });
    }, [mutate, qc, t]);

    /** Send the pending hide now (the undo window closed, or a new hide replaces it). */
    const commit = useCallback(() => {
        const p = pendingRef.current;
        if (!p) return;
        clearTimeout(p.timer);
        pendingRef.current = null;
        setPending(null);
        send(p.entry);
    }, [send]);

    const hide = useCallback((suggestion: RepeatingSuggestion, action: HideAction, reasonCode?: ReasonCode) => {
        commit();
        const entry: PendingHide = { key: suggestionKey(suggestion), suggestion, action, ...(reasonCode ? { reasonCode } : {}) };
        setHidden(prev => addTo(prev, entry.key));
        pendingRef.current = { entry, timer: setTimeout(commit, undoMs) };
        setPending(entry);
    }, [commit, undoMs]);

    const undo = useCallback(() => {
        const p = pendingRef.current;
        if (!p) return;
        clearTimeout(p.timer);
        pendingRef.current = null;
        setPending(null);
        setHidden(prev => removeFrom(prev, p.entry.key));
    }, []);

    /** Build this (auto-send) records `opened`; Adjust first records `asked`. Never blocks the click. */
    const opened = useCallback((suggestion: RepeatingSuggestion, autoSend: boolean) => {
        const signature = suggestion.pattern?.signature;
        mutate({
            action: autoSend ? 'opened' : 'asked',
            ...(signature ? { signature } : {}),
            suggestion: feedbackSuggestion(suggestion),
        });
    }, [mutate]);

    // Leaving the page inside the undo window still records the choice. The
    // observer is gone by now, so this goes straight to the API.
    useEffect(() => () => {
        const p = pendingRef.current;
        if (!p) return;
        clearTimeout(p.timer);
        pendingRef.current = null;
        repeatingApi.postFeedback(bodyFor(p.entry))
            .then(() => qc.setQueryData<ScanResult | null>(repeatingKeys.last, prev => withoutKey(prev, p.entry.key)))
            .catch(() => { /* best-effort: the card simply comes back next time */ });
    }, [qc]);

    const isHidden = useCallback((s: RepeatingSuggestion) => hidden.has(suggestionKey(s)), [hidden]);

    return { pending, hide, undo, commit, opened, isHidden };
}
