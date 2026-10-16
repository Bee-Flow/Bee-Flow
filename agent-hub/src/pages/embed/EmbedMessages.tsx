import React from 'react';
import type { RefObject } from 'react';
import MessageItem from '../../components/chat/MessageItem';
import EmbedAiDisclosure from '../../components/embed/EmbedAiDisclosure';
import EmbedMonitoringNotice from '../../components/embed/EmbedMonitoringNotice';
import type useEmbedVisitorState from '../../components/embed/useEmbedVisitorState';
import WelcomeScreen from '../../components/shell/WelcomeScreen';
import type { ChatMessage } from '../../hooks/useChatEngine/types';
import type { EmbedAgent } from './EmbedHeader';

interface EmbedMessagesProps {
    messages: ChatMessage[];
    agent: EmbedAgent;
    visitor: ReturnType<typeof useEmbedVisitorState>;
    messagesContainerRef: RefObject<HTMLDivElement | null>;
    messagesEndRef: RefObject<HTMLDivElement | null>;
    onStarterSend: (text: string) => void;
}

/** The scrolling transcript: the AI disclosure, then the welcome screen or the messages. */
export default function EmbedMessages({ messages, agent, visitor, messagesContainerRef, messagesEndRef, onStarterSend }: EmbedMessagesProps) {
    return (
        <div ref={messagesContainerRef} className="flex-1 overflow-y-auto p-4 custom-scrollbar">
            {/* Who answers, before the first message and above every later one. */}
            <EmbedAiDisclosure />
            {messages.length === 0 ? (
                <>
                    <EmbedMonitoringNotice notice={visitor.notice} dontCount={visitor.dontCount} onDontCountChange={visitor.setDontCount} />
                    <WelcomeScreen
                        agent={agent}
                        onSendMessage={onStarterSend}
                    />
                </>
            ) : (
                <div className="max-w-3xl mx-auto space-y-6 pb-4">
                    {messages.filter(m => !m.parentId).map((msg, idx) => (
                        <MessageItem
                            key={msg.id || idx}
                            idx={idx}
                            msg={msg}
                            selectedAgent={agent}
                            onCopy={(txt: unknown) => navigator.clipboard.writeText(String(txt))}
                            // Public widget on someone else's website — the
                            // model's reasoning is not for that audience.
                            showReasoning={false}
                            // Nor is the knowledge base behind the answer:
                            // document titles, headings, page numbers and
                            // the full retrieved passage. Off unless this
                            // agent's own settings said otherwise.
                            showSources={visitor.sourcesAllowed}
                        />
                    ))}
                    <div ref={messagesEndRef} />
                </div>
            )}
        </div>
    );
}
