/**
 * What a "rewrite the summary" answered, and what the person is told about it.
 */

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
    if (!res) return { kind: 'warning', message: 'The server sent no answer — nothing was changed.' };
    if (res.artifactsRegenerated === false) {
        return {
            kind: 'warning',
            message: 'Summary rewritten, but working out the action items, decisions and questions failed — the existing ones were kept.',
        };
    }
    const kept = Array.isArray(res.actionItems)
        ? res.actionItems.filter((item) => item && item.orphaned).length
        : 0;
    if (kept > 0) {
        return {
            kind: 'warning',
            message: `Summary rewritten. ${kept} action item(s) were kept: the new pass no longer found them, and they had been checked off or edited.`,
        };
    }
    return { kind: 'success', message: 'Summary rewritten' };
}
