/**
 * Renders the reviewed message in the same chat-bubble shell the user just
 * typed it into (MessageItem/index.jsx's user-bubble classes), so the
 * review reads as "your message, annotated" rather than an abstract report.
 */
import React from 'react';
import DlpHighlightedText from './DlpHighlightedText';
import type { AddSpanHandler, DlpSpan, RemoveSpanHandler } from './dlpFindingsState';

interface DlpChatTextRendererProps {
    text: string;
    spans: DlpSpan[];
    onAddSpan?: AddSpanHandler;
    onRemoveSpan?: RemoveSpanHandler;
}

export default function DlpChatTextRenderer({ text, spans, onAddSpan, onRemoveSpan }: DlpChatTextRendererProps) {
    return (
        <div className="flex justify-end">
            <div
                className="max-w-[85%] rounded-2xl rounded-br-none p-4 bg-[var(--user-bubble-bg)] text-[var(--user-bubble-fg)]"
                /* C10 — dezelfde twee tokens als de bubbel in het gesprek, en
                   net als daar zonder hex-noodwaarde: index.css declareert ze
                   voor alle acht thema's, dus een vaste grijstint hier zou de
                   revisie in een ander thema zetten dan het bericht zelf. */
            >
                <DlpHighlightedText text={text} spans={spans} onAddSpan={onAddSpan} onRemoveSpan={onRemoveSpan} />
            </div>
        </div>
    );
}
