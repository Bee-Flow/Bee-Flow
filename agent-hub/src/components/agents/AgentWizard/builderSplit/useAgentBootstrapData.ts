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
import { useStandaloneAgentEditorBootstrapQuery } from '@/api/queries/agentEditorBootstrap';
import useAdjustOnChange from '@/hooks/useAdjustOnChange';
import { useAgentEditorBootstrap } from '../AgentEditorBootstrapContext';
import { READ } from '../canUse/canUseFacts';
import type { AutomationRow, CategoryRow, ReadState } from '../agentEditor.types';
import type { ModelTierMap } from '@/api/queries/modelTiers';
import type { Skill } from '@/api/queries/skills';
import type { IntegrationStatus } from '../../AgentDesigner/DesignerPanels';
import type { OrgGroup } from '../../AgentDesigner/PublishMenu';

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

    // Standalone fallback: only read when we're NOT under the provider.
    // Uses the same 6-request bootstrap so the legacy wizard landing keeps working.
    const standalone = useStandaloneAgentEditorBootstrapQuery(!usingProvider);
    useAdjustOnChange([standalone.dataUpdatedAt], () => {
        const answer = standalone.data;
        if (!answer || usingProvider) return;
        setAllSkills(answer.skills as Skill[]);
        setIntegrationStatus(answer.integrationStatus as IntegrationStatus);
        setCategories((answer.categories ?? []) as CategoryRow[]);
        setCategoriesState(answer.categories ? READ.OK : READ.ERROR);
        setOrgGroups(answer.orgGroups as OrgGroup[]);
        setTiers(answer.tiers as ModelTierMap);
        const autos = answer.automations;
        if (autos.state === 'ok') setAutomations(autos.list as AutomationRow[]);
        else if (autos.state === 'unrecognised') setAutomations([]);
    });
    useAdjustOnChange([standalone.errorUpdatedAt], () => {
        if (!standalone.error || usingProvider) return;
        setAllSkills([]);
        setIntegrationStatus({});
        setCategoriesState(READ.ERROR);
    });

    return {
        bootstrap, allSkills, setAllSkills, integrationStatus, tiers,
        categories, setCategories, categoriesState, orgGroups, automations,
    };
}
