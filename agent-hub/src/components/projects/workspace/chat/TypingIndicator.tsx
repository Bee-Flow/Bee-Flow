// The line under a team chat's messages that says who is busy: the AI
// answering, colleagues typing. Nothing at all when nobody is.

import { Loader2 } from 'lucide-react';
import React from 'react';
import { useTranslation, type TranslateFn } from '../../../../hooks/useTranslation';

export function typingSentence(names: string[], t: TranslateFn): string {
    if (!names.length) return '';
    if (names.length === 1) return t('project_chat.typing_one', '{name} is typing…', { name: names[0] });
    if (names.length === 2) return t('project_chat.typing_two', '{first} and {second} are typing…', { first: names[0], second: names[1] });
    return t('project_chat.typing_many', 'Several people are typing…');
}

export default function TypingIndicator({ names, aiAnswering, aiName }: { names: string[]; aiAnswering: boolean; aiName: string }) {
    const { t } = useTranslation();
    const typing = typingSentence(names, t);
    // The live region stays mounted and only its content changes: a region that
    // arrives together with its text is skipped by many screen readers.
    const busy = !!typing || aiAnswering;
    return (
        <div className="h-6 flex-shrink-0 flex items-center gap-3 px-4 text-[12px] text-[var(--text-secondary)]" role="status" aria-live="polite"
            data-testid={busy ? 'team-chat-typing' : undefined}>
            {aiAnswering && (
                <span className="inline-flex items-center gap-1.5 text-[var(--accent-primary)]">
                    <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />
                    {t('project_chat.ai_answering_named', '{name} is answering…', { name: aiName })}
                </span>
            )}
            {typing && <span>{typing}</span>}
        </div>
    );
}
