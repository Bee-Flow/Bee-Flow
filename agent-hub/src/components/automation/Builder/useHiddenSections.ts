import { useCallback, useMemo, useRef, useState, useLayoutEffect } from 'react';
import type { FlowStep } from './flow/types';
import type { FormDensity, FormDensityValue, FormMode } from './flow/settings/formDensity';

export interface HiddenSections {
    hiddenCount: number;
    densityValue: FormDensityValue;
}

export interface UseHiddenSectionsOptions {
    step: FlowStep | null | undefined;
    density: FormDensity;
    mode: FormMode | null;
}

/**
 * How many form sections Simple mode is holding back, and the context value
 * the sections report through. Lives beside the step editor because the count
 * is what its "Show all options" control names.
 */
export default function useHiddenSections({ step, density, mode }: UseHiddenSectionsOptions): HiddenSections {
    // Sections Simple mode is holding back, reported by AccordionSection so
    // the "Show all options" control can name a real number instead of
    // promising something that may not exist for this step type. Symmetric:
    // sections report becoming VISIBLE too, so the count goes down again
    // (a section kept visible by content or an error is not "hidden").
    //
    // Keyed by step+density+mode rather than reset in an effect: child effects
    // run BEFORE the parent's, so a reset here would wipe what the sections
    // just reported on the very render that mounted them. The callback
    // identities stay stable — every section subscribes through a context.
    const hiddenKey = `${step?.id || ''}:${density}:${mode ?? 'gesture'}`;
    const hiddenKeyRef = useRef(hiddenKey);
    useLayoutEffect(() => {
        hiddenKeyRef.current = hiddenKey;
    });
    const [hiddenByKey, setHiddenByKey] = useState<Record<string, Set<string>>>({});
    const onHiddenSection = useCallback((sectionKey: string) => {
        setHiddenByKey((prev) => {
            const k = hiddenKeyRef.current;
            const cur = prev[k];
            if (cur?.has(sectionKey)) return prev;
            const next = new Set(cur || []);
            next.add(sectionKey);
            return { ...prev, [k]: next };
        });
    }, []);
    const onShownSection = useCallback((sectionKey: string) => {
        setHiddenByKey((prev) => {
            const k = hiddenKeyRef.current;
            const cur = prev[k];
            if (!cur?.has(sectionKey)) return prev;
            const next = new Set(cur);
            next.delete(sectionKey);
            return { ...prev, [k]: next };
        });
    }, []);
    const hiddenCount = hiddenByKey[hiddenKey]?.size || 0;
    const densityValue = useMemo(
        () => ({ density, mode, onHiddenSection, onShownSection }),
        [density, mode, onHiddenSection, onShownSection],
    );
    return { hiddenCount, densityValue };
}
