import { useCallback, useState, type Dispatch, type SetStateAction } from 'react';

/** The cross-cutting filters of the usage reports: member, agent, model and source. */
export interface UsageFilters {
    user: string | null;
    agent: string | null;
    model: string | null;
    source: string | null;
    setUser: Dispatch<SetStateAction<string | null>>;
    setAgent: Dispatch<SetStateAction<string | null>>;
    setModel: Dispatch<SetStateAction<string | null>>;
    setSource: Dispatch<SetStateAction<string | null>>;
    /** Any of the four is set. */
    active: boolean;
    clear: () => void;
}

export function useUsageFilters(): UsageFilters {
    const [user, setUser] = useState<string | null>(null);
    const [agent, setAgent] = useState<string | null>(null);
    const [model, setModel] = useState<string | null>(null);
    const [source, setSource] = useState<string | null>(null);
    const clear = useCallback(() => { setUser(null); setAgent(null); setModel(null); setSource(null); }, []);
    return { user, agent, model, source, setUser, setAgent, setModel, setSource, active: Boolean(user || agent || model || source), clear };
}
