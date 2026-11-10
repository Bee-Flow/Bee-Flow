import { filterAvailableIntegrations } from '../../AgentDesigner/integrationAvailability';
import { INTEGRATION_CATALOG } from '../../AgentDesigner/integrations';
import { buildAgentTabs, publishedVersionOf } from './AgentEditorHeader';
import type { EditorAgent } from './editorTypes';
import type { IntegrationStatus } from '../../AgentDesigner/DesignerPanels';
import useAgentConceptFacts from './useAgentConceptFacts';
import { agentUsageFetcher } from '@/api/agentEditor';
import useUsage from '@/hooks/useUsage';
import type { TranslateFn } from '@/hooks/useTranslation';

interface Inputs {
    t: TranslateFn;
    agent: EditorAgent | null | undefined;
    integrationStatus: IntegrationStatus | null;
    allSkills: Array<{ id: string }> | null;
    enabledIntegrations: string[] | null;
    knowledgeBaseIds: string[];
    attachedSkillIds: string[];
    datatableGrantCount: number;
    automationGrantCount: number;
}

/**
 * What the editor derives from its state for the header and the tabs: the
 * integrations this user may use, the counters on the tabs, the "Used by"
 * read and the persona language from the draft view.
 */
export default function useEditorDerived({ t, agent, integrationStatus, allSkills, enabledIntegrations, knowledgeBaseIds, attachedSkillIds, datatableGrantCount, automationGrantCount }: Inputs) {
    // Filter integration catalog by org/credential gating (shared with the
    // skill editor — see AgentDesigner/integrationAvailability).
    const availableIntegrations = filterAvailableIntegrations(INTEGRATION_CATALOG, integrationStatus);

    const skillNamesById = new Map((allSkills || []).map(s => [s.id, s]));
    // Apps are off by default (R4). Legacy `null` rows have been backfilled
    // server-side, so `enabledIntegrations` is always an array here.
    // The count is a fact about the agent's CONFIG: every app that is switched
    // on, the same number the agent card in the list shows (agentCardFacts) and
    // the same apps the Tools card draws a row for. It used to be measured
    // against `availableIntegrations`, a client-side guess at what this user
    // may use, and then an agent with Outlook switched on showed "0" as soon
    // as that guess left Outlook out.
    const enabledIntegrationCount = Array.isArray(enabledIntegrations)
        ? new Set(enabledIntegrations.filter(id => typeof id === 'string' && id)).size
        : 0;

    // ── The counters on the tabs ──────────────────────────────────
    // "Can use" carries apps, knowledge bases, table grants, skills and
    // automation grants. All five come from the agent's CONFIG — none of the
    // tab's extra reads is needed for it, so the counter stays right while
    // you are on Role.
    const canUseCount = enabledIntegrationCount + knowledgeBaseIds.length + datatableGrantCount
        + attachedSkillIds.length + automationGrantCount;

    // "Used by": GET /agents/:id/usage. useUsage's URL table points to
    // /api/agents/:id/usage, and that mount does not exist — the agents router
    // hangs on /agents (server/index.js). Hence a fetcher of our own
    // (agentUsageFetcher in api/agentEditor.ts); without it every read would
    // be a 404 and the tab permanently "not read".
    const { usage: agentUsage, error: usageError, refetch: refetchUsage } = useUsage('agent', agent?.id || null, { fetcher: agentUsageFetcher });
    // A failed read leaves useUsage at [] WITH an error next to it.
    // That [] must never reach the screen as "nobody uses this", so the
    // counter is then unknown — not 0.
    const usedByCount = usageError ? undefined : (Array.isArray(agentUsage) ? agentUsage.length : undefined);

    const tabs = buildAgentTabs(t, { canUseCount, usedByCount });

    // The draft view carries the persona (and so the language); the agent list
    // the editor is opened from does not. See useAgentConceptFacts.
    const conceptFacts = useAgentConceptFacts(agent?.id || null);
    const personaLanguage = agent?.persona?.language ?? conceptFacts.persona?.language ?? null;
    const publishedVersion = publishedVersionOf(agent);

    return {
        availableIntegrations, skillNamesById, enabledIntegrationCount, agentUsage, usageError, refetchUsage,
        tabs, conceptFacts, personaLanguage, publishedVersion,
    };
}
