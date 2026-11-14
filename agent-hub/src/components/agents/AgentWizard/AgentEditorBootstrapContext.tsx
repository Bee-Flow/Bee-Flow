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
import { readSkills } from '@/api/queries/skills';
import type { AgentEditorBootstrap, AutomationRow, CategoryRow, ReadState } from './agentEditor.types';
import type { OrgGroup } from '../AgentDesigner/PublishMenu';
import type { ModelTierMap } from '@/api/queries/modelTiers';
import type { Skill } from '@/api/queries/skills';
import type { IntegrationStatus } from '../AgentDesigner/DesignerPanels';
import { RefusedError } from '@/api/mutate';
import { apiRequest } from '@/api/typedRequest';
import { useAgentEditorBootstrapQuery } from '@/api/queries/agentEditorBootstrap';
import useAdjustOnChange from '@/hooks/useAdjustOnChange';

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
            let r: Response;
            try {
                r = await apiRequest('GET /agents/categories');
            } catch (err) {
                if (!(err instanceof RefusedError)) throw err;
                setCategoriesState(READ.ERROR);
                return;
            }
            const list = await r.json();
            const okList = Array.isArray(list);
            setCategories(okList ? list : []);
            setCategoriesState(okList ? READ.OK : READ.ERROR);
        } catch (e) {
            console.warn('[AgentEditorBootstrap] refreshCategories failed', e);
            setCategoriesState(READ.ERROR);
        }
    }, []);

    // One read of the six requests per session (api/queries/agentEditorBootstrap.ts).
    const bootstrap = useAgentEditorBootstrapQuery();
    useAdjustOnChange([bootstrap.dataUpdatedAt], () => {
        const answer = bootstrap.data;
        if (!answer) return;
        setAllSkills(answer.skills as Skill[]);
        setIntegrationStatus(answer.integrationStatus as IntegrationStatus);
        setCategories((answer.categories ?? []) as CategoryRow[]);
        setCategoriesState(answer.categories ? READ.OK : READ.ERROR);
        setOrgGroups(answer.orgGroups as OrgGroup[]);
        setTiers(answer.tiers as ModelTierMap);
        const autos = answer.automations;
        if (autos.state === 'ok') { setAutomations(autos.list as AutomationRow[]); setAutomationsState(READ.OK); }
        else if (autos.state === 'unrecognised') { setAutomations([]); setAutomationsState(READ.ERROR); }
        else setAutomationsState(READ.ERROR);
        setLoaded(true);
    });
    useAdjustOnChange([bootstrap.errorUpdatedAt], () => {
        if (!bootstrap.error) return;
        setAllSkills([]);
        setIntegrationStatus({});
        setAutomationsState(READ.ERROR);
        setCategoriesState(READ.ERROR);
        setLoaded(true);
    });
    useEffect(() => {
        if (bootstrap.error) console.warn('[AgentEditorBootstrap] bootstrap fetch failed', bootstrap.error);
    }, [bootstrap.error]);

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
