import { Send } from 'lucide-react';
import { resolveUrl } from './messageItemHelpers';
import useTranslation from '../../../hooks/useTranslation';

/**
 * Inline edit mode for user messages — replaces the bubble in place.
 * Lifted verbatim out of MessageItem/index.jsx; `editContent`, `isEditing` and
 * the textarea ref all still live in MessageItem and are threaded down.
 */
const UserEditComposer = ({
    msg,
    editContent,
    setEditContent,
    editTextareaRef,
    handleEditKeyDown,
    setIsEditing,
    submitEdit,
}) => {
    const { t } = useTranslation();
    return (
    <div className="max-w-[85%] w-full animate-fade-in">
        <div className="bg-[var(--bg-secondary)] rounded-2xl border border-[var(--border-subtle)] shadow-md focus-within:border-[var(--accent-primary)] focus-within:shadow-lg transition-all px-3 py-2">
            {msg.attachments && msg.attachments.length > 0 && (
                <div className="mb-2 flex flex-wrap gap-2">
                    {msg.attachments.map((att, i) => {
                        const isImage = att.type?.startsWith('image/');
                        const previewSrc = isImage ? (resolveUrl(att.url) || att.content) : null;
                        return (
                            <div key={i} className="rounded-lg overflow-hidden text-xs border bg-[var(--bg-primary)] border-[var(--border-subtle)] flex items-center gap-1.5 opacity-80">
                                {previewSrc && (
                                    <img src={previewSrc} alt={att.name} className="w-10 h-10 object-cover flex-shrink-0" />
                                )}
                                <div className="px-2 py-1.5 min-w-0">
                                    <span className="font-medium truncate block max-w-[200px] text-[var(--text-secondary)]">{att.name || t('chat.msg.attachment', 'Attachment')}</span>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
            <textarea
                ref={editTextareaRef}
                value={editContent}
                onChange={(e) => setEditContent(e.target.value)}
                onKeyDown={handleEditKeyDown}
                className="w-full max-h-[180px] bg-transparent border-none focus:ring-0 text-[var(--text-primary)] placeholder-[var(--text-tertiary)] resize-none py-2 text-[15px] leading-relaxed overflow-y-auto outline-none"
                rows={1}
                aria-label={t('chat.msg.edit_label', 'Edit your message')}
            />
        </div>
        <div className="flex items-center justify-end gap-2 mt-1.5">
            <button
                onClick={() => setIsEditing(false)}
                className="px-3 py-1 text-xs font-medium rounded-md text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] transition-colors"
            >
                {t('chat.msg.edit_cancel', 'Cancel')}
            </button>
            <button
                onClick={submitEdit}
                disabled={!editContent.trim()}
                className="px-3 py-1 text-xs font-semibold rounded-md bg-[var(--accent-primary)] text-white hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center gap-1.5"
            >
                <Send className="w-3 h-3" /> {t('chat.msg.edit_save', 'Save & Regenerate')}
            </button>
        </div>
    </div>
    );
};

export default UserEditComposer;
