/**
 * One agent: its profile, and the conversation you have with it, keyed off
 * the `c` search param:
 *
 *   /agents/<id>              the profile — what this thing is for
 *   /agents/<id>?c=new        a fresh conversation
 *   /agents/<id>?c=<convId>   an existing one
 *
 * One route rather than two because the move from profile to chat is a push
 * the user will make and immediately reverse, and because a new conversation
 * has no id until the server answers — routing on the id would mean
 * navigating mid-stream. `?c=new` also makes back do the obvious thing:
 * chat → profile → list.
 */

import { Stack, useRouter } from 'expo-router';
import React, { useState } from 'react';

import { ErrorState, LoadingState, Screen } from '@/shared/ui';

import { AgentChat } from '../components/AgentChat';
import { AgentHeader } from '../components/AgentHeader';
import { AgentProfile } from '../components/AgentProfile';
import { useAgent } from '../hooks/queries';

export interface AgentScreenProps {
    id: string;
    /** `new`, a conversation id, or absent for the profile. */
    c?: string;
    /** A starter prompt to seed the composer with. */
    q?: string;
}

export function AgentScreen({ id, c, q }: AgentScreenProps) {
    const router = useRouter();
    // Seeded from the route and then owned locally: the server assigns the id
    // of a new chat mid-stream, and rewriting the URL then would remount this.
    const [conversationId, setConversationId] = useState<string | null>(c && c !== 'new' ? c : null);
    const chatting = Boolean(c);
    const query = useAgent(id);
    const agent = query.data ?? null;

    const body = query.isLoading ? (
        <LoadingState />
    ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
    ) : !agent ? (
        // GET /agents/:id answers 404 for an agent that exists but is out of
        // reach, so "not found" and "not yours" are the same response by
        // design — do not promise the user a way in.
        <ErrorState error={new Error('This agent is not available to you.')} onRetry={() => void query.refetch()} />
    ) : chatting ? (
        <AgentChat agent={agent} conversationId={conversationId} onConversationId={setConversationId} initialText={q ?? ''} />
    ) : (
        <AgentProfile
            agent={agent}
            onChat={(prompt) =>
                router.push(prompt ? `/agents/${id}?c=new&q=${encodeURIComponent(prompt)}` : `/agents/${id}?c=new`)
            }
            onOpenConversation={(convId) => router.push(`/agents/${id}?c=${convId}`)}
            onSeeAllConversations={() => router.push(`/agents/${id}/conversations`)}
        />
    );

    return (
        <Screen edges={['top', 'bottom']} avoidKeyboard={chatting}>
            <Stack.Screen options={{ headerShown: false }} />
            <AgentHeader id={id} agent={agent} chatting={chatting} />
            {body}
        </Screen>
    );
}
