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
import type { IntegrationStatus } from '../AgentDesigner/DesignerPanels';
import type { CategoryRow } from './builderSplit/builderSplitActions';

type SkillList = Awaited<ReturnType<typeof readSkills>>;
type ReadState = (typeof READ)[keyof typeof READ];

/** One automation row of GET /api/automation, as the editor reads it. */
export interface BootstrapAutomation {
    id: string;
    name?: string;
    [key: string]: unknown;
}

/** One org group of GET /auth/groups. */
export interface BootstrapOrgGroup {
    id: string;
    name?: string;
    [key: string]: unknown;
}

/** Everything the agent editor reads once per session, plus the refresh handles. */
export interface AgentEditorBootstrapValue {
    allSkills: SkillList;
    integrationStatus: IntegrationStatus | null;
    categories: CategoryRow[];
    categoriesState: ReadState;
    orgGroups: BootstrapOrgGroup[];
    tiers: Record<string, unknown>;
    automations: BootstrapAutomation[];
    automationsState: ReadState;
    loaded: boolean;
    refreshSkills: () => Promise<unknown>;
    refreshCategories: () => Promise<unknown>;
}

const EMPTY: AgentEditorBootstrapValue = {
    allSkills: null,
    integrationStatus: null,
    categories: [],
    // Dezelfde regel als voor de automatiseringen hieronder: een `[]` uit een MISLUKTE
    // lezing is niet "deze org heeft geen categorieën". Zonder dat verschil
    // verdween de categorietag van een agent DIE er een heeft zodra
    // /agents/categories 403'de, en kreeg een agent zonder er een keuzelijst
    // met alleen "No category" — waarna de enige mogelijke actie "+" is en de
    // eigenaar een duplicaat aanmaakt van een categorie die gewoon bestaat.
    categoriesState: READ.LOADING,
    orgGroups: [],
    tiers: {},
    automations: [],
    // "Kon de routinelijst gelezen worden?" — apart van de lijst zelf, want
    // `/api/automation` hangt achter de automations-module en kan 403'en of
    // omvallen, en dan is `[]` niet "deze gebruiker heeft geen automations".
    // Alleen deze toestand mag beslissen of een scherm "geen" durft te zeggen.
    automationsState: READ.LOADING,
    loaded: false,
    refreshSkills: () => Promise.resolve(),
    refreshCategories: () => Promise.resolve(),
};

const AgentEditorBootstrapContext = createContext<AgentEditorBootstrapValue>(EMPTY);

export function AgentEditorBootstrapProvider({ children }: { children: ReactNode }) {
    const [allSkills, setAllSkills] = useState<SkillList>(null);
    const [integrationStatus, setIntegrationStatus] = useState<IntegrationStatus | null>(null);
    const [categories, setCategories] = useState<CategoryRow[]>([]);
    const [categoriesState, setCategoriesState] = useState<ReadState>(READ.LOADING);
    const [orgGroups, setOrgGroups] = useState<BootstrapOrgGroup[]>([]);
    const [tiers, setTiers] = useState<Record<string, unknown>>({});
    const [automations, setAutomations] = useState<BootstrapAutomation[]>([]);
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
                    authFetch(`${API_BASE}/api/automation`, { signal }).catch((e: unknown): Response => {
                        if ((e as Error | undefined)?.name !== 'AbortError') console.warn('[AgentEditorBootstrap] automations fetch failed', e);
                        return { ok: false } as Response;
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
                            // Een 200 zonder `automations`-array is geen lege
                            // lijst maar een antwoord dat we niet herkennen.
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
                if ((e as Error | undefined)?.name === 'AbortError' || signal.aborted) return;
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

    const value: AgentEditorBootstrapValue = {
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
