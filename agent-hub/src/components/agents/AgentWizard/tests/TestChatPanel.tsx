import { ArrowUp, Square } from 'lucide-react';
import { useState } from 'react';
import MessageItem from '@/components/chat/MessageItem';
import type { ChatMessage } from '@/components/chat/MessageItem/messageTypes';
import type { ToolDecisionHandler } from '@/components/chat/MessageItem/ToolConfirmCard';
import type { TranslateFn } from '@/hooks/useTranslation';

interface TestChatPanelProps {
    t: TranslateFn;
    /** Read-only editors can still read the conversation, but not start one. */
    ro?: boolean;
    messages: ChatMessage[];
    isLoading: boolean;
    onSend: (text: string) => void;
    onStop: () => void;
    onToolDecision: ToolDecisionHandler;
    toolDecisions: Record<string, string>;
}

/**
 * The test chat of the Test tab: ask the saved draft a question and read the answer
 * before anyone else does. The engine lives in the parent (useChatEngine with
 * `testChat`), so this only draws what it is given. The chat is ephemeral on the server:
 * nothing asked here is stored unless it is turned into a test.
 */
export default function TestChatPanel({ t, ro = false, messages, isLoading, onSend, onStop, onToolDecision, toolDecisions }: TestChatPanelProps) {
    const [draft, setDraft] = useState('');
    const text = draft.trim();

    const send = () => {
        if (!text || isLoading) return;
        onSend(text);
        setDraft('');
    };

    const label = t('agent_studio.test.chat_input', 'Ask this agent a question');

    return (
        <section
            data-testid="agent-test-chat"
            className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card,#fff)] overflow-hidden mb-6"
        >
            <div className="px-4 py-3 border-b border-[var(--border-default)] text-[14px] font-semibold text-[var(--text-primary)]">
                {t('agent_studio.test.chat_title', 'Try this agent')}
            </div>
            <div className="px-4 py-3 space-y-3 max-h-[480px] overflow-y-auto">
                {messages.length === 0 && (
                    <p data-testid="agent-test-chat-empty" className="text-[12px] text-[var(--text-tertiary)]">
                        {t('agent_studio.test.chat_empty', 'Ask a question to see how your draft answers. Nothing you ask here is saved.')}
                    </p>
                )}
                {messages.map((msg, idx) => (
                    <MessageItem
                        key={msg.id}
                        msg={msg}
                        idx={idx}
                        isUser={msg.role === 'user'}
                        allMessages={messages}
                        showAnswerChips
                        onToolDecision={onToolDecision}
                        toolDecisions={toolDecisions}
                    />
                ))}
            </div>
            {!ro && (
                <div className="flex items-end gap-2 px-4 py-3 border-t border-[var(--border-default)]">
                    <textarea
                        data-testid="agent-test-chat-input"
                        rows={1}
                        value={draft}
                        aria-label={label}
                        placeholder={label}
                        onChange={(ev) => setDraft(ev.target.value)}
                        onKeyDown={(ev) => {
                            if (ev.key === 'Enter' && !ev.shiftKey) {
                                ev.preventDefault();
                                send();
                            }
                        }}
                        className="flex-1 resize-none rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] px-3 py-2 text-[13px] text-[var(--text-primary)]"
                    />
                    {isLoading ? (
                        <button
                            type="button"
                            data-testid="agent-test-chat-stop"
                            onClick={onStop}
                            aria-label={t('agent_studio.test.chat_stop', 'Stop')}
                            className="h-9 w-9 flex items-center justify-center rounded-lg border border-[var(--border-default)] text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] transition"
                        >
                            <Square size={14} aria-hidden="true" />
                        </button>
                    ) : (
                        <button
                            type="button"
                            data-testid="agent-test-chat-send"
                            onClick={send}
                            disabled={!text}
                            aria-label={t('agent_studio.test.chat_send', 'Send')}
                            className="h-9 w-9 flex items-center justify-center rounded-lg text-white bg-[var(--accent)] disabled:opacity-50 transition"
                        >
                            <ArrowUp size={16} aria-hidden="true" />
                        </button>
                    )}
                </div>
            )}
        </section>
    );
}
