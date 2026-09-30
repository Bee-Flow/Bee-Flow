// What the AI did about a comment, said to the person who wrote it.
//
// Posting a comment or a reply answers with `ai`: queued (an answer is being
// written), busy (it is still answering in this thread), or skipped with a
// reason. Later the live feed says how a queued answer ended
// (`comment.ai.finished`: answered, blocked, failed). A person who asked the
// AI and hears nothing cannot tell a refusal from a slow answer, so every
// outcome they can act on gets a quiet line under the thread; the ones that
// are simply "the AI was not asked" say nothing.

import type { CommentAiResult } from '../../api/queries/comments';
import type { TranslateFn } from '../../hooks/useTranslation';

/** An outcome worth a line under the thread. */
export type CommentAiNote = 'busy' | 'limit' | 'unavailable' | 'ai_off' | 'blocked' | 'failed';

/**
 * What the reply to a post means for the thread: `queued` (show "AI is
 * answering…" at once), a note to show, or null (nothing to say: the AI was
 * not asked, or it will decide by itself later).
 */
export function aiOutcomeOf(ai: CommentAiResult | null | undefined, askedAi: boolean): 'queued' | CommentAiNote | null {
    if (!ai) return null;
    if (ai.status === 'queued') return 'queued';
    if (ai.status === 'busy') return 'busy';
    if (ai.status !== 'skipped') return null;
    switch (ai.reason) {
        case 'limit': return 'limit';
        case 'unavailable':
        case 'no_model': return 'unavailable';
        // The server says `ai_off` for every comment in a thread with the AI
        // off; it is news only to someone who asked.
        case 'ai_off': return askedAi ? 'ai_off' : null;
        default: return null;
    }
}

/** How a queued answer ended, from `comment.ai.finished`: a note, or null when it answered. */
export function aiFinishedNote(status: unknown): CommentAiNote | null {
    if (status === 'blocked') return 'blocked';
    if (status === 'failed') return 'failed';
    return null;
}

export function aiNoteText(note: CommentAiNote, t: TranslateFn): string {
    switch (note) {
        case 'busy': return t('comments.ai_busy', 'The AI is still answering in this thread. Ask again when it is done.');
        case 'limit': return t('comments.ai_limit', 'The AI did not answer: the AI usage limit has been reached.');
        case 'unavailable': return t('comments.ai_unavailable', 'The AI is not available right now, so it did not answer.');
        case 'ai_off': return t('comments.ai_off_notice', 'The AI is off in this thread, so it did not answer. Change when the AI answers to ask it.');
        case 'blocked': return t('comments.ai_blocked', 'Privacy protection stopped the AI from answering in this thread.');
        default: return t('comments.ai_failed', 'The AI could not answer. Try asking again.');
    }
}
