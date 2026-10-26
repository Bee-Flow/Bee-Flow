// Browser-URL sync for the hub: the address mirrors the selected agent and
// conversation. Uses the first 8 characters of ids for short URLs.

/** /a/:agent/:conversation for an agent chat; "/" for no agent (unless a direct chat owns the URL). */
export function updateAgentUrl(agentId: string | null, conversationId: string | null): void {
    if (!agentId) {
        // Don't reset URL if in direct chat mode (handled by updateDirectChatUrl)
        if (!window.location.pathname.startsWith('/d/')) {
            window.history.replaceState({}, '', '/');
        }
        return;
    }
    const shortAgent = agentId.substring(0, 8);
    const path = conversationId
        ? `/a/${shortAgent}/${conversationId.substring(0, 8)}`
        : `/a/${shortAgent}`;
    window.history.replaceState({}, '', path);
}

/** /d/:conversation for a direct chat; "/" for none. */
export function updateDirectChatUrl(convId: string | null): void {
    if (!convId) {
        window.history.replaceState({}, '', '/');
        return;
    }
    window.history.replaceState({}, '', `/d/${convId.substring(0, 8)}`);
}

/**
 * Admin Theme Studio preview: when the iframe URL contains ?themePreview=1 it
 * may carry hints - `overlay=search` opens the search overlay, `sidebar=collapsed`
 * folds the conversation rail so a Settings/Studio preview reads cleaner
 * without the chat list dominating.
 */
export function themePreviewHints(): { openSearch: boolean; collapseSidebar: boolean } {
    try {
        const params = new URLSearchParams(window.location.search);
        if (params.get('themePreview') !== '1') return { openSearch: false, collapseSidebar: false };
        return { openSearch: params.get('overlay') === 'search', collapseSidebar: params.get('sidebar') === 'collapsed' };
    } catch {
        return { openSearch: false, collapseSidebar: false };
    }
}
