import { QueryClientContext } from '@tanstack/react-query';
import { useCallback, useContext, useRef } from 'react';
import { repeatingApi, repeatingKeys } from '../../../api/queries/automation/repeating';
import type { FeedbackBody, RepeatingSuggestion, ScanResult } from '../../../api/queries/automation/repeating';
import { feedbackSuggestion } from '../../admin/Studio/AutomationsStudio/repeating/patternView';

/** The "Find repeating work" suggestion a new builder was opened from. */
export interface PatternOrigin {
    /** The pattern's signature; absent for an idea, which the server keys by title. */
    signature?: string;
    /** The allow-listed subset the feedback route takes, never the whole suggestion. */
    suggestion: FeedbackBody['suggestion'];
}

/** The origin to hand the builder for a suggestion, or null when there is nothing to record. */
export function patternOriginOf(s: RepeatingSuggestion | null | undefined): PatternOrigin | null {
    if (!s || typeof s.title !== 'string' || !s.title) return null;
    const signature = s.pattern?.signature;
    return { ...(signature ? { signature } : {}), suggestion: feedbackSuggestion(s) };
}

const sameOrigin = (s: RepeatingSuggestion, origin: PatternOrigin) => (
    origin.signature ? s.pattern?.signature === origin.signature : s.id === origin.suggestion.id
);

/**
 * Records `built` for the pattern a new builder was opened from, once per
 * builder, when the build is really done: the builder finalised it, or it was
 * activated or published. Never on the first draft save, because the builder
 * creates the draft on its very first turn. "Build this" and "Adjust first"
 * already sent `opened` / `asked` when they were clicked.
 *
 * The origin lives only in this mount (index.jsx holds it beside the
 * auto-send spec); the automation row does not store it. So a draft left and
 * finished in a later session is not counted, which only means the pattern
 * can be suggested again.
 *
 * Returns `markBuilt`, safe to call from every "done" path: the first call
 * sends, later calls do nothing, and a failed send lets the next one retry.
 * After a send, the pattern also leaves the cached last scan (when the page
 * has a QueryClient), so the tab does not offer it again.
 */
export default function usePatternOrigin(origin: PatternOrigin | null | undefined): () => void {
    // Optional on purpose: a builder rendered without react-query (a test, an
    // embed) still records the feedback and just has no cache to update.
    const client = useContext(QueryClientContext);
    const sentRef = useRef(false);
    return useCallback(() => {
        if (!origin || sentRef.current) return;
        sentRef.current = true;
        repeatingApi.postFeedback({
            action: 'built',
            ...(origin.signature ? { signature: origin.signature } : {}),
            suggestion: origin.suggestion,
        }).then(() => {
            client?.setQueryData<ScanResult | null>(repeatingKeys.last, prev => (
                prev ? { ...prev, suggestions: prev.suggestions.filter(s => !sameOrigin(s, origin)) } : prev
            ));
        }).catch(() => {
            // Best-effort, like every scan feedback: the next done path retries.
            sentRef.current = false;
        });
    }, [origin, client]);
}
