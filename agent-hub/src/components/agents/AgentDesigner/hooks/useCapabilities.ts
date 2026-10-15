import { CAPABILITIES } from '../constants';
import type { AgentCapabilityKey } from '../constants';

interface CapabilityState {
    systemPrompt: string;
    setSystemPrompt: (prompt: string) => void;
    setWorkspaceEnabled: (enabled: boolean) => void;
}

/**
 * Capability toggle helpers (check/toggle capabilities embedded in system prompt).
 */
export default function useCapabilities(state: CapabilityState) {
    const { systemPrompt, setSystemPrompt, setWorkspaceEnabled } = state;

    const checkCapability = (prompt: string, key: string): boolean => {
        return prompt.includes(`<!-- CAPABILITY: ${key} -->`);
    };

    const toggleCapability = (key: AgentCapabilityKey) => {
        const cap = CAPABILITIES[key];
        if (!cap) return;

        const hasCapability = checkCapability(systemPrompt, key);
        let newPrompt = systemPrompt;

        if (hasCapability) {
            const regex = new RegExp(`\\n*<!-- CAPABILITY: ${key} -->[\\s\\S]*?<!-- /CAPABILITY -->`, 'g');
            newPrompt = newPrompt.replace(regex, '');
            if (key === 'WORKSPACE') setWorkspaceEnabled(false);
        } else {
            newPrompt += cap.instructions;
            if (key === 'WORKSPACE') setWorkspaceEnabled(true);
        }

        setSystemPrompt(newPrompt);
    };

    const componentsByCategory = <T extends { category?: string }>(components: T[]): Record<string, T[]> => components.reduce<Record<string, T[]>>((acc, comp) => {
        const category = comp.category || 'Uncategorized';
        if (!acc[category]) acc[category] = [];
        acc[category].push(comp);
        return acc;
    }, {});

    return { checkCapability, toggleCapability, componentsByCategory };
}
