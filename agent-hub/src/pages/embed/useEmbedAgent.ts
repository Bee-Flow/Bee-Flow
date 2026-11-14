import { useEffect } from 'react';
import { useEmbedAgentQuery } from '../../api/queries/embedAgent';
import type { EmbedAgent } from './EmbedHeader';

interface EmbedPayload {
    id: string;
    name: string;
    description: string;
    avatar: string;
    starterPrompts?: string[];
    copyEnabled?: boolean;
}

/** The message for a refused read. */
function refusalMessage(status: number): string {
    if (status === 403) return 'This agent is not available for embedding.';
    if (status === 404) return 'Agent not found.';
    return 'Failed to load agent.';
}

/** Reads the embed payload of an agent and hands it to the page (agent, error, loading flag) and the visitor state. */
export function useEmbedAgent(
    agentId: string,
    applyEmbedPayload: (data: unknown) => void,
    setAgent: (agent: EmbedAgent) => void,
    setError: (message: string) => void,
    setIsLoading: (loading: boolean) => void,
): void {
    const { data: answer, isError } = useEmbedAgentQuery<EmbedPayload>(agentId);

    useEffect(() => {
        if (isError) {
            setError('Failed to connect to server.');
            setIsLoading(false);
            return;
        }
        if (!answer) return;
        const data = answer.data;
        if (!answer.ok || !data) {
            setError(refusalMessage(answer.status));
            setIsLoading(false);
            return;
        }
        // Map embed response to agent shape expected by WelcomeScreen/MessageItem
        setAgent({
            id: data.id,
            name: data.name,
            description: data.description,
            avatar: data.avatar,
            starter_prompts: data.starterPrompts || [],
            copy_enabled: data.copyEnabled ? 1 : 0,
        });
        applyEmbedPayload(data);
        setIsLoading(false);
    }, [answer, isError, applyEmbedPayload, setAgent, setError, setIsLoading]);
}
