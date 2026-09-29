import React, { useEffect, useState } from 'react';
import useDocumentText from './useDocumentText';

/**
 * The outline of a presentation, as text.
 *
 * A presentation document keeps its slides as the deck grammar (server:
 * core/documents/deckModel.js) — one "## " per slide, bullets, "### " cards,
 * ```chart / ```stats blocks — and this is where a person types it. It is a
 * plain textarea on purpose: the outline is small, the grammar is a dozen
 * lines, and the slides themselves are drawn beside it by the canvas from
 * the server's own renderer, so there is nothing a richer editor could show
 * that the preview does not already.
 *
 * The parent owns persistence (the same debounced autosave the page editor
 * has) and the live preview; this component only reports text.
 */
export default function DeckOutlineEditor({ value, epoch = 0, onChange, disabled = false }) {
    const d = useDocumentText();
    const [text, setText] = useState(value || '');
    // An outside change (the assistant rewrote the outline, a version was
    // restored) replaces what is shown — signalled by `epoch`, never by
    // `value` alone: every autosave echoes the outline back through `value`,
    // and adopting that echo would overwrite whatever was typed since.
    const [seenEpoch, setSeenEpoch] = useState(epoch);
    if (seenEpoch !== epoch) {
        setSeenEpoch(epoch);
        setText(value || '');
    }

    const rows = [
        ['# Title', d('cover title (once)', 'titel van het voorblad (één keer)')],
        ['## Heading', d('one slide per heading', 'één slide per kop')],
        ['- point', d('bullets; two spaces = sub-point', 'opsomming; twee spaties = subpunt')],
        ['### Card {icon: rocket}', d('2–6 cards per slide, with a Lucide icon', '2–6 kaarten per slide, met een Lucide-icoon')],
        ['```chart … ```', d('type: bar · labels: Q1, Q2 · Revenue: 10, 20', 'type: bar · labels: Q1, Q2 · Omzet: 10, 20')],
        ['```stats … ```', d('one KPI tile per line: value | label | delta', 'één KPI-tegel per regel: waarde | label | delta')],
        ['| a | b |', d('a table (also as a chart: <!-- chart: bar -->)', 'een tabel (ook als grafiek: <!-- chart: bar -->)')],
        ['> quote / > — name', d('a quote slide', 'een citaatslide')],
        ['<!-- layout: timeline -->', d('bullets as steps; also closing, cards', 'opsomming als stappen; ook closing, cards')],
        ['<!-- style: accent -->', d('an emphasis slide (or dark)', 'een accentslide (of dark)')],
        ['Notes: …', d('speaker notes for the slide', 'sprekersnotities bij de slide')],
        ['{{customer.name}}', d('a placeholder a routine fills', 'een veld dat een routine invult')],
    ];

    return (
        <div className="flex flex-col h-full min-h-0" data-testid="deck-outline-editor">
            <details className="shrink-0 px-3 py-2 text-xs" style={{ borderBottom: '1px solid var(--border-subtle)', color: 'var(--text-muted)' }}>
                <summary className="cursor-pointer select-none">{d('How to write slides', 'Zo schrijf je slides')}</summary>
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 mt-2">
                    {rows.map(([code, text]) => (
                        <React.Fragment key={code}>
                            <dt><code className="font-mono" style={{ color: 'var(--text-primary)' }}>{code}</code></dt>
                            <dd className="m-0">{text}</dd>
                        </React.Fragment>
                    ))}
                </dl>
            </details>
            <textarea
                className="flex-1 min-h-0 w-full resize-none p-3 font-mono text-[13px] leading-relaxed outline-none"
                style={{ background: 'var(--bg-primary)', color: 'var(--text-primary)', border: 0 }}
                value={text}
                disabled={disabled}
                spellCheck={false}
                aria-label={d('Slide outline', 'Slide-outline')}
                placeholder={'# ' + d('Title', 'Titel') + '\n\n## ' + d('First slide', 'Eerste slide') + '\n- ' + d('a point', 'een punt') + '\n'}
                onChange={(e) => { setText(e.target.value); onChange?.(e.target.value); }}
                data-testid="deck-outline"
            />
        </div>
    );
}
