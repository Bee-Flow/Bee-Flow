/**
 * The box every composer sits in, and the chat's own composer box built on it.
 *
 * `ComposerShell` is the frame: the `chat-composer` card (fill and shadow per
 * theme), the rounded corners and the accent focus ring. The chat composer, the
 * project team chat, its thread and the "start a conversation" form share it, so
 * the four read as one control.
 *
 * `ComposerBox` (the default export) is the chat's composer: a `role="form"` DIV
 * rather than a <form>, deliberately. Enter is handled by the textarea
 * (`handleKeyDown`) and a real form would also submit on Enter from any other
 * field inside it, which is how the attachment picker once sent an empty message.
 *
 * The top corners square off when something is stacked above it (a thread
 * banner, attachments, active skill chips) so the two read as one panel rather
 * than two lids; that is why those four values are passed in rather than a single
 * flag: the condition stays where it can be read.
 *
 * The toolbar row is `justify-between` with exactly TWO children, `tools` and
 * `actions`. A third would be pushed to the middle of the composer, which is
 * where the apps picker ended up floating once Cowork mode added the schedule
 * chips, so both sides arrive as one node each.
 */
import React from 'react';

import useTranslation from '../../hooks/useTranslation';

export interface ComposerShellProps {
    /** Smaller radius and a hairline border. */
    compact?: boolean;
    /** Squares the top corners: something is stacked right above. */
    squareTop?: boolean;
    isDragOver?: boolean;
    label: string;
    testId?: string;
    className?: string;
    children: React.ReactNode;
    [attr: string]: unknown;
}

export function ComposerShell({ compact = false, squareTop = false, isDragOver = false, label, testId = 'composer-box', className = '', children, ...rest }: ComposerShellProps) {
    return (
        <div role="form" aria-label={label} data-testid={testId} data-composer-shell="" {...rest}
            className={`chat-composer relative flex flex-col transition-all focus-within:ring-2 focus-within:ring-[var(--accent-primary)]/35 ${compact ? 'rounded-xl border border-[var(--border-subtle)]' : 'rounded-2xl'} ${squareTop ? 'rounded-t-none' : ''} ${isDragOver ? 'ring-2 ring-[var(--accent-primary)]' : ''} ${className}`}>
            {children}
        </div>
    );
}

interface ComposerBoxProps {
    compact?: boolean;
    isMobile?: boolean;
    activeThreadParent?: unknown;
    attachments: unknown[];
    activeSkillIds: unknown[];
    agentAttachedSkillIds: unknown[];
    isDragOver?: boolean;
    fileInputRef: React.Ref<HTMLInputElement>;
    handleFileSelect: React.ChangeEventHandler<HTMLInputElement>;
    textareaRef: React.Ref<HTMLTextAreaElement>;
    input: string;
    setInput: (value: string) => void;
    handleKeyDown: React.KeyboardEventHandler<HTMLTextAreaElement>;
    handlePaste: React.ClipboardEventHandler<HTMLTextAreaElement>;
    composerPlaceholder?: string;
    tools: React.ReactNode;
    actions: React.ReactNode;
}

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
}: ComposerBoxProps) => {
    const { t } = useTranslation();

    return (
        <ComposerShell
            compact={compact}
            squareTop={!!(activeThreadParent || attachments.length > 0 || activeSkillIds.length > 0 || agentAttachedSkillIds.length > 0)}
            isDragOver={isDragOver}
            label={t('chat.composer.form_label', 'Chat message input')}
            testId="chat-input-form" data-cowork-mode="chat" data-tour="chat-composer">

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

            {/* Toolbar Row. ONE left-hand group (the "+" menu and the pills) and
                the send cluster opposite: a third child would float in the middle. */}
            <div className={`flex items-center justify-between gap-2 ${compact ? 'px-2 pb-2' : 'px-3 pb-3'}`}>
                {tools}

                {actions}
            </div>
        </ComposerShell>
    );
};

export default ComposerBox;
