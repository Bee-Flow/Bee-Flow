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
                /* C10: the same two tokens as the bubble in the conversation, and
                   just as there, without a hex fallback: index.css declares them
                   for all eight themes, so a fixed grey here would put the revision
                   in a different theme than the message itself. */
            >
                <DlpHighlightedText text={text} spans={spans} onAddSpan={onAddSpan} onRemoveSpan={onRemoveSpan} />
            </div>
        </div>
    );
}
