// A panel whose sub-sections are not in the URL (they are component state)
// tells the dashboard shell which scope the visible one has, so the shell's
// one badge stays right. The override ends when the panel unmounts.
import { createContext, useContext, useEffect } from 'react';
import type { AdminScope } from './adminTabs';

type SetOverride = (scope: AdminScope | null) => void;

const AdminScopeOverrideContext = createContext<SetOverride | null>(null);

export const AdminScopeOverrideProvider = AdminScopeOverrideContext.Provider;

/** Pass the scope of the visible sub-section, or null to keep the tab's own. */
export function useAdminScopeOverride(scope: AdminScope | null) {
    const set = useContext(AdminScopeOverrideContext);
    useEffect(() => {
        if (!set) return undefined;
        set(scope);
        return () => set(null);
    }, [set, scope]);
}
