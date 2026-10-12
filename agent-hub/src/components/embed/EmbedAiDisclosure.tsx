import { Bot } from 'lucide-react';
import React from 'react';
import useTranslation from '../../hooks/useTranslation';

/**
 * "You are chatting with an AI assistant, not a person." (AI Act Art. 50(1)).
 *
 * Always on, whatever the organisation configured: a visitor on someone's
 * website has to know who answers before the first message, so it sits at
 * the top of the messages area in the empty state and stays above the
 * conversation afterwards.
 */
export default function EmbedAiDisclosure() {
    const { t } = useTranslation();
    return (
        <p
            role="note"
            data-testid="embed-ai-disclosure"
            className="mx-auto mb-3 flex w-fit max-w-full items-center gap-1.5 rounded-full border border-[var(--border-subtle)] bg-[var(--bg-secondary)] px-3 py-1 text-[11px] text-[var(--text-secondary)]"
        >
            <Bot className="h-3.5 w-3.5 shrink-0 text-[var(--text-tertiary)]" aria-hidden="true" />
            <span>{t('chat_monitoring.embed.ai_line', 'You are chatting with an AI assistant, not a person.')}</span>
        </p>
    );
}
