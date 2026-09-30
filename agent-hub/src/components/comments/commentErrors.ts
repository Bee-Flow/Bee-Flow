// A refused comment request, said in the reader's language: the server's
// stable code picks the sentence; an unknown code keeps the server's own
// sentence, and a refusal without one gets the caller's fallback.

import { projectErrorInfo } from '../../api/queries/projectErrors';
import type { TranslateFn } from '../../hooks/useTranslation';

export function commentErrorText(t: TranslateFn, source: unknown, fallback: string): string {
    const { code, message } = projectErrorInfo(source);
    const status = (source as { status?: number } | null)?.status;
    switch (code) {
        case 'PROJECT_KEY_UNAVAILABLE':
            return t('comments.error_key_unavailable', 'The project’s encryption key is not available right now, so nothing was saved. Try again in a moment.');
        case 'target_not_found':
            return t('comments.error_target_gone', 'This item is no longer in the project, so its comments are closed.');
        case 'thread_not_found':
            return t('comments.error_thread_gone', 'This thread was deleted.');
        case 'comment_not_found':
        case 'comment_deleted':
            return t('comments.error_comment_gone', 'This comment was deleted.');
        case 'not_comment_author':
            return t('comments.error_not_author', 'Only the author can change this comment.');
        case 'not_thread_creator':
            return t('comments.error_not_creator', 'Only the person who started this thread or the project owner can delete it.');
        case 'ai_mode_not_allowed':
            return t('comments.error_ai_mode_not_allowed', 'Your organisation does not let the AI join comment threads by itself. Choose another AI mode.');
        case 'SOLUTION_HOLDS_NO_COMMENTS':
            return t('comments.error_solution', 'A Studio Solution holds no comments. Comment on items in a project instead.');
        default:
            if (status === 403) return t('comments.error_forbidden', 'Only the project’s editors can comment.');
            if (status === 429) return t('comments.error_rate_limited', 'That was a lot of comments at once. Wait a moment and send again.');
            return message || fallback;
    }
}
