/**
 * What a "rewrite the summary" answered, and what the person is told about it.
 */

import { translate } from '@/core/i18n';

import { reprocessErrorCode } from './reprocess';
import type { ActionItem, Chapter, Decision, OpenQuestion, Speaker } from './types';

export interface RegenerateResult {
    summary: string;
    actionItems: ActionItem[];
    decisions: Decision[];
    questions: OpenQuestion[];
    chapters: Chapter[];
    speakers: Speaker[];
    /**
     * Did the artifact pass actually run?
     *
     * Regenerate deliberately has NO summary channel for bad news: the summary that
     * comes back is always fresh. This field is therefore the only channel through
     * which the server can say that the elaboration of the action items, decisions
     * and questions has failed and the OLD lists have remained. A client that does
     * not read it shows a green toast for a half failure, and then nobody presses
     * Opnieuw again.
     *
     * Optional because an older server does not send the field — and `undefined`
     * claims nothing, so only an explicit `false` is news.
     */
    artifactsRegenerated?: boolean;
}

/** Wat de gebruiker na een regeneratie te zien krijgt. */
export interface RegenerateOutcome {
    kind: 'success' | 'warning';
    message: string;
}

/**
 * The outcome of a regeneration in one sentence — the web client says the same.
 *
 * Pure, and deliberately outside the screen: this is the rule that says WHEN a
 * regeneration is not an unqualified success, and it should be testable without a
 * renderer.
 *
 * Three cases, and only the first is green:
 *   - the pass ran and delivered everything;
 *   - the pass failed (`artifactsRegenerated === false`) — the summary has been
 *     refreshed, but the lists are the old ones;
 *   - the pass ran, but could not find one or more stored points (`orphaned`):
 *     those remain because someone had ticked them off or retyped them, and that
 *     must be said before the card pretends the AI just delivered them.
 */
export function describeRegenerateOutcome(res: RegenerateResult | null): RegenerateOutcome {
    if (!res) return { kind: 'warning', message: translate('mobile.recording.regen_no_answer', 'The server sent no answer — nothing was changed.') };
    if (res.artifactsRegenerated === false) {
        return {
            kind: 'warning',
            message: translate(
                'mobile.recording.regen_artifacts_failed',
                'Summary rewritten, but working out the action items, decisions and questions failed — the existing ones were kept.',
            ),
        };
    }
    const kept = Array.isArray(res.actionItems)
        ? res.actionItems.filter((item) => item && item.orphaned).length
        : 0;
    if (kept > 0) {
        return {
            kind: 'warning',
            message: translate(
                'mobile.recording.regen_kept',
                'Summary rewritten. {count} action item(s) were kept: the new pass no longer found them, and they had been checked off or edited.',
                { count: kept },
            ),
        };
    }
    return { kind: 'success', message: translate('mobile.recording.regen_done', 'Summary rewritten') };
}

/**
 * The sentence for a refused regeneration; `fallback` (describeError's) for any
 * other failure. Both refusals leave the note as it was:
 *   502 summary_empty: the model wrote nothing, so nothing was written.
 *   409 already_processing / transcript_changed: a re-transcription is running,
 *       or replaced the transcript during the rewrite; regenerate again after it.
 */
export function regenerateFailureMessage(error: unknown, fallback: string): string {
    const code = reprocessErrorCode(error);
    if (code === 'summary_empty') {
        return translate('mobile.recording.regen_empty', 'The model returned no summary, so nothing was changed. Try again.');
    }
    if (code === 'already_processing' || code === 'transcript_changed') {
        return translate(
            'mobile.recording.regen_retranscribing',
            'This meeting is being re-transcribed, or just was. Wait until it is finished, then rewrite the summary again.',
        );
    }
    return fallback;
}
