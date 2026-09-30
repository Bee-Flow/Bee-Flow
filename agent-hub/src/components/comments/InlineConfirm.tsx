// "Delete this …?" asked in place, with Delete and Keep: nothing pops over
// the item being read.

import React from 'react';
import { useTranslation } from '../../hooks/useTranslation';
import { GhostButton, SecondaryButton } from '../projects/workspace/workspaceUi';

export default function InlineConfirm({ question, busy = false, onConfirm, onCancel }: {
    question: string;
    busy?: boolean;
    onConfirm: () => void;
    onCancel: () => void;
}) {
    const { t } = useTranslation();
    return (
        <div className="flex items-center gap-1.5 flex-wrap text-[12px] text-[var(--text-secondary)]" role="group" aria-label={question}>
            <span>{question}</span>
            <SecondaryButton onClick={onConfirm} busy={busy}>{t('comments.delete', 'Delete')}</SecondaryButton>
            <GhostButton onClick={onCancel}>{t('comments.keep', 'Keep')}</GhostButton>
        </div>
    );
}
