import { useState, useRef, useEffect } from 'react';
import InputArea from '../components/chat/InputArea';
import { API_BASE } from '../utils/helpers';
import { applyEmbedCustomization } from './embed/embedCustomization';
import EmbedHeader from './embed/EmbedHeader';
import EmbedMessages from './embed/EmbedMessages';
import { EmbedError, EmbedLoading } from './embed/EmbedStates';
import { applyEmbedStreamEvent } from './embed/embedStreamEvents';
import { useEmbedAgent } from './embed/useEmbedAgent';
import { useEmbedAutoScroll } from './embed/useEmbedAutoScroll';
import EmbedMonitoringNotice from '../components/embed/EmbedMonitoringNotice';
import useEmbedVisitorState from '../components/embed/useEmbedVisitorState';
import type { EmbedAgent } from './embed/EmbedHeader';
import type { ComposerAttachment } from '../components/chat/InputArea/useFileIntake';
import type { ChatMessage } from '../hooks/useChatEngine/types';
import { logger } from '../utils/logger';
import { mutate, ApiError } from '../api/mutate';

const getInitialTheme = () => {
    // 1. Check URL param (?theme=light or ?theme=dark) — allows iframe embedder to control
    const params = new URLSearchParams(window.location.search);
    const urlTheme = params.get('theme');
    if (urlTheme === 'light' || urlTheme === 'dark') return urlTheme;
    // 2. Fall back to system preference
    if (window.matchMedia?.('(prefers-color-scheme: light)').matches) return 'light';
    return 'dark';
};

interface EmbedChatProps {
    agentId: string;
}

const EmbedChat = ({ agentId }: EmbedChatProps) => {
    const [theme, setTheme] = useState(getInitialTheme);
    const [agent, setAgent] = useState<EmbedAgent | null>(null);
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [isStreaming, setIsStreaming] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // What the embed payload decides for the visitor: whether the sources
    // behind an answer may be shown (closed unless the payload says yes), the
    // chat-signals notice and its marker, and "Don't count my messages"
    // (React state only). See useEmbedVisitorState.
    const visitor = useEmbedVisitorState();
    // InputArea expects input/setInput as controlled props.
    const [input, setInput] = useState('');
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const messagesContainerRef = useRef<HTMLDivElement>(null);
    const shouldForceScrollRef = useRef(false);

    // Apply theme to document
    useEffect(() => {
        document.documentElement.setAttribute('data-theme', theme);
    }, [theme]);

    // Read embed customization from URL params
    const urlParams = new URLSearchParams(window.location.search);
    const [customWarning] = useState(() => urlParams.get('warning') || '');

    // Apply font & color customization from URL params
    useEffect(() => {
        applyEmbedCustomization();
    }, []);

    const toggleTheme = () => setTheme(t => t === 'dark' ? 'light' : 'dark');

    // Fetch agent metadata
    useEmbedAgent(agentId, visitor.applyEmbedPayload, setAgent, setError, setIsLoading);

    // Smart auto-scroll: force on send, respect user scroll-back during streaming
    useEmbedAutoScroll(messages, messagesEndRef, messagesContainerRef, shouldForceScrollRef);

    const sendMessage = async (text: string, attachments: ComposerAttachment[] = []) => {
        if (!text.trim() || isStreaming) return;

        const msgId = `embed-${Date.now()}`;
        const assistantMsgId = `embed-${Date.now() + 1}`;

        const userDisplayText = text.trim();

        const agentMessage = userDisplayText;

        const userMessage = { id: msgId, role: 'user', content: userDisplayText, attachments };
        const assistantMessage = { id: assistantMsgId, role: 'assistant', content: '', isStreaming: true };

        setMessages(prev => [...prev, userMessage, assistantMessage]);
        setIsStreaming(true);

        try {
            let response: Response;
            try {
                response = await mutate(`${API_BASE}/agents/${agentId}/chat/stream`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message: agentMessage,
                    // Include full history WITH current message, since historyOverride
                    // replaces conversation messages entirely in the runtime
                    history: [
                        ...messages.map(m => ({ role: m.role, content: m.content })),
                        { role: 'user', content: agentMessage }
                    ],
                    attachments,
                    ephemeral: true,
                    // Announced equals counted: the marker exists only while the notice is up.
                    ...visitor.turnFields(),
                })
            });
            } catch (apiErr) {
                if (!(apiErr instanceof ApiError)) throw apiErr;
                throw new Error('Failed to send message');
            }

            const reader = (response.body as ReadableStream<Uint8Array>).getReader();
            const decoder = new TextDecoder();
            let assistantContent = '';
            let buffer = '';
            let currentEvent = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (line.startsWith('event: ')) {
                        currentEvent = line.slice(7).trim();
                    } else if (line.startsWith('data: ')) {
                        const dataStr = line.slice(6);
                        try {
                            const data = JSON.parse(dataStr);

                            assistantContent = applyEmbedStreamEvent(currentEvent, data, setMessages, msgId, assistantMsgId, assistantContent);
                        } catch (err) { logger.debug('partial or non-JSON stream line, skip', err); }
                    }
                }
            }
        } catch (err) {
            setMessages(prev => prev.map(m =>
                m.id === assistantMsgId ? { ...m, content: 'Sorry, something went wrong. Please try again.', isError: true } : m
            ));
        } finally {
            setIsStreaming(false);
            setMessages(prev => prev.map(m =>
                m.id === assistantMsgId ? { ...m, isStreaming: false } : m
            ));
        }
    };

    // Loading state
    if (isLoading) return <EmbedLoading />;

    // Error state
    if (error) return <EmbedError error={error} />;

    return (
        <div className="h-screen w-full flex flex-col bg-[var(--bg-primary)] overflow-hidden">
            {/* Minimal Header */}
            <EmbedHeader agent={agent as EmbedAgent} theme={theme} onToggleTheme={toggleTheme} />

            {/* Messages Area */}
            <EmbedMessages
                messages={messages}
                agent={agent as EmbedAgent}
                visitor={visitor}
                messagesContainerRef={messagesContainerRef}
                messagesEndRef={messagesEndRef}
                onStarterSend={(text) => { shouldForceScrollRef.current = true; sendMessage(text); }}
            />

            {messages.length > 0 && (
                <EmbedMonitoringNotice notice={visitor.notice} dontCount={visitor.dontCount} onDontCountChange={visitor.setDontCount} compact />
            )}

            {/* Input Area - same as main app */}
            <InputArea
                onSendMessage={(text: string, attachments: ComposerAttachment[]) => { shouldForceScrollRef.current = true; sendMessage(text, attachments); }}
                isLoading={isStreaming}
                selectedAgent={agent}
                warningText={customWarning}
                input={input}
                setInput={setInput}
            />
        </div>
    );
};

export default EmbedChat;
