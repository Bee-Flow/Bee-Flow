import React, { useState } from 'react';
import { Loader2, Tag, X } from 'lucide-react';
import useTranslation from '../../../hooks/useTranslation';

/**
 * The note's tag chips with add/remove (Meeting Notes artboard 1a, line 52:
 * `dataweging · spelersmonitor · … · + tag`). Lived inside MeetingHeader
 * until the header became the shared 48px StudioSectionHeader, which has no
 * second row; the artboard draws the tags at the top of the content column.
 */
export default function TagRow({ tags = [], canEdit = false, onAddTag, onRemoveTag, busy = false }) {
    const { t } = useTranslation();
    const [draft, setDraft] = useState('');
    const [showInput, setShowInput] = useState(false);

    const commit = () => {
        const next = draft.trim();
        if (next && !tags.includes(next)) onAddTag?.(next);
        setDraft('');
        setShowInput(false);
    };

    return (
        <div className="flex flex-wrap items-center gap-1 text-[11px]" data-testid="meeting-tags">
            {tags.map((tag) => (
                <span
                    key={tag}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border"
                    style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-default)', color: 'var(--text-secondary)' }}
                >
                    {tag}
                    {canEdit && (
                        <button
                            type="button"
                            onClick={() => onRemoveTag?.(tag)}
                            aria-label={t('meetings.remove_tag', 'Remove tag {tag}', { tag })}
                            className="opacity-60 hover:opacity-100"
                        >
                            <X className="w-3 h-3" aria-hidden="true" />
                        </button>
                    )}
                </span>
            ))}
            {showInput ? (
                <input
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={() => { setShowInput(false); setDraft(''); }}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') { e.preventDefault(); commit(); }
                        if (e.key === 'Escape') { setShowInput(false); setDraft(''); }
                    }}
                    autoFocus
                    placeholder={t('meetings.add_tag_placeholder', 'Add tag…')}
                    aria-label={t('meetings.add_tag', 'Add tag')}
                    className="px-2 py-0.5 rounded-full border outline-none"
                    style={{ background: 'var(--bg-card)', borderColor: 'var(--border-default)', color: 'var(--text-primary)' }}
                />
            ) : (
                canEdit && (
                    <button
                        type="button"
                        onClick={() => setShowInput(true)}
                        className="px-2 py-0.5 rounded-full border border-dashed inline-flex items-center gap-1 hover:bg-[var(--bg-tertiary)] transition-colors"
                        style={{ borderColor: 'var(--border-default)', color: 'var(--text-tertiary)' }}
                    >
                        <Tag className="w-3 h-3" aria-hidden="true" />
                        {t('meetings.add_tag', 'Add tag')}
                    </button>
                )
            )}
            {busy && <Loader2 className="w-3.5 h-3.5 animate-spin ml-1" style={{ color: 'var(--text-tertiary)' }} aria-hidden="true" />}
        </div>
    );
}
