/**
 * The box itself: the text area, and the toolbar row under it.
 *
 * It is a `role="form"` DIV rather than a <form>, deliberately — Enter is
 * handled by the textarea (`handleKeyDown`) and a real form would also submit
 * on Enter from any other field inside it, which is how the attachment picker
 * once sent an empty message.
 *
 * The top corners square off when something is stacked above it — a thread
 * banner, attachments, active skill chips — so the two read as one panel
 * rather than two lids; that is the whole reason those four values are passed
 * in rather than a single flag: the condition stays where it can be read.
 *
 * The toolbar row is `justify-between` with exactly TWO children, `tools` and
 * `actions`. A third would be pushed to the middle of the composer, which is
 * where the apps picker ended up floating once Cowork mode added the schedule
 * chips — so both sides arrive as one node each.
 */
import React from 'react';

import useTranslation from '../../../hooks/useTranslation';

const ComposerBox = ({
    compact,
    isMobile,
    activeThreadParent,
    attachments,
    activeSkillIds,
    agentAttachedSkillIds,
    isDragOver,
    fileInputRef,
    handleFileSelect,
    textareaRef,
    input,
    setInput,
    handleKeyDown,
    handlePaste,
    composerPlaceholder,
    tools,
    actions,
}) => {
    const { t } = useTranslation();

    return (
        <div role="form" aria-label={t('chat.composer.form_label', 'Chat message input')} data-testid="chat-input-form" data-cowork-mode="chat" data-tour="chat-composer" className={`chat-composer relative flex flex-col transition-all focus-within:ring-2 focus-within:ring-[var(--accent-primary)]/35 ${compact ? 'rounded-xl border border-[var(--border-subtle)]' : 'rounded-2xl'} ${(activeThreadParent || attachments.length > 0 || activeSkillIds.length > 0 || agentAttachedSkillIds.length > 0) ? 'rounded-t-none' : ''} ${isDragOver ? 'ring-2 ring-[var(--accent-primary)]' : ''}`}>

            {/* Hidden file input */}
            <input
                type="file"
                ref={fileInputRef}
                onChange={handleFileSelect}
                multiple
                accept="image/*,.pdf,.docx,.csv,.xlsx,.xls,.txt,.md,.json,.js,.jsx,.ts,.tsx,.py,.html,.css"
                className="hidden"
                aria-label={t('chat.composer.upload_input_label', 'Upload file attachment')}
                data-testid="file-upload"
            />

            {/* Textarea Row */}
            <div className={`${compact ? 'px-3' : isMobile ? 'px-2' : 'px-4'} ${compact ? 'pt-2 pb-0.5' : 'pt-3 pb-1'}`}>
                <textarea
                    ref={textareaRef}
                    id="chat-message-input"
                    name="message"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={handleKeyDown}
                    onPaste={handlePaste}
                    placeholder={composerPlaceholder}
                    aria-label={t('chat.composer.textarea_label', 'Chat message')}
                    data-testid="chat-message-input"
                    rows={1}
                    className={`w-full max-h-[180px] bg-transparent border-none focus:ring-0 text-[var(--text-primary)] placeholder-[var(--text-muted)] resize-none outline-none ${compact ? 'py-1 text-[13.5px] leading-snug' : 'py-2 text-[15px] leading-relaxed'}`}
                />
            </div>

            {/* Toolbar Row */}
            <div className={`flex items-center justify-between gap-2 ${compact ? 'px-2 pb-2' : 'px-3 pb-3'}`}>
                {/* The Chat ⇄ Cowork switch itself lives in the page
                    header (CoworkModeToggle) — it sets the mode for
                    the whole conversation, not for one send. What
                    stays here is the part that IS per-brief: when it
                    runs and who runs it. */}
                {/* ONE left-hand group — the "+" menu and the pills.
                    The row is justify-between, so a third child
                    would be pushed to the middle, which is exactly
                    where the apps picker ended up floating once
                    Cowork mode added the schedule chips. Everything
                    that belongs on the left is inside this one
                    value; only the send cluster sits opposite. */}
                {tools}

                {actions}
            </div>
        </div>
    );
};

export default ComposerBox;
