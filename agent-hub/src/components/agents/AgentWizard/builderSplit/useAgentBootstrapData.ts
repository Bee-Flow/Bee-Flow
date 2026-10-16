/**
 * The editor's picker data: skills, integration status, categories, org
 * groups, tiers and automations.
 *
 * When mounted under AgentStudio the data comes from the shared
 * AgentEditorBootstrapProvider: one fetch per session, not one per agent
 * switch. When mounted standalone (the wizard landing path), the context
 * returns empty defaults and the editor falls back to its own six-request
 * bootstrap. Moved verbatim from BuilderSplit; the state lives on the
 * BuilderSplit fiber through this hook.
 */
import { useEffect, useState } from 'react';
import { fetchAgentEditorBootstrap } from '../../../../api/agentEditor';
import { useAgentEditorBootstrap } from '../AgentEditorBootstrapContext';
import { READ } from '../canUse/canUseFacts';
import type { AutomationRow, CategoryRow, ReadState } from '../agentEditor.types';
import type { ModelTierMap } from '../../../../api/queries/modelTiers';
import type { Skill } from '../../../../api/queries/skills';
import type { IntegrationStatus } from '../../AgentDesigner/DesignerPanels';
import type { OrgGroup } from '../../AgentDesigner/PublishMenu';

type Setter<T> = (value: T) => void;

interface BootstrapSetters {
    setAllSkills: Setter<Skill[] | null>;
    setIntegrationStatus: Setter<IntegrationStatus | null>;
    setCategories: Setter<CategoryRow[]>;
    setCategoriesState: Setter<ReadState>;
    setOrgGroups: Setter<OrgGroup[]>;
    setTiers: Setter<ModelTierMap>;
    setAutomations: Setter<AutomationRow[]>;
}

/** Standalone fallback: the same six requests the provider sends, read into local state. */
async function loadStandalone(s: BootstrapSetters, isCancelled: () => boolean): Promise<void> {
    try {
        const [skillsRes, statusRes, catsRes, groupsRes, tiersRes, autosRes] = await fetchAgentEditorBootstrap();
        if (isCancelled()) return;
        s.setAllSkills(skillsRes.ok ? await skillsRes.json() : []);
        s.setIntegrationStatus(statusRes.ok ? await statusRes.json() : {});
        if (catsRes.ok) {
            const list = await catsRes.json();
            const okList = Array.isArray(list);
            s.setCategories(okList ? list : []);
            s.setCategoriesState(okList ? READ.OK : READ.ERROR);
        } else {
            s.setCategories([]);
            s.setCategoriesState(READ.ERROR);
        }
        s.setOrgGroups(groupsRes.ok ? await groupsRes.json() : []);
        s.setTiers(tiersRes.ok ? await tiersRes.json() : {});
        if (autosRes.ok) {
            try {
                const data = await (autosRes as Response).json();
                s.setAutomations(Array.isArray(data?.automations) ? data.automations : []);
            } catch { s.setAutomations([]); }
        }
    } catch {
        if (!isCancelled()) {
            s.setAllSkills([]);
            s.setIntegrationStatus({});
            s.setCategoriesState(READ.ERROR);
        }
    }
}

export default function useAgentBootstrapData() {
    // Loaded once for pickers
    const [allSkills, setAllSkills] = useState<Skill[] | null>(null); // null = not loaded, [] = loaded but empty
    const [integrationStatus, setIntegrationStatus] = useState<IntegrationStatus | null>(null);
    // Tier (for chat input)
    const [tiers, setTiers] = useState<ModelTierMap>({});
    // Categories + groups (for selectors)
    const [categories, setCategories] = useState<CategoryRow[]>([]);
    // "Could the category list be read?", kept apart from the list itself so
    // a failed read does not read as "this org has no categories".
    const [categoriesState, setCategoriesState] = useState<ReadState>(READ.LOADING);
    const [orgGroups, setOrgGroups] = useState<OrgGroup[]>([]);
    const [automations, setAutomations] = useState<AutomationRow[]>([]);

    const bootstrap = useAgentEditorBootstrap();
    const usingProvider = bootstrap.loaded || bootstrap.allSkills !== null;
    useEffect(() => {
        if (!usingProvider) return;
        setAllSkills(bootstrap.allSkills);
        setIntegrationStatus(bootstrap.integrationStatus);
        setCategories(bootstrap.categories);
        setCategoriesState(bootstrap.categoriesState || READ.OK);
        setOrgGroups(bootstrap.orgGroups);
        setTiers(bootstrap.tiers);
        setAutomations(bootstrap.automations);
    }, [usingProvider, bootstrap.allSkills, bootstrap.integrationStatus, bootstrap.categories, bootstrap.categoriesState, bootstrap.orgGroups, bootstrap.tiers, bootstrap.automations]);

    // Standalone fallback: only fires when we're NOT under the provider.
    // Uses the same 6-request bootstrap so the legacy wizard landing keeps working.
    useEffect(() => {
        if (usingProvider) return;
        let cancelled = false;
        loadStandalone(
            { setAllSkills, setIntegrationStatus, setCategories, setCategoriesState, setOrgGroups, setTiers, setAutomations },
            () => cancelled,
        );
        return () => { cancelled = true; };
    }, [usingProvider]);

    return {
        bootstrap, allSkills, setAllSkills, integrationStatus, tiers,
        categories, setCategories, categoriesState, orgGroups, automations,
    };
}
