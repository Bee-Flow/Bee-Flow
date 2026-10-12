// The conversation of the assistant panel: the empty state with its
// suggestions, the bubbles, the "Changed N cells · Undo" line, the busy line.

import { Loader2, Sparkles, Undo2 } from 'lucide-react';
import React, { useEffect, useRef } from 'react';
import type { ModelTierMap } from '../../../api/queries/modelTiers';
import { tierI18nKey, tierLabel } from '../../../components/licensing/tierMeta';
import MarkdownRenderer from '../../../components/renderers/MarkdownRenderer';
import useTranslation, { type TranslateFn } from '../../../hooks/useTranslation';
import type { AssistantMessage } from './useSheetAssistant';

const CHIP = 'px-3 py-1.5 rounded-full text-[12px] text-left border border-[var(--border-default)] bg-[var(--bg-primary)] text-[var(--text-primary)] hover:bg-[var(--item-hover-bg)] disabled:opacity-50 transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent-primary)]';

/** "Auto · Think" when auto was asked and the server picked, else the tier asked for. */
export function answeredBy(msg: AssistantMessage, tiers: ModelTierMap, t: TranslateFn): string | null {
    const asked = msg.requestedTier;
    if (!asked) return null;
    const label = (key: string) => t(tierI18nKey(key), tierLabel(key, tiers));
    if (asked === 'auto' && msg.tier && msg.tier !== 'auto') return `${label('auto')} · ${label(msg.tier)}`;
    return label(asked === 'auto' ? 'auto' : (msg.tier || asked));
}

export function Suggestions({ onPick, disabled }: { onPick: (text: string) => void; disabled: boolean }) {
    const { t } = useTranslation();
    const items = [
        t('spreadsheet.assistant.chip_summarise', 'Summarise this sheet'),
        t('spreadsheet.assistant.chip_total', 'Add a total row'),
        t('spreadsheet.assistant.chip_errors', 'Find and fix errors'),
        t('spreadsheet.assistant.chip_explain', 'Explain the selected formula'),
    ];
    return (
        <div className="flex flex-col items-start gap-3 p-4" data-testid="assistant-empty">
            <span className="inline-flex items-center justify-center w-9 h-9 rounded-xl bg-[color-mix(in_srgb,var(--accent-primary)_14%,transparent)] text-[var(--accent-primary)]">
                <Sparkles size={18} aria-hidden="true" />
            </span>
            <div>
                <h3 className="m-0 text-[14px] font-semibold text-[var(--text-primary)]">{t('spreadsheet.assistant.empty_title', 'Ask about this sheet')}</h3>
                <p className="m-0 mt-1 text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
                    {t('spreadsheet.assistant.empty_hint', 'I can read your cells, explain formulas, and make the changes you ask for.')}
                </p>
            </div>
            <div className="flex flex-wrap gap-2">
                {items.map((text) => <button key={text} type="button" className={CHIP} disabled={disabled} onClick={() => onPick(text)}>{text}</button>)}
            </div>
        </div>
    );
}

interface MessageProps { msg: AssistantMessage; tiers: ModelTierMap; readOnly: boolean; onUndo: (id: number) => void }

function Bubble({ msg, tiers, onUndo }: MessageProps) {
    const { t } = useTranslation();
    if (msg.role === 'user') {
        return (
            <div className="flex justify-end">
                <p className="m-0 max-w-[85%] px-3 py-2 rounded-2xl rounded-br-md text-[13px] leading-relaxed whitespace-pre-wrap break-words bg-[var(--accent-primary)] text-[var(--accent-primary-fg)]">{msg.content}</p>
            </div>
        );
    }
    if (msg.error) {
        return <p role="alert" className="m-0 px-3 py-2 rounded-xl text-[12.5px] leading-relaxed break-words bg-[var(--bg-primary)] border border-[var(--border-default)] text-[var(--error)]">{msg.content}</p>;
    }
    const count = Object.keys(msg.changes ?? {}).length;
    const by = answeredBy(msg, tiers, t);
    return (
        <div className="flex flex-col gap-1.5 text-[13px] leading-relaxed text-[var(--text-primary)] break-words" data-testid="assistant-reply">
            <MarkdownRenderer content={msg.content} />
            {count > 0 && (
                <div className="flex items-center gap-2 text-[12px] text-[var(--text-secondary)]" data-testid="assistant-changes">
                    <span>{count === 1 ? t('spreadsheet.assistant.changed_one', 'Changed 1 cell') : t('spreadsheet.assistant.changed_other', 'Changed {count} cells', { count })}</span>
                    <span aria-hidden="true">·</span>
                    {msg.undone
                        ? <span>{t('spreadsheet.assistant.undone', 'Undone')}</span>
                        : (
                            <button type="button" onClick={() => onUndo(msg.id)} className="inline-flex items-center gap-1 font-medium text-[var(--accent-primary)] hover:underline">
                                <Undo2 size={12} aria-hidden="true" />{t('spreadsheet.assistant.undo', 'Undo')}
                            </button>
                        )}
                </div>
            )}
            {by && <span className="text-[11px] text-[var(--text-tertiary)]" data-testid="assistant-tier">{by}</span>}
        </div>
    );
}

export default function SheetAssistantMessages({ messages, busy, onStop, ...rest }: {
    messages: AssistantMessage[]; busy: boolean; onStop: () => void; tiers: ModelTierMap; readOnly: boolean; onUndo: (id: number) => void;
}) {
    const { t } = useTranslation();
    const end = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const el = end.current?.parentElement;
        if (el) el.scrollTop = el.scrollHeight;
    }, [messages.length, busy]);
    return (
        <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar flex flex-col gap-3 p-3" role="log" aria-label={t('spreadsheet.assistant.conversation', 'Conversation')}>
            {messages.map((msg) => <Bubble key={msg.id} msg={msg} {...rest} />)}
            {busy && (
                <div className="flex items-center gap-2 text-[12.5px] text-[var(--text-secondary)]" role="status" data-testid="assistant-busy">
                    <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                    <span className="flex-1">{t('spreadsheet.assistant.working', 'Working on your sheet…')}</span>
                    <button type="button" onClick={onStop} className="px-2 py-0.5 rounded-lg text-[12px] font-medium bg-[var(--bg-tertiary)] text-[var(--text-primary)] hover:bg-[var(--item-hover-bg)]">
                        {t('spreadsheet.assistant.stop', 'Stop')}
                    </button>
                </div>
            )}
            <div ref={end} />
        </div>
    );
}
