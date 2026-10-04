// The outline of a presentation, as text.
//
// A presentation keeps its slides as the deck grammar (server:
// core/documents/deckModel.js): one "## " per slide, bullets, "### " cards,
// ```chart / ```stats blocks. This is where a person types it; the slides are
// drawn beside it by the canvas from the server's own renderer, and the slide
// the caret is on is scrolled into view there (`onCaret`).
//
// The parent owns persistence and the live preview; this component only
// reports text and where the caret is.

import React, { useState } from 'react';
import useTranslation from '../../hooks/useTranslation';

export interface DeckOutlineEditorProps {
    value: string;
    /** An outside change (the assistant, a restore) replaces what is shown when this changes. */
    epoch?: string | number;
    onChange?: (text: string) => void;
    onCaret?: (text: string, caret: number) => void;
    disabled?: boolean;
}

function useGrammarRows(): Array<[string, string]> {
    const { t } = useTranslation();
    return [
        ['# Title', t('documents.deck.row_title', 'cover title (once)')],
        ['## Heading', t('documents.deck.row_slide', 'one slide per heading')],
        ['- point', t('documents.deck.row_bullet', 'bullets; two spaces = sub-point')],
        ['### Card {icon: rocket}', t('documents.deck.row_card', '2–6 cards per slide, with a Lucide icon')],
        ['```chart … ```', t('documents.deck.row_chart', 'type: bar · labels: Q1, Q2 · Revenue: 10, 20')],
        ['```stats … ```', t('documents.deck.row_stats', 'one KPI tile per line: value | label | delta')],
        ['| a | b |', t('documents.deck.row_table', 'a table (also as a chart: <!-- chart: bar -->)')],
        ['> quote / > — name', t('documents.deck.row_quote', 'a quote slide')],
        ['<!-- layout: timeline -->', t('documents.deck.row_layout', 'bullets as steps; also closing, cards')],
        ['<!-- style: accent -->', t('documents.deck.row_style', 'an emphasis slide (or dark)')],
        ['Notes: …', t('documents.deck.row_notes', 'speaker notes for the slide')],
        ['{{customer.name}}', t('documents.deck.row_placeholder', 'a placeholder an automation fills')],
    ];
}

export default function DeckOutlineEditor({ value, epoch = 0, onChange, onCaret, disabled = false }: DeckOutlineEditorProps) {
    const { t } = useTranslation();
    const rows = useGrammarRows();
    const [text, setText] = useState(value || '');
    // Adopt an outside change only when `epoch` moves, never on `value` alone:
    // every autosave echoes the outline back, and adopting that echo would
    // overwrite whatever was typed since.
    const [seenEpoch, setSeenEpoch] = useState(epoch);
    if (seenEpoch !== epoch) {
        setSeenEpoch(epoch);
        setText(value || '');
    }
    const caret = (el: HTMLTextAreaElement) => onCaret?.(el.value, el.selectionStart || 0);
    return (
        <div className="flex flex-col h-full min-h-0" data-testid="deck-outline-editor">
            <details className="shrink-0 px-3 py-2 text-xs border-b border-[var(--border-subtle)] text-[var(--text-tertiary)]">
                <summary className="cursor-pointer select-none">{t('documents.deck.how_to', 'How to write slides')}</summary>
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 mt-2">
                    {rows.map(([code, what]) => (
                        <React.Fragment key={code}>
                            <dt><code className="font-mono text-[var(--text-primary)]">{code}</code></dt>
                            <dd className="m-0">{what}</dd>
                        </React.Fragment>
                    ))}
                </dl>
            </details>
            <textarea
                className="flex-1 min-h-0 w-full resize-none p-3 font-mono text-[13px] leading-relaxed outline-none border-0 bg-[var(--bg-primary)] text-[var(--text-primary)]"
                value={text}
                disabled={disabled}
                spellCheck={false}
                aria-label={t('documents.deck.outline_label', 'Slide outline')}
                placeholder={`# ${t('documents.deck.placeholder_title', 'Title')}\n\n## ${t('documents.deck.placeholder_slide', 'First slide')}\n- ${t('documents.deck.placeholder_point', 'a point')}\n`}
                onChange={(e) => { setText(e.target.value); onChange?.(e.target.value); caret(e.target); }}
                onSelect={(e) => caret(e.currentTarget)}
                data-testid="deck-outline"
            />
        </div>
    );
}
