// The composer of the assistant panel: the question, the depth slider (the
// same control as a chat), the selection that travels with the question.

import { SendHorizontal } from 'lucide-react';
import React, { useState } from 'react';
import TierSlider from '../../../components/licensing/TierSlider';
import useTranslation from '../../../hooks/useTranslation';
import type { AssistantTier } from './useAssistantTier';

export interface SheetAssistantComposerProps {
    selection: string | null;
    tier: AssistantTier | null;
    busy: boolean;
    readOnly: boolean;
    onSend: (text: string) => void;
}

export default function SheetAssistantComposer({ selection, tier, busy, readOnly, onSend }: SheetAssistantComposerProps) {
    const { t } = useTranslation();
    const [text, setText] = useState('');
    const empty = !text.trim();
    const submit = () => {
        if (empty || busy) return;
        onSend(text);
        setText('');
    };
    const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
        e.preventDefault();
        submit();
    };
    return (
        <div className="shrink-0 p-3 border-t border-[var(--border-subtle)]">
            <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-primary)] focus-within:border-[var(--accent-primary)] transition">
                <textarea
                    value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKeyDown}
                    rows={2} maxLength={4000}
                    aria-label={t('spreadsheet.assistant.input_label', 'Message to the assistant')}
                    placeholder={readOnly
                        ? t('spreadsheet.assistant.placeholder_read_only', 'Ask a question about this sheet')
                        : t('spreadsheet.assistant.placeholder', 'Ask a question or describe a change')}
                    className="block w-full resize-none bg-transparent px-3 pt-2.5 pb-1 text-[13px] leading-relaxed text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] outline-none"
                />
                <div className="flex items-center gap-2 px-2 pb-2">
                    <span className="flex-1 min-w-0 truncate pl-1 text-[11px] text-[var(--text-secondary)]" data-testid="assistant-selection">
                        {selection ? t('spreadsheet.assistant.selection', 'Selection: {range}', { range: selection }) : t('spreadsheet.assistant.hint', 'Enter to send, Shift+Enter for a new line')}
                    </span>
                    {tier && <TierSlider tiers={tier.tiers} value={tier.value} onChange={tier.onChange} variant="input" />}
                    <button
                        type="button" onClick={submit} disabled={empty || busy}
                        aria-label={t('spreadsheet.assistant.send', 'Send')} title={t('spreadsheet.assistant.send', 'Send')}
                        className="inline-flex items-center justify-center w-8 h-8 rounded-lg shrink-0 bg-[var(--accent-primary)] text-[var(--accent-primary-fg)] disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent-primary)]"
                    >
                        <SendHorizontal size={14} aria-hidden="true" />
                    </button>
                </div>
            </div>
        </div>
    );
}
