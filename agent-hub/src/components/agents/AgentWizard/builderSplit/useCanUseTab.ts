/**
 * The "Can use" tab of the agent editor (A2 steps 2-4): its sources, its rows
 * and the grant mutations its cards and the tool chooser make.
 *
 * Moved verbatim from BuilderSplit. The grants live in the SAVED config:
 * `config.tools` is what the runtime reads. `toolsConfig`, the lists and
 * `stateRef` stay on the BuilderSplit fiber and come in as deps.
 */
import { useCallback, useMemo } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { useLinkedAutomationIds } from '@/api/queries/automation/agentBindings';
import { INTEGRATION_CATALOG } from '../../AgentDesigner/integrations';
import type { ReadState } from '../canUse/canUseFacts';
import { READ, datatableGrantsOf, datatableRows, knowledgeBaseRows, skillRows } from '../canUse/canUseFacts';
import { CHOOSER_SECTION } from '../canUse/toolChooser';
import { automationGrantsOf, automationRows, keepRequiresGrantApps, setAppActAs, setAppConfirm, toolRows } from '../canUse/toolGrants';
import useCanUseSources from '../canUse/useCanUseSources';
import useToolCatalog from '../canUse/useToolCatalog';
import { AGENT_TAB_IDS } from './AgentEditorHeader';

// Agent rows, configs and catalog entries are server JSON passed through as is.
type Loose = any;
type Setter<T> = Dispatch<SetStateAction<T>>;
// useCanUseSources and toolGrants.js are JS: their parameter types are inferred
// from the defaults (`= []`, `= null`, `= READ.OK`) and an incomplete JSDoc, so
// the calls below assert to the callee's own parameter type.
type ArgOf<F extends (arg: never) => unknown> = Parameters<F>[0];

export interface CanUseTabDeps {
    activeTab: string;
    setActiveTab: Setter<string>;
    agent: Loose;
    toolsConfig: Loose;
    setToolsConfig: Setter<Loose>;
    enabledIntegrations: Loose;
    setEnabledIntegrations: Setter<Loose>;
    attachedSkillIds: Loose[];
    knowledgeBaseIds: Loose[];
    allKbs: Loose;
    kbsState: ReadState;
    allSkills: Loose[] | null;
    automations: Loose[];
    stateRef: MutableRefObject<Loose>;
    patchConfig: (patch: Record<string, unknown>, opts?: { immediate?: boolean }) => void;
    setKnowledgeOpen: Setter<boolean>;
    setSkillPickerOpen: Setter<boolean>;
    setToolChooserOpen: Setter<boolean>;
    setToolChooserAppId: Setter<Loose>;
}

/**
 * The grant mutations. One grant mutation: adjust the map, draw it at once,
 * and save it. `patchConfig` writes into `stateRef` (what the autosave
 * sends); the local state only keeps the card from waiting on the server.
 * Both get the same map, from `toolGrants.js`, the only place a grants map
 * is built.
 */
function useGrantMutations(d: CanUseTabDeps, catalogApps: Loose) {
    const { stateRef, patchConfig, setToolsConfig, setEnabledIntegrations } = d;
    const writeTools = useCallback((next: Loose) => {
        // The first entry puts the agent in the confirmation regime, and so
        // changes what silence means for the apps the chooser could never
        // show. That may not be a SIDE EFFECT of a click on another row:
        // record what was there. See `keepRequiresGrantApps`.
        const before = stateRef.current.config?.tools ?? null;
        const kept = keepRequiresGrantApps(before, next, {
            apps: catalogApps,
            enabledIntegrations: stateRef.current.config?.enabledIntegrations ?? null,
        });
        setToolsConfig(kept);
        patchConfig({ tools: kept });
    }, [stateRef, catalogApps, setToolsConfig, patchConfig]);

    // Must this app be named explicitly before a curated agent gets anything
    // of it? (`requiresGrant` from the catalog.) The two mutations below ADD
    // an entry, and adding an entry may not change the actions: for such an
    // app "no action list" means nothing instead of everything. Without this
    // answer turning on "Confirm first" would silently give an agent a full
    // browser.
    const requiresGrantOf = useCallback((appId: Loose) => {
        const app = Array.isArray(catalogApps) ? catalogApps.find((a: Loose) => a && a.id === appId) : null;
        return !!(app && app.requiresGrant);
    }, [catalogApps]);

    const onChangeConfirm = useCallback((appId: Loose, confirm: Loose) => {
        writeTools(setAppConfirm(stateRef.current.config?.tools ?? null, appId, confirm,
            { requiresGrant: requiresGrantOf(appId) }));
    }, [writeTools, stateRef, requiresGrantOf]);
    const onChangeActAs = useCallback((appId: Loose, actAs: Loose) => {
        writeTools(setAppActAs(stateRef.current.config?.tools ?? null, appId, actAs,
            { requiresGrant: requiresGrantOf(appId) }));
    }, [writeTools, stateRef, requiresGrantOf]);

    // What the tool chooser yields: ONE save for both gates. The chooser
    // serves the app-level list (`enabledIntegrations`) and the action-level
    // map (`config.tools`), and those belong in the same patch: two separate
    // patches would leave a moment in which the app is on without actions
    // (or the other way round), and that is the moment an autosave can land.
    const onCommitTools = useCallback(({ tools, enabledIntegrations: nextEnabled, enabledChanged }: Loose) => {
        setToolsConfig(tools);
        if (enabledChanged && Array.isArray(nextEnabled)) {
            setEnabledIntegrations(nextEnabled);
            patchConfig({ tools, enabledIntegrations: nextEnabled });
            return;
        }
        patchConfig({ tools });
    }, [patchConfig, setEnabledIntegrations, setToolsConfig]);
    return { onChangeConfirm, onChangeActAs, onCommitTools };
}

/**
 * "+ Link" on a card: THE seam to the tool chooser (A2 step 4). The knowledge
 * bases open the files dialog; skills live on the Role tab, so that is where
 * we go (a popover "open" on a tab that does not draw it is exactly the
 * silent no-op we avoid). The ↗ on a tool row opens the chooser on THAT app;
 * the card's "+ Link" opens it without focus. It belongs to the card, so we
 * stay on "Can use"; the catalog it needs is only read on that tab
 * (useToolCatalog).
 */
function useOpenChooser(d: CanUseTabDeps) {
    const { setKnowledgeOpen, setActiveTab, setSkillPickerOpen, setToolChooserAppId, setToolChooserOpen } = d;
    return useCallback((request: Loose) => {
        if (!request) return;
        if (request.section === CHOOSER_SECTION.KNOWLEDGE_BASES) { setKnowledgeOpen(true); return; }
        if (request.section === CHOOSER_SECTION.SKILLS) { setActiveTab(AGENT_TAB_IDS.ROLE); setSkillPickerOpen(true); return; }
        if (request.section === CHOOSER_SECTION.APPS) {
            setActiveTab(AGENT_TAB_IDS.CAN_USE);
            setToolChooserAppId(request.appId || null);
            setToolChooserOpen(true);
        }
    }, [setActiveTab, setKnowledgeOpen, setSkillPickerOpen, setToolChooserAppId, setToolChooserOpen]);
}

/** The rows of the knowledge and skills cards: pure, see canUse/canUseFacts.ts. */
function knowledgeAndSkillRows(d: CanUseTabDeps, tables: Loose, tablesState: Loose, usage: { skillUsage: Loose; skillUsageState: Loose }) {
    const { agent, toolsConfig, allSkills } = d;
    // The LINK comes from the config and is always known; the NAMES come from
    // reads that can be missing. A link without a name stays: filtering it
    // out would make the card claim the agent lacks that knowledge.
    const knowledgeRows = knowledgeBaseRows({ ids: d.knowledgeBaseIds, kbs: d.allKbs, state: d.kbsState });
    const { rows: tableGrantRows, truncated: tablesTruncated } = datatableRows({ toolsConfig, tables, state: tablesState });
    const attachedSkillRows = skillRows({
        ids: d.attachedSkillIds,
        skills: allSkills,
        // `allSkills` is `null` until the bootstrap is done: that is LOADING,
        // not "this organisation has no skills".
        state: allSkills === null ? READ.LOADING : READ.OK,
        usage: usage.skillUsage,
        usageState: usage.skillUsageState,
        // The server counts the SAVED config; a skill ticked just now is not
        // in it yet, so the agent itself is not subtracted then either.
        savedSkillIds: agent?.config?.attachedSkillIds || [],
        agentSaved: !!agent?.id,
    });
    return { knowledgeRows, tableGrantRows, tablesTruncated, attachedSkillRows };
}

export default function useCanUseTab(d: CanUseTabDeps) {
    const { agent, toolsConfig, enabledIntegrations, attachedSkillIds } = d;
    const datatableGrantCount = datatableGrantsOf(toolsConfig).grants.length;
    const automationGrantCount = automationGrantsOf(toolsConfig).length;
    const canUseActive = d.activeTab === AGENT_TAB_IDS.CAN_USE;
    const { tables, tablesState, refetchTables, usage: skillUsage, usageState: skillUsageState } =
        useCanUseSources({
            enabled: canUseActive,
            toolsConfig,
            attachedSkillIds,
            // The SAVED list belongs here: the server's usage count only
            // knows that one, so it has to be re-read once the save lands.
            savedSkillIds: agent?.config?.attachedSkillIds || [],
        } as ArgOf<typeof useCanUseSources>);
    // The frontend's static name map, ONCE. Built inline it is a new object
    // on every render, and then every consumer recomputes, which made the
    // tool chooser restart in the middle of ticking.
    const integrationLabels = useMemo(
        () => Object.fromEntries(INTEGRATION_CATALOG.map((a: Loose) => [a.id, a.label])),
        [],
    );
    // The app action catalog and the lending grants (A2 step 3), from the
    // UNGATED `GET /agents/tool-catalog`. See useToolCatalog.
    const catalog = useToolCatalog({ enabled: canUseActive, agentId: agent?.id || null });
    const rows = knowledgeAndSkillRows(d, tables, tablesState, { skillUsage, skillUsageState });
    // The rows come from `enabledIntegrations` plus every app with an entry in
    // `config.tools`; the catalog adds counts, verbs and effect, and without
    // it the rows stay with the NARROW reading. See canUse/toolGrants.js.
    const appToolRows = toolRows({
        toolsConfig, enabledIntegrations, apps: catalog.apps, catalogState: catalog.catalogState,
        providersKnown: catalog.providersKnown, labels: integrationLabels, lentApps: catalog.lentApps,
        lendingEnabled: catalog.lendingEnabled, runtimeCurated: catalog.runtimeCurated,
    } as ArgOf<typeof toolRows>);
    // The automations linked to THIS agent: the runtime only offers a granted
    // automation when it is linked too. A failed read is `null`.
    const linkedAutomations = useLinkedAutomationIds(canUseActive ? agent?.id : null);
    const grantedAutomationRows = automationRows({
        toolsConfig,
        automations: d.automations,
        linkedIds: linkedAutomations.data ?? null,
        // `automations` is `[]` while the bootstrap runs AND when the org lacks
        // the module; the grant stays and the name is missing with a reason.
        state: Array.isArray(d.automations) && d.automations.length > 0 ? READ.OK : READ.ERROR,
    } as ArgOf<typeof automationRows>);
    return {
        datatableGrantCount, automationGrantCount, integrationLabels, ...catalog, catalogApps: catalog.apps,
        tablesState, refetchTables, skillUsageState, ...rows, appToolRows, grantedAutomationRows,
        ...useGrantMutations(d, catalog.apps), openChooser: useOpenChooser(d),
    };
}
