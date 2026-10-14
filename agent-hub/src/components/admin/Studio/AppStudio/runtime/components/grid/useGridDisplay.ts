import { useMemo, useState } from 'react';
import { clearViewPrefs, readViewPrefs, resolveView, writeViewPrefs } from '../gridViewPrefs';

/**
 * Reader-side display state of the App Studio data grid: the viewer's view
 * overrides (density, look, clamp) and which groups are collapsed. Moved out
 * of AppDataGrid.jsx verbatim.
 */

export function useGridViewPrefs(nodeId: string, authored: { density: string; look: string; clamp: string }) {
    // Reader-side display overrides. The author's props stay the default; a
    // viewer can make the rows tighter, separate them differently, or stop one
    // long free-text column from making every row six lines tall. Stored per
    // grid in the browser, never in the definition — see gridViewPrefs.js.
    const [viewOverrides, setViewOverrides] = useState<Record<string, string>>(() => readViewPrefs(nodeId));
    const view = resolveView(authored, viewOverrides);
    const hasViewOverrides = Object.keys(viewOverrides).length > 0;
    const setViewKey = (key: string, value: string) => {
        setViewOverrides((prev) => {
            const next = { ...prev, [key]: value };
            writeViewPrefs(nodeId, next);
            return next;
        });
    };
    const resetView = () => { clearViewPrefs(nodeId); setViewOverrides({}); };

    return { view, hasViewOverrides, setViewKey, resetView };
}

// Grouping (spec: groupBy / groupOrder). collapsed:true in groupOrder
// seeds a group closed; the viewer's clicks override per group, held
// locally for the life of the component (like the tanstack sort state).
export function useGroupCollapse(groupOrder: unknown) {
    const collapsedSeed = useMemo(() => {
        const seed: Record<string, boolean> = {};
        for (const g of (Array.isArray(groupOrder) ? groupOrder : []) as Array<{ collapsed?: boolean; value?: unknown } | null>) {
            if (g && g.collapsed && g.value != null) seed[String(g.value)] = true;
        }
        return seed;
    }, [groupOrder]);
    const [collapsedOverrides, setCollapsedOverrides] = useState<Record<string, boolean>>({});
    const isGroupCollapsed = (val: string) => (val in collapsedOverrides ? collapsedOverrides[val] : !!collapsedSeed[val]);
    const toggleGroup = (val: string) => setCollapsedOverrides((prev) => ({ ...prev, [val]: !isGroupCollapsed(val) }));

    return { isGroupCollapsed, toggleGroup };
}
