// The passage a thread is about, as its card shows it: the quoted words with
// an accent rule, clickable to scroll the item to them. A passage that can no
// longer be found says so instead (the text was edited or removed), and a
// comment on the whole item says that.

import { FileText, TextQuote, Unlink } from 'lucide-react';
import React from 'react';
import type { CommentAnchor, CommentTargetType } from '../../api/queries/comments';
import { useTranslation } from '../../hooks/useTranslation';
import { quoteExcerpt, type AnchorState } from './commentAnchors';

export default function AnchorQuote({ anchor, state, targetType, onJump }: {
    anchor: CommentAnchor | null;
    state: AnchorState;
    targetType: CommentTargetType;
    /** Scroll the item to the passage; absent for a preview that cannot jump. */
    onJump?: () => void;
}) {
    const { t } = useTranslation();
    if (state === 'unreadable') {
        return (
            <p className="m-0 flex items-center gap-1.5 text-[12px] italic text-[var(--text-tertiary)]" data-testid="comment-anchor-unreadable">
                <Unlink className="w-3.5 h-3.5 flex-shrink-0" aria-hidden="true" />
                {t('comments.anchor_unreadable', 'The passage of this thread could not be read.')}
            </p>
        );
    }
    if (!anchor || state === 'whole') {
        return (
            <p className="m-0 flex items-center gap-1.5 text-[12px] text-[var(--text-tertiary)]" data-testid="comment-anchor-whole">
                <FileText className="w-3.5 h-3.5 flex-shrink-0" aria-hidden="true" />
                {targetType === 'notebook'
                    ? t('comments.anchor_whole_notebook', 'On the whole notebook')
                    : t('comments.anchor_whole_document', 'On the whole document')}
            </p>
        );
    }
    const outdated = state === 'outdated';
    const quote = (
        <span className={`block border-l-2 pl-2 text-[12.5px] leading-snug line-clamp-3 ${outdated
            ? 'border-[var(--border-default)] text-[var(--text-tertiary)] line-through decoration-[var(--text-tertiary)]'
            : 'border-[var(--accent-primary)] text-[var(--text-secondary)]'}`}>
            {quoteExcerpt(anchor.quote)}
        </span>
    );
    return (
        <div className="flex flex-col gap-1" data-testid="comment-anchor" data-state={state}>
            {onJump && !outdated ? (
                <button type="button" onClick={onJump} className="text-left rounded-md hover:bg-[var(--item-hover-bg)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent-primary)]"
                    title={t('comments.jump_to_passage', 'Show this passage')}>
                    <span className="sr-only">{t('comments.jump_to_passage', 'Show this passage')}: </span>
                    {quote}
                </button>
            ) : quote}
            {outdated && (
                <span className="flex items-center gap-1 text-[11px] text-[var(--text-tertiary)]" data-testid="comment-anchor-outdated">
                    <TextQuote className="w-3 h-3" aria-hidden="true" />
                    {t('comments.anchor_outdated', 'This passage was changed or removed.')}
                </span>
            )}
        </div>
    );
}
