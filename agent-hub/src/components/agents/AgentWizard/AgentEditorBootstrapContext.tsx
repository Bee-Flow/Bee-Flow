// Single shared bootstrap fetch for the agent editor. Without this, every
// time the user switches agents in the studio (which forces a BuilderSplit
// remount via `key={selectedAgent.id}`) the editor refires six parallel
// requests (skills, integration status, agent categories, org groups, tier
// list, automations). The data rarely changes during a session, so we fetch
// once at the AgentStudio level and pass it down via context. BuilderSplit's
// hook falls back to its own fetch when no provider is present (so the
// wizard landing path keeps working).

import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import type { ReactNode } from 'react';
import { READ } from './canUse/canUseFacts';
import { readSkills } from '../../../api/queries/skills';
import { API_BASE, authFetch } from '../../../utils/helpers';
import { isAbortError } from '../../../utils/caughtError';
import type { AgentEditorBootstrap, AutomationRow, CategoryRow, ReadState } from './agentEditor.types';
import type { OrgGroup } from '../AgentDesigner/PublishMenu';
import type { ModelTierMap } from '../../../api/queries/modelTiers';
import type { Skill } from '../../../api/queries/skills';
import type { IntegrationStatus } from '../AgentDesigner/DesignerPanels';

const EMPTY: AgentEditorBootstrap = {
    allSkills: null,
    integrationStatus: null,
    categories: [],
    // The same rule as for the automations below: a `[]` from a FAILED reading is not "this org has
    // no categories". Without that difference the category tag of an agent that DOES have one
    // disappeared as soon as /agents/categories returned 403, and that agent got a choice list with
    // only "No category" — after which the only possible action is "+" and the owner creates a
    // duplicate of a category that does exist.
    categoriesState: READ.LOADING,
    orgGroups: [],
    tiers: {},
    automations: [],
    // "Could the routine list be read?" — separate from the list itself, because `/api/automation`
    // hangs behind the automations module and can 403 or fall over, and then `[]` is not "this user
    // has no automations". Only this state may decide whether a screen dares to say "none".
    automationsState: READ.LOADING,
    loaded: false,
    refreshSkills: () => Promise.resolve(),
    refreshCategories: () => Promise.resolve(),
};

const AgentEditorBootstrapContext = createContext<AgentEditorBootstrap>(EMPTY);

export function AgentEditorBootstrapProvider({ children }: { children?: ReactNode }) {
    const [allSkills, setAllSkills] = useState<Skill[] | null>(null);
    const [integrationStatus, setIntegrationStatus] = useState<IntegrationStatus | null>(null);
    const [categories, setCategories] = useState<CategoryRow[]>([]);
    const [categoriesState, setCategoriesState] = useState<ReadState>(READ.LOADING);
    const [orgGroups, setOrgGroups] = useState<OrgGroup[]>([]);
    const [tiers, setTiers] = useState<ModelTierMap>({});
    const [automations, setAutomations] = useState<AutomationRow[]>([]);
    const [automationsState, setAutomationsState] = useState<ReadState>(READ.LOADING);
    const [loaded, setLoaded] = useState(false);

    const refreshSkills = useCallback(async () => {
        try {
            const list = await readSkills();
            if (list) setAllSkills(list);
        } catch (e) {
            console.warn('[AgentEditorBootstrap] refreshSkills failed', e);
        }
    }, []);

    const refreshCategories = useCallback(async () => {
        try {
            const r = await authFetch(`${API_BASE}/agents/categories`);
            if (!r.ok) { setCategoriesState(READ.ERROR); return; }
            const list = await r.json();
            const okList = Array.isArray(list);
            setCategories(okList ? list : []);
            setCategoriesState(okList ? READ.OK : READ.ERROR);
        } catch (e) {
            console.warn('[AgentEditorBootstrap] refreshCategories failed', e);
            setCategoriesState(READ.ERROR);
        }
    }, []);

    useEffect(() => {
        const ac = new AbortController();
        const { signal } = ac;
        (async () => {
            try {
                const [skillsRes, statusRes, catsRes, groupsRes, tiersRes, autosRes] = await Promise.all([
                    authFetch(`${API_BASE}/api/skills`, { signal }),
                    authFetch(`${API_BASE}/ai/user-settings`, { signal }),
                    authFetch(`${API_BASE}/agents/categories`, { signal }),
                    authFetch(`${API_BASE}/auth/groups`, { signal }),
                    authFetch(`${API_BASE}/ai/config/tiers-for-user?taskType=direct_chat`, { signal }),
                    authFetch(`${API_BASE}/api/automation`, { signal }).catch((e: unknown): { ok: false } => {
                        if (!isAbortError(e)) console.warn('[AgentEditorBootstrap] automations fetch failed', e);
                        return { ok: false };
                    }),
                ]);
                if (signal.aborted) return;
                setAllSkills(skillsRes.ok ? await skillsRes.json() : []);
                setIntegrationStatus(statusRes.ok ? await statusRes.json() : {});
                if (catsRes.ok) {
                const list = await catsRes.json();
                const okList = Array.isArray(list);
                setCategories(okList ? list : []);
                setCategoriesState(okList ? READ.OK : READ.ERROR);
            } else {
                setCategories([]);
                setCategoriesState(READ.ERROR);
            }
                setOrgGroups(groupsRes.ok ? await groupsRes.json() : []);
                setTiers(tiersRes.ok ? await tiersRes.json() : {});
                if (autosRes.ok) {
                    try {
                        const data = await autosRes.json();
                        if (!signal.aborted) {
                            // A 200 without an `automations` array is not an empty list but an answer that we do not
                            // recognise.
                            const ok = Array.isArray(data?.automations);
                            setAutomations(ok ? data.automations : []);
                            setAutomationsState(ok ? READ.OK : READ.ERROR);
                        }
                    } catch (e) {
                        console.warn('[AgentEditorBootstrap] automations parse failed', e);
                        if (!signal.aborted) { setAutomations([]); setAutomationsState(READ.ERROR); }
                    }
                } else if (!signal.aborted) {
                    setAutomationsState(READ.ERROR);
                }
            } catch (e) {
                if (isAbortError(e) || signal.aborted) return;
                console.warn('[AgentEditorBootstrap] bootstrap fetch failed', e);
                setAllSkills([]);
                setIntegrationStatus({});
                setAutomationsState(READ.ERROR);
                setCategoriesState(READ.ERROR);
            } finally {
                if (!signal.aborted) setLoaded(true);
            }
        })();
        return () => { ac.abort(); };
    }, []);

    const value = {
        allSkills,
        integrationStatus,
        categories,
        categoriesState,
        orgGroups,
        tiers,
        automations,
        automationsState,
        loaded,
        refreshSkills,
        refreshCategories,
    };

    return (
        <AgentEditorBootstrapContext.Provider value={value}>
            {children}
        </AgentEditorBootstrapContext.Provider>
    );
}

export function useAgentEditorBootstrap() {
    return useContext(AgentEditorBootstrapContext);
}
