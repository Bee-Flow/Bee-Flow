import React from 'react';

/**
 * The empty-chat container inside the messages scroller of DirectChatView and
 * AgentChatView: the welcome heading, the composer and the suggestions under
 * it, centred when they fit (BFSF-281).
 *
 * When the on-screen keyboard opens, the app shell shrinks to the visible
 * viewport (useAppHeight), so on a phone this block is often taller than the
 * scroller. It therefore has to GROW with its content, never be clamped to it:
 *   - `min-h-full`, not `h-full`: a fixed-height flex column centres its
 *     content by overflowing it at both ends, and the part above the scroller's
 *     top cannot be scrolled to. That was the composer's typing area.
 *   - `justify-center-safe`: centres while it fits, starts at the top when it
 *     does not (browsers without `safe` fall back to flex-start, also fine).
 *   - no negative top margin: a negative margin at the start of a scroll
 *     container clips just the same. `pb-10` gives the same optical lift.
 */
export const EMPTY_CHAT_STATE_CLASS = 'flex flex-col min-h-full items-center justify-center-safe pb-10';

export default function EmptyChatState({ children }: { children: React.ReactNode }) {
    return (
        <div className={EMPTY_CHAT_STATE_CLASS} data-testid="empty-chat-state">
            {children}
        </div>
    );
}
