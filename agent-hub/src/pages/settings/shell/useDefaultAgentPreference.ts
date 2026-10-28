import { useEffect, useState } from 'react';
import scopedStorage from '@/utils/scopedStorage';

/** User-scoped: these are personal "which agent do I start on?" preferences. */
export function useDefaultAgentPreference() {
    const [defaultAgentMode, setDefaultAgentMode] = useState(() => scopedStorage.getItem('defaultAgentMode') || 'last-used');
    const [defaultAgentId, setDefaultAgentId] = useState(() => scopedStorage.getItem('defaultAgentId') || '');

    useEffect(() => { scopedStorage.setItem('defaultAgentMode', defaultAgentMode); }, [defaultAgentMode]);
    useEffect(() => { scopedStorage.setItem('defaultAgentId', defaultAgentId); }, [defaultAgentId]);

    return { defaultAgentMode, setDefaultAgentMode, defaultAgentId, setDefaultAgentId };
}
