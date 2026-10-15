// What the Agent Designer's sections receive: the designer's whole state bag
// (hooks/useAgentState.ts) plus the helpers index.tsx adds next to it.
import type { authFetch } from '../../../../utils/helpers';
import type { CAPABILITIES, CapabilityKey } from '../constants';
import type useAgentState from '../hooks/useAgentState';

export type DesignerSectionProps = ReturnType<typeof useAgentState> & {
    authFetch: typeof authFetch;
    API_BASE: string;
    CAPABILITIES: typeof CAPABILITIES;
    checkCapability: (prompt: string, key: CapabilityKey) => boolean;
    toggleCapability: (key: CapabilityKey) => void;
    isReadonly?: boolean;
    sequentialThinkingEnabled?: boolean;
    setSequentialThinkingEnabled?: (enabled: boolean) => void;
    sequentialThinkingModel?: string;
    setSequentialThinkingModel?: (model: string) => void;
};
