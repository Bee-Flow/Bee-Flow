import { useRef, type Dispatch, type SetStateAction } from 'react';
import { fetchAgentConversation } from '../api/queries/hubDataFetches';
import { loadWorkspaceNotebook } from '../api/workspaceNotebook';
import type { ChatMessage } from '../hooks/useChatEngine/types';
import { API_BASE } from '../utils/helpers';
import { hasRenderableContent, normalizeLoadedMessages, type ShapedMessage } from '../utils/messageShape';
import { updateAgentUrl } from './hubUrl';
import type { IdRef } from './useAgentHubData.types';

interface SelectConversationArgs {
    setCurrentConversation: Dispatch<SetStateAction<IdRef | null>>;
    setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
    setNotebookContent: Dispatch<SetStateAction<string>>;
    setShowNotebook: Dispatch<SetStateAction<boolean>>;
    setNotebookLinkedId: Dispatch<SetStateAction<string | null>>;
    /** Open the loaded conversation at its latest message (BFSF-453). */
    openAtLatest: () => void;
}

/**
 * Open one agent conversation: the conversation GET, its notebook, then the
 * cleaned messages. Owns the generation counter that keeps a slow answer for
 * an earlier click from landing on top of a later one.
 */
export default function useSelectConversation({
    setCurrentConversation, setMessages, setNotebookContent, setShowNotebook, setNotebookLinkedId, openAtLatest,
}: SelectConversationArgs) {
    // Generation counter for selectConversation — same guard as
    // NotebooksPage.selectNotebook. Two sequential awaits (the conversation
    // GET, then the workspace GET) mean a slow response for conversation A can
    // land AFTER the user has already clicked B, and every setter below then
    // re-applies A on top of B: the messages, the URL, the notebook pane and
    // the sidebar highlight (which derives from currentConversation). The click
    // on B is silently lost, and the next send — plus saveNotebook's PUT —
    // goes to whichever id won the race. Every write is gated on still being
    // the newest selection.
    const selectConvGenRef = useRef(0);

    // Load Messages when Conversation Selected
    const selectConversation = async (agentId: string, convId: string) => {
        const gen = ++selectConvGenRef.current;
        const isStale = () => selectConvGenRef.current !== gen;
        try {
            const res = await fetchAgentConversation(agentId, convId);
            if (isStale()) return;
            if (res.ok) {
                const data = await res.json();
                if (isStale()) return;
                setCurrentConversation(data);
                updateAgentUrl(agentId, data.id);

                // Fetch notebook content — always swap to match the selected conversation
                if (agentId && data.id) {
                    // The setters are wrapped rather than checked afterwards:
                    // loadWorkspaceNotebook applies them itself, so this is the
                    // only place a newer selection can be honoured.
                    await loadWorkspaceNotebook(
                        `${API_BASE}/agents/${agentId}/conversations/${data.id}/workspace`,
                        {
                            setNotebookLinkedId: (v) => { if (!isStale()) setNotebookLinkedId(v); },
                            setNotebookContent: (v) => { if (!isStale()) setNotebookContent(v); },
                            setShowNotebook: (v) => { if (!isStale()) setShowNotebook(v); },
                        },
                        { logLabel: 'Failed to fetch notebook' },
                    );
                    if (isStale()) return;
                }
                let parsedMessages: (ChatMessage & ShapedMessage)[] = [];
                if (typeof data.messages === 'string') {
                    parsedMessages = JSON.parse(data.messages);
                } else {
                    parsedMessages = data.messages || [];
                }

                // Canonicalise FIRST: normalizeLoadedMessages flattens block content
                // to text (BFSF-307), so everything below can assume a string.
                parsedMessages = normalizeLoadedMessages<ChatMessage & ShapedMessage>(parsedMessages);

                // Filter out tool messages and empty messages - only show user and assistant with content
                // `system` is dropped too: chatStream injects a tool-loop nudge as a
                // system turn, and MessageItem only special-cases user/tool, so a
                // persisted system row renders as an assistant bubble.
                parsedMessages = parsedMessages.filter(m =>
                    m.role !== 'tool' && m.role !== 'system' && hasRenderableContent(m)
                );

                // Strip streaming-only progress fields — these are only relevant during live chat
                parsedMessages = parsedMessages.map(m => {
                    const { toolCall, isStreaming, ...clean } = m;
                    // Strip raw tool-call JSON blocks from content (e.g. { "action": "generate_image", ... })
                    if (clean.content && typeof clean.content === 'string' && clean.role === 'assistant') {
                        clean.content = clean.content.replace(/\{\s*"action":\s*"[^"]*"\s*,\s*"action_input":\s*"[^"]*"(?:\s*\}\s*,\s*"thought":\s*"[^"]*"\s*\}|\s*\})/g, '').trim();
                    }
                    return clean;
                });


                // Remove messages that became empty after cleanup
                parsedMessages = parsedMessages.filter(m => m.role === 'user' || hasRenderableContent(m));
                if (isStale()) return;
                // A loaded conversation opens at its latest message (BFSF-453).
                openAtLatest();
                setMessages(parsedMessages);
            }
        } catch (err) {
            console.error("Failed to load conversation", err);
        }
    };

    return selectConversation;
}
