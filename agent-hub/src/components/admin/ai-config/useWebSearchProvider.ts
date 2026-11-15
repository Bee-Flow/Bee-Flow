// The state the web search provider form (IntegrationsAdminPanel/SearchSection)
// works on, read here instead of from the integrations panel, so Search &
// retrieval can show it on its own: the stored provider, keys and Bing market
// from GET /ai/config, the agent-search defaults from their own route. A save
// message goes out as a toast.
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAiConfigQuery } from '@/api/queries/aiConfigRead';
import { readOrNull } from '@/api/queries/refusableRead';
import { apiUrl } from '@/api/typedRequest';
import type { SearchSectionProps } from '@/components/integrations/IntegrationsAdminPanel/adminPanel.types';
import toast from '@/components/shared/Toast';
import useAdjustOnChange from '@/hooks/useAdjustOnChange';

/** The keys of GET /ai/config the form reads. */
interface SearchConfigRead {
    searchProvider?: string;
    hasBingSearchKey?: boolean;
    bingSearchMarket?: string;
    hasSerperKey?: boolean;
    agentSearchUrl?: string;
    hasAgentSearchUrl?: boolean;
}

type Defaults = SearchSectionProps['agentSearchDefaults'];

const DEFAULTS: Defaults = {
    mode: 'web', include_citations: true,
    web: { max_results: 5, fetch_top_n: 3, max_tokens_markdown: 2000 },
    web_fast: { max_results: 10, max_tokens_markdown: 1500 },
};

const defaultsKey = ['admin-config', 'agent-search-defaults'] as const;

/** The form's values as stored, laid over its own defaults. */
function fromStored(config: SearchConfigRead | null | undefined) {
    return {
        searchProvider: config?.searchProvider || 'agent-search',
        hasBingSearchKey: !!config?.hasBingSearchKey,
        bingSearchMarket: config?.bingSearchMarket || '',
        hasSerperKey: !!config?.hasSerperKey,
    };
}

export default function useWebSearchProvider(): SearchSectionProps & { loading: boolean } {
    const aiConfig = useAiConfigQuery<SearchConfigRead>();
    const config = aiConfig.data?.config;
    const defaultsQuery = useQuery({
        queryKey: defaultsKey,
        queryFn: ({ signal }) => readOrNull<Partial<Defaults>>(apiUrl('GET /ai/agent-search/defaults'), signal),
        staleTime: 0,
        retry: false,
    });

    const [stored, setStored] = useState(() => fromStored(config));
    const [agentSearchDefaults, setAgentSearchDefaults] = useState<Defaults>(() => ({ ...DEFAULTS, ...(defaultsQuery.data ?? {}) }));
    // A new answer from the server fills the form again; edits in flight are the server's next answer.
    useAdjustOnChange([config], () => setStored(fromStored(config)));
    useAdjustOnChange([defaultsQuery.data], () => setAgentSearchDefaults(prev => ({ ...prev, ...(defaultsQuery.data ?? {}) })));

    const [bingSearchKey, setBingSearchKey] = useState('');
    const [serperApiKey, setSerperApiKey] = useState('');
    const [savingBingKey, setSavingBingKey] = useState(false);
    const [savingSerperKey, setSavingSerperKey] = useState(false);
    const [savingSearchDefaults, setSavingSearchDefaults] = useState(false);

    return {
        loading: aiConfig.isPending,
        searchProvider: stored.searchProvider,
        setSearchProvider: (value) => setStored(s => ({ ...s, searchProvider: value })),
        bingSearchKey, setBingSearchKey,
        hasBingSearchKey: stored.hasBingSearchKey,
        setHasBingSearchKey: (value) => setStored(s => ({ ...s, hasBingSearchKey: value })),
        bingSearchMarket: stored.bingSearchMarket,
        setBingSearchMarket: (value) => setStored(s => ({ ...s, bingSearchMarket: value })),
        savingBingKey, setSavingBingKey,
        agentSearchUrl: config?.agentSearchUrl || '',
        hasAgentSearchUrl: !!config?.hasAgentSearchUrl,
        serperApiKey, setSerperApiKey,
        hasSerperKey: stored.hasSerperKey,
        setHasSerperKey: (value) => setStored(s => ({ ...s, hasSerperKey: value })),
        savingSerperKey, setSavingSerperKey,
        agentSearchDefaults, setAgentSearchDefaults,
        savingSearchDefaults, setSavingSearchDefaults,
        setMessage: (message) => {
            if (!message) return;
            if (message.type === 'success') toast.success(message.text);
            else toast.error(message.text);
        },
    };
}
