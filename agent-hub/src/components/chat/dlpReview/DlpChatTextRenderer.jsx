/**
 * Renders the reviewed message in the same chat-bubble shell the user just
 * typed it into (MessageItem/index.jsx's user-bubble classes), so the
 * review reads as "your message, annotated" rather than an abstract report.
 */
import React from 'react';
import DlpHighlightedText from './DlpHighlightedText';

export default function DlpChatTextRenderer({ text, spans, onAddSpan, onRemoveSpan }) {
    return (
        <div className="flex justify-end">
            <div
                className="max-w-[85%] rounded-2xl rounded-br-none p-4"
                /* C10 — dezelfde twee tokens als de bubbel in het gesprek, en
                   net als daar zonder hex-noodwaarde: index.css declareert ze
                   voor alle acht thema's, dus een vaste grijstint hier zou de
                   revisie in een ander thema zetten dan het bericht zelf. */
                style={{ background: 'var(--user-bubble-bg)', color: 'var(--user-bubble-fg)' }}
            >
                <DlpHighlightedText text={text} spans={spans} onAddSpan={onAddSpan} onRemoveSpan={onRemoveSpan} />
            </div>
        </div>
    );
}
