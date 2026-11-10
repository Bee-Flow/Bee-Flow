import type React from 'react';
import { Send } from 'lucide-react';
import { INPUT_FIELD } from '../admin/Studio/SupportStudio/supportStyles';
import { PRIMARY_BTN } from '../mcpLibrary/ui';
import { useTranslation } from '../../hooks/useTranslation';
import type { useSupportReplyComposer } from './useSupportInboxActions';

/** The reply box under the conversation, with the canned-response picker and the internal-note switch. */
export default function SupportReplyComposer({ composer }: { composer: ReturnType<typeof useSupportReplyComposer> }) {
    const { t } = useTranslation();
    const { reply, setReply, internalNote, setInternalNote, sending, cannedResponses, showCanned, setShowCanned, sendReply, insertCanned } = composer;
    return (
        <div className="border-t p-3 relative border-[var(--border-default)]">
            {showCanned && cannedResponses.length > 0 && (
                <div className="absolute bottom-full left-3 right-3 mb-1 max-h-56 overflow-y-auto rounded-md border shadow-lg z-10 bg-[var(--bg-card)] border-[var(--border-default)]">
                    {cannedResponses.map(c => (
                        <button key={c.id} onClick={() => insertCanned(c)}
                            className="w-full text-left px-3 py-2 border-b hover:bg-[var(--bg-tertiary)] text-sm border-[var(--border-default)] text-[var(--text-primary)]">
                            <div className="font-medium flex items-center gap-2">{c.title}{c.shortcut && <span className="text-xs text-[var(--text-tertiary)] hover:text-[var(--text-primary)]">{c.shortcut}</span>}</div>
                            <div className="text-xs line-clamp-1 text-[var(--text-tertiary)]">{c.body}</div>
                        </button>
                    ))}
                </div>
            )}
            <textarea
                rows={3}
                value={reply}
                onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setReply(e.target.value)}
                onKeyDown={(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
                    // Open the canned picker when "/" is typed on an empty line.
                    if (e.key === '/' && !reply.trim()) setShowCanned(true);
                    if (e.key === 'Escape') setShowCanned(false);
                }}
                placeholder={internalNote ? t('support.inbox_composer_note_placeholder', 'Internal note (only visible to staff)…') : t('support.inbox_composer_reply_placeholder', 'Reply to the customer…  (type / for templates)')}
                className={`${INPUT_FIELD} resize-y`}
            />
            <div className="mt-2 flex items-center justify-between">
                <div className="flex items-center gap-3">
                <label className="text-xs flex items-center gap-1.5 text-[var(--text-secondary)]">
                    <input type="checkbox" className="accent-[var(--accent-primary)]" checked={internalNote} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInternalNote(e.target.checked)} />
                    {t('support.support_inbox_internal_note_2', 'Internal note')}
                </label>
                {cannedResponses.length > 0 && (
                    <button onClick={() => setShowCanned(v => !v)} className="text-xs text-[var(--text-tertiary)] hover:text-[var(--text-primary)]">{t('support.support_inbox_templates', 'Templates')}</button>
                )}
                </div>
                <button
                    onClick={sendReply}
                    disabled={sending || !reply.trim()}
                    className={PRIMARY_BTN}
                >
                    <Send className="w-3.5 h-3.5" /> {sending ? t('support.inbox_composer_sending', 'Sending…') : (internalNote ? t('support.inbox_composer_save_note', 'Save note') : t('support.inbox_composer_send_reply', 'Send reply'))}
                </button>
            </div>
        </div>
    );
}
