import { useEffect, useEffectEvent, useRef } from 'react';
import { localPaneId } from './providerRegistry';
import type { RuntimeProvider } from '@/api/runtimeTypes';

/**
 * After a runtime was connected, select it once the reloaded list holds exactly
 * one provider that was not there before. Anything else (none yet, several,
 * a changed list for another reason) leaves the selection alone.
 */
export function useSelectNewRuntime(localProviders: RuntimeProvider[], onSelect: (id: string) => void) {
    const before = useRef<Set<string> | null>(null);
    const select = useEffectEvent(onSelect);

    useEffect(() => {
        const known = before.current;
        if (!known) return;
        const added = localProviders.filter(p => !known.has(p.id));
        if (added.length === 0) return;
        before.current = null;
        if (added.length === 1) select(localPaneId(added[0].id));
    }, [localProviders]);

    /** Call right before the list is reloaded after a connect. */
    return () => { before.current = new Set(localProviders.map(p => p.id)); };
}
