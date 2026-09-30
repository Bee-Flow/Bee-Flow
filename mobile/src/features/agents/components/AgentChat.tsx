/**
 * Chatting with an agent: the transcript, the composer and the streaming
 * turn — everything below the screen's header. The same pieces as direct chat
 * (features/chat), with three agent-specific parts:
 *
 *   - Starter prompts. `starter_prompts` is the agent author's answer to "what
 *     do I even ask this thing"; without them an empty chat is a blank box.
 *   - A 403 mid-conversation. Agent access is re-read from the database on
 *     EVERY send, so a revoked membership fails the next message while the
 *     agent is still on screen. It is a permanent banner with no retry,
 *     because retrying cannot help.
 *   - No tier picker. An agent is configured with its own model; the web only
 *     sends `modelTier` when the user deliberately overrides it, and so does
 *     this.
 *
 * Like the chat screen, nothing here subscribes to the streaming text — only
 * the transcript's streaming cell does.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import {
    ChatTranscript,
    Composer,
    encodeAttachments,
    toWire,
    TurnNotices,
    useLatest,
    useLocalTranscript,
    type Attachment,
    type ChatMessage,
    type ComposerSettings,
    type TranscriptActions,
} from '@/features/chat';
import { useTurn } from '@/shared/stream';
import { Banner, ErrorState, ListSkeleton } from '@/shared/ui';

import { EmptyAgentChat } from './EmptyAgentChat';
import { useAgentConversation } from '../hooks/queries';
import { useAgentChatStream } from '../hooks/useAgentChatStream';
import { agentTurnPayload } from '../model/turnPayload';
import type { Agent } from '../model/types';

const DEFAULT_SETTINGS: ComposerSettings = {
    // `auto` means "leave the model to the agent": the sentinel checked before
    // deciding whether to send `modelTier` at all.
    modelTier: 'auto',
    // An agent's knowledge is configured server-side; nothing to attach here.
    knowledgeBaseIds: [],
    reasoningEffort: null,
    webSearchEnabled: true,
};

// The same hand-back as direct chat's, minus the failed-turn exception: once
// the server has the conversation, every local message is its to show.
const DROP_ALL = (): ChatMessage[] => [];

export interface AgentChatProps {
    agent: Agent;
    /** Null for a chat that has not been created server-side yet. */
    conversationId: string | null;
    /** Called once the server assigns an id, so the route can keep it. */
    onConversationId: (id: string) => void;
    /** Seeded from a starter prompt tapped on the agent's profile. */
    initialText?: string;
}

export function AgentChat({ agent, conversationId, onConversationId, initialText = '' }: AgentChatProps) {
    const t = useTranslation();
    const [settings, setSettings] = useState<ComposerSettings>(DEFAULT_SETTINGS);
    const query = useAgentConversation(agent.id, conversationId);
    const settleRef = useRef<ReturnType<typeof useLocalTranscript>['settle'] | null>(null);

    const stream = useAgentChatStream({
        agentId: agent.id,
        onDone: (finished) => {
            if (finished.conversationId && !conversationId) onConversationId(finished.conversationId);
            // A turn that produced nothing and reported nothing was cut off.
            settleRef.current?.(finished, !finished.error && !finished.accessDenied && !finished.text);
        },
        onUnhandled: (event) => {
            if (__DEV__) console.warn(`[agents] unhandled SSE event: ${event}`);
        },
    });
    const transcript = useLocalTranscript({
        persisted: query.data?.messages,
        persistedAt: query.dataUpdatedAt,
        streaming: stream.streaming,
        keep: DROP_ALL,
    });
    useEffect(() => {
        settleRef.current = transcript.settle;
    });
    const accessDenied = useTurn(stream.store, (turn) => turn.accessDenied);

    const handleSend = useLatest((text: string, attachments: Attachment[]) => {
        // Empty the live turn with the placeholder, not after the attachments
        // are encoded: until then the new bubble would show the last answer.
        stream.reset();
        const { placeholderId, history } = transcript.begin(text, attachments);
        void (async () => {
            let wire;
            try {
                // Inline base64 in the turn body — encoded and size-checked here
                // rather than blowing the 20 MB body limit silently.
                wire = toWire(await encodeAttachments(attachments));
            } catch (err) {
                transcript.fail(placeholderId, describeError(err).message);
                return;
            }
            await stream.send(agentTurnPayload({ text, attachments: wire, conversationId, settings, history }));
        })();
    });

    // The agent id and name ride along so the dashboard can rank agents by
    // rating without joining back through the usage log. No retry or edit
    // here: the agent route appends to its transcript rather than truncating
    // it to a shorter history, so a re-asked turn would be saved twice.
    const actions = useMemo<TranscriptActions>(
        () => ({
            feedback: { conversationId, agentId: agent.id, agentName: agent.name, source: 'agent' },
            conversation: () => transcript.messages.slice().reverse(),
            showSources: true,
        }),
        [conversationId, agent.id, agent.name, transcript.messages],
    );

    return (
        <>
            {accessDenied ? (
                <Banner tone="error" icon="Lock">
                    You no longer have access to {agent.name}. Your permissions changed while this
                    chat was open — ask an administrator if you still need it.
                </Banner>
            ) : null}

            {query.isLoading && conversationId ? (
                <ListSkeleton rows={4} />
            ) : query.isError ? (
                <ErrorState error={query.error} onRetry={() => void query.refetch()} />
            ) : transcript.messages.length === 0 ? (
                <EmptyAgentChat agent={agent} onPick={(prompt) => handleSend(prompt, [])} />
            ) : (
                <ChatTranscript messages={transcript.messages} store={stream.store} actions={actions} />
            )}

            <TurnNotices store={stream.store} onResolveDlp={stream.resolveDlp} />

            <Composer
                onSend={handleSend}
                onStop={stream.stop}
                streaming={stream.streaming}
                settings={settings}
                onSettingsChange={setSettings}
                // Empty on purpose: overriding an agent's model is a desktop
                // decision, and offering it here invites breaking a tuned agent.
                tiers={NO_TIERS}
                sources={false}
                disabledReason={accessDenied ? 'You no longer have access to this agent.' : undefined}
                placeholder={t('chat.composer.placeholder_agent', 'Message {name}...', { name: agent.name || t('chat.composer.agent_fallback', 'Agent') })}
                initialText={initialText}
            />
        </>
    );
}

const NO_TIERS = {};
