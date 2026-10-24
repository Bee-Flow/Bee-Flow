import { useEffect } from 'react';
import { fetchEmbedAgent } from '../../api/embedApi';
import type { EmbedAgent } from './EmbedHeader';

/** Fetches the embed payload of an agent and hands it to the page (agent, error, loading flag) and the visitor state. */
export function useEmbedAgent(
    agentId: string,
    applyEmbedPayload: (data: unknown) => void,
    setAgent: (agent: EmbedAgent) => void,
    setError: (message: string) => void,
    setIsLoading: (loading: boolean) => void,
): void {
    useEffect(() => {
        const fetchAgent = async () => {
            try {
                const res = await fetchEmbedAgent(agentId);
                if (!res.ok) {
                    if (res.status === 403) setError('This agent is not available for embedding.');
                    else if (res.status === 404) setError('Agent not found.');
                    else setError('Failed to load agent.');
                    setIsLoading(false);
                    return;
                }
                const data = await res.json();
                // Map embed response to agent shape expected by WelcomeScreen/MessageItem
                setAgent({
                    id: data.id,
                    name: data.name,
                    description: data.description,
                    avatar: data.avatar,
                    starter_prompts: data.starterPrompts || [],
                    copy_enabled: data.copyEnabled ? 1 : 0
                });
                applyEmbedPayload(data);
                setIsLoading(false);
            } catch (err) {
                setError('Failed to connect to server.');
                setIsLoading(false);
            }
        };
        fetchAgent();
    }, [agentId, applyEmbedPayload, setAgent, setError, setIsLoading]);
}
