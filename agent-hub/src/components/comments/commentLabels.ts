// The words for a thread's AI mode, shared by the thread card and the new
// comment form.

import type { CommentAiMode, CommentAiPolicy } from '../../api/queries/comments';
import type { TranslateFn } from '../../hooks/useTranslation';

/** The modes in the order a menu offers them. */
export const AI_MODES: readonly CommentAiMode[] = Object.freeze(['mention', 'auto', 'off']);

export function aiModeLabel(mode: CommentAiMode, t: TranslateFn): string {
    if (mode === 'off') return t('comments.ai_mode_off', 'AI off');
    if (mode === 'auto') return t('comments.ai_mode_auto', 'AI decides');
    return t('comments.ai_mode_mention', 'AI on mention');
}

/**
 * May this mode be picked now? "AI decides" only where the organisation
 * allows it; the thread's current mode always may (nothing changes under
 * you), and an unknown policy leaves the check to the server.
 */
export function aiModeAllowed(mode: CommentAiMode, current: CommentAiMode | null, policy: CommentAiPolicy | null | undefined): boolean {
    if (mode !== 'auto' || mode === current || !policy) return true;
    return policy.autoAllowed;
}

/** The option's text: the mode, and why it cannot be picked when it cannot. */
export function aiModeOption(mode: CommentAiMode, allowed: boolean, t: TranslateFn): string {
    return allowed ? aiModeLabel(mode, t) : t('comments.ai_mode_auto_not_allowed', 'AI decides (not allowed by your organisation)');
}
